/**
 * Responder 富媒体出站测试：附件与文本的配额分配、发送顺序、降级文案、归档。
 *
 * 规则定稿（docs/RICH-MEDIA-PLAN.md §5）：
 *   1. 平时文本保底 1 条：附件预算 = 剩余额度 - 1；
 *   2. 只剩 1 条额度时反转：附件优先；
 *   3. 发送顺序附件先、文本后；
 *   4. 超预算/超体积的附件降级为文本说明，不静默丢弃。
 */

import { mkdtemp, mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  NormalizedMessage,
  OutgoingMessage,
  ReplyContext,
  ReplyPolicy,
} from '../src/core/connector.js';
import { createNullLogger } from '../src/logger.js';
import { Responder } from '../src/pipeline/egress/responder.js';
import { SENT_DIR_NAME } from '../src/pipeline/egress/outbox.js';
import { PipelineStats } from '../src/pipeline/stats.js';
import { ConversationStore } from '../src/store/conversations.js';
import { resolveStorePaths } from '../src/store/paths.js';

const POLICY: ReplyPolicy = {
  maxChars: 1500,
  maxRepliesPerMsg: 4,
  progressMax: 3,
  progressAfterMs: 90_000,
  progressIntervalMs: 90_000,
  turnTimeoutMs: 240_000,
  passiveWindowMs: 300_000,
};

interface SentCall {
  ctx: ReplyContext;
  out: OutgoingMessage;
}

function makeMessage(): NormalizedMessage {
  return {
    kind: 'group-at-message',
    target: { platform: 'test', kind: 'group', id: 'g1', key: 'test:g1' },
    eventId: 'e1',
    msgId: 'm1',
    senderId: 'u1',
    content: '做个图',
    ts: 1,
    raw: {},
  };
}

let dirs: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(fileNames: Record<string, string>, policy: ReplyPolicy = POLICY) {
  const root = await mkdtemp(join(tmpdir(), 'qqbot-responder-test-'));
  dirs.push(root);
  const outboxDir = join(root, 'outbox');
  await mkdir(outboxDir, { recursive: true });
  const paths = resolveStorePaths({ workspacesRoot: join(root, 'ws'), stateDir: join(root, 'state') });
  await mkdir(paths.conversationsDir, { recursive: true });
  const conversations = new ConversationStore(paths, createNullLogger());
  const stats = new PipelineStats();
  const sent: SentCall[] = [];
  /** 发送时抓取的附件字节（zip 在 deliver 结束后会被删除，必须在发送时抓） */
  const attachmentBytes = new Map<string, Buffer>();
  const connector = {
    platform: 'test',
    acceptsC2C: true,
    start: async () => {},
    stop: async () => {},
    on: () => () => {},
    health: () => ({ connected: true, state: 'ok' }),
    policy: () => policy,
    reply: async (ctx: ReplyContext, out: OutgoingMessage) => {
      sent.push({ ctx, out });
      for (const attachment of out.attachments ?? []) {
        attachmentBytes.set(attachment.fileName, await readFile(attachment.absPath));
      }
    },
  };
  const responder = new Responder({
    message: makeMessage(),
    connector,
    policy,
    conversations,
    stats,
    logger: createNullLogger(),
    media: {
      outboxDir,
      maxFileBytes: 1024 * 1024,
      maxAttachments: 4,
      imageExtensions: ['png'],
    },
  });
  // 文件必须在 Responder 构造**之后**写入：outbox 只发"本轮新产生"的文件
  // （mtime 不早于消息进入管线的时间），先写文件再建 Responder 会被当旧文件跳过。
  for (const [name, content] of Object.entries(fileNames)) {
    await writeFile(join(outboxDir, name), content);
  }
  return { responder, sent, stats, outboxDir, conversations, attachmentBytes };
}

describe('Responder 富媒体出站', () => {
  it('多个产物打包成一个 zip 发一条消息（附件先、文本后）', async () => {
    const { responder, sent, attachmentBytes } = await setup({
      'a.png': 'png-a',
      'b.png': 'png-b',
      'c.html': '<html/>',
    });
    await responder.deliver({ kind: 'completed', text: '图做好了', reason: 'completed' });

    // 一条 zip 附件 + 一条文本，不再逐文件刷屏
    expect(sent).toHaveLength(2);
    const zipName = sent[0]!.out.attachments?.[0]?.fileName ?? '';
    expect(zipName).toMatch(/^产物打包-.*\.zip$/);
    expect(sent[0]!.out.attachments?.[0]?.kind).toBe('file');
    expect(sent[1]!.out.text).toContain('图做好了');
    expect(sent[1]!.out.text).toContain('3 个产物已打包');
    expect(sent.map((s) => s.ctx.seq)).toEqual([1, 2]);

    // zip 内容：stored 条目，文件名与内容都可直接验证
    const zip = attachmentBytes.get(zipName);
    expect(zip).toBeDefined();
    expect(zip!.subarray(0, 2).toString()).toBe('PK');
    for (const name of ['a.png', 'b.png', 'c.html']) {
      expect(zip!.includes(Buffer.from(name, 'utf8'))).toBe(true);
    }
    expect(zip!.includes(Buffer.from('png-a'))).toBe(true);
    expect(zip!.includes(Buffer.from('<html/>'))).toBe(true);
  });

  it('只剩 1 条额度时反转：附件优先，文本让位', async () => {
    const { responder, sent } = await setup({ 'a.png': 'png' });
    // 先消耗 3 条额度（模拟进度回执已用掉）
    await responder.error('进度1');
    await responder.error('进度2');
    await responder.error('进度3');
    sent.length = 0;

    await responder.deliver({ kind: 'completed', text: '解释文字', reason: 'completed' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.out.attachments?.[0]?.fileName).toBe('a.png');
  });

  it('超预算的附件降级为文本说明，不静默丢弃', async () => {
    const { responder, sent } = await setup({
      'a.png': 'p',
      'b.png': 'p',
      'c.png': 'p',
      'd.png': 'p',
      'e.png': 'p',
    });
    await responder.deliver({ kind: 'completed', text: '做好了', reason: 'completed' });

    // 预算内 3 个文件打包成一条 zip，超预算的 2 个降级为文本说明
    const attachmentCalls = sent.filter((s) => (s.out.attachments?.length ?? 0) > 0);
    expect(attachmentCalls).toHaveLength(1);
    expect(attachmentCalls[0]!.out.attachments?.[0]?.fileName).toMatch(/\.zip$/);
    const textCall = sent.find((s) => s.out.text !== '');
    expect(textCall?.out.text).toContain('还有 2 个文件未发出');
    expect(textCall?.out.text).toContain('d.png');
    expect(textCall?.out.text).toContain('e.png');
  });

  it('超体积文件降级为文本说明', async () => {
    const { responder, sent, outboxDir } = await setup({});
    await writeFile(join(outboxDir, 'big.png'), Buffer.alloc(2 * 1024 * 1024));
    await responder.deliver({ kind: 'completed', text: '做好了', reason: 'completed' });

    const textCall = sent.find((s) => s.out.text !== '');
    expect(textCall?.out.text).toContain('超过大小上限');
    expect(textCall?.out.text).toContain('big.png');
    expect(sent.every((s) => (s.out.attachments?.length ?? 0) === 0)).toBe(true);
  });

  it('旧文件（mtime 早于本轮）不发送、不打断文本', async () => {
    const { responder, sent, outboxDir } = await setup({ 'fresh.png': 'png' });
    // 上轮遗留的旧文件：mtime 回拨到一小时前（Responder 构造之前）
    const stale = join(outboxDir, 'stale.png');
    await writeFile(stale, 'old');
    const past = new Date(Date.now() - 3600_000);
    await utimes(stale, past, past);

    await responder.deliver({ kind: 'completed', text: '做好了', reason: 'completed' });

    const attachmentCalls = sent.filter((s) => (s.out.attachments?.length ?? 0) > 0);
    expect(attachmentCalls).toHaveLength(1);
    expect(attachmentCalls[0]!.out.attachments?.[0]?.fileName).toBe('fresh.png');
    // 旧文件留在原地（不发送、不归档、不提示）
    expect(sent.every((s) => !s.out.text.includes('stale.png'))).toBe(true);
  });

  it('zip 发送成功后：原件归档到 .sent，zip 派生物删除', async () => {
    const { responder, outboxDir, stats } = await setup({ 'a.png': 'p1', 'b.png': 'p2' });
    await responder.deliver({ kind: 'completed', text: '做好了', reason: 'completed' });
    expect(stats.attachmentsSent).toBe(1);

    const remaining = await readdir(outboxDir);
    expect(remaining.sort()).toEqual(['.packed', '.sent'].sort());
    const archived = await readdir(join(outboxDir, SENT_DIR_NAME));
    expect(archived).toHaveLength(2);
    expect(archived.some((n) => n.endsWith('-a.png'))).toBe(true);
    expect(archived.some((n) => n.endsWith('-b.png'))).toBe(true);
    // zip 派生物已删除
    expect(await readdir(join(outboxDir, '.packed'))).toHaveLength(0);
  });

  it('发送成功的附件归档到 .sent，下轮不再重扫', async () => {
    const { responder, outboxDir, stats } = await setup({ 'a.png': 'png' });
    await responder.deliver({ kind: 'completed', text: '做好了', reason: 'completed' });
    expect(stats.attachmentsSent).toBe(1);

    const remaining = await readdir(outboxDir);
    expect(remaining).toEqual([SENT_DIR_NAME]);
    const archived = await readdir(join(outboxDir, SENT_DIR_NAME));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/-a\.png$/);
  });

  it('没有 outbox 目录时行为与纯文本一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qqbot-responder-test-'));
    dirs.push(root);
    const paths = resolveStorePaths({ workspacesRoot: join(root, 'ws'), stateDir: join(root, 'state') });
    await mkdir(paths.conversationsDir, { recursive: true });
    const sent: SentCall[] = [];
    const responder = new Responder({
      message: makeMessage(),
      connector: {
        platform: 'test',
        acceptsC2C: true,
        start: async () => {},
        stop: async () => {},
        on: () => () => {},
        health: () => ({ connected: true, state: 'ok' }),
        policy: () => POLICY,
        reply: async (ctx: ReplyContext, out: OutgoingMessage) => {
          sent.push({ ctx, out });
        },
      },
      policy: POLICY,
      conversations: new ConversationStore(paths, createNullLogger()),
      stats: new PipelineStats(),
      logger: createNullLogger(),
      media: {
        outboxDir: join(root, 'outbox'), // 不存在
        maxFileBytes: 1024,
        maxAttachments: 4,
        imageExtensions: ['png'],
      },
    });
    await responder.deliver({ kind: 'completed', text: '纯文本回答', reason: 'completed' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.out.text).toBe('纯文本回答');
  });

  it('对话记录里留下已发送文件的名字（供冷启动回放）', async () => {
    const { responder, conversations } = await setup({ 'a.png': 'png' });
    await responder.deliver({ kind: 'completed', text: '图做好了', reason: 'completed' });
    const history = conversations.readTail('test:g1', 10);
    const assistant = history.find((t) => t.role === 'assistant');
    expect(assistant?.text).toContain('已发送文件：a.png');
  });
});
