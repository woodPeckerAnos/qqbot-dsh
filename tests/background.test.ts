/**
 * BackgroundPusher 单测（全离线，假连接器）。
 *
 * 覆盖后台结果投递的四条路径：
 *   A. OneBot 无窗口 → 完成即主动推送；
 *   B. 官方在被动窗口内且配额未尽 → 用最后 msg_id 续 seq 即时投递；
 *      超窗 / 配额耗尽 → 回落暂存，等下一条消息带出；
 *   C. 暂存持久化 → 重启后（新实例）仍能带出；
 *   D. snapshot 暴露待带出的会话数与条数。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BotConnector,
  ConversationTarget,
  OutgoingMessage,
  ReplyContext,
  ReplyPolicy,
} from '../src/core/connector.js';
import { createNullLogger } from '../src/logger.js';
import { BackgroundPusher } from '../src/pipeline/egress/background.js';
import { PipelineStats } from '../src/pipeline/stats.js';
import { ConversationStore } from '../src/store/conversations.js';
import { ensureStoreDirs, resolveStorePaths } from '../src/store/paths.js';

interface SentRecord extends ReplyContext {
  text: string;
}

function policy(overrides: Partial<ReplyPolicy> = {}): ReplyPolicy {
  return {
    maxChars: 1500,
    maxRepliesPerMsg: 5,
    progressMax: 3,
    progressAfterMs: 90_000,
    progressIntervalMs: 90_000,
    turnTimeoutMs: 240_000,
    passiveWindowMs: 300_000,
    ...overrides,
  };
}

function fakeConnector(
  platform: string,
  pol: ReplyPolicy,
  sent: SentRecord[],
  opts: { fail?: boolean } = {},
): BotConnector {
  return {
    platform,
    acceptsC2C: true,
    start: async () => {},
    stop: async () => {},
    on: () => () => {},
    health: () => ({ connected: true, state: 'ready' }),
    policy: () => pol,
    reply: async (ctx: ReplyContext, out: OutgoingMessage) => {
      if (opts.fail) throw new Error('平台拒绝发送');
      sent.push({ ...ctx, text: out.text });
    },
  };
}

const groupTarget = (platform: string): ConversationTarget => ({
  platform,
  kind: 'group',
  id: 'G-OPENID',
  key: platform === 'onebot' ? 'ob11:g123' : 'G-OPENID',
});

/** 让 fire-and-forget 的异步发送落定。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

let root: string;
let conversations: ConversationStore;

function setupStore(): void {
  root = mkdtempSync(join(tmpdir(), 'qqbot-bg-'));
  const paths = resolveStorePaths({ workspacesRoot: join(root, 'ws'), stateDir: join(root, 'bot') });
  ensureStoreDirs(paths);
  conversations = new ConversationStore(paths, createNullLogger());
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('BackgroundPusher A：OneBot 完成即主动推送', () => {
  it('无窗口限制，捕获后立即推送并记录对话', async () => {
    setupStore();
    const sent: SentRecord[] = [];
    const stats = new PipelineStats();
    const connector = fakeConnector('onebot', policy({ passiveWindowMs: Number.POSITIVE_INFINITY, maxRepliesPerMsg: 10 }), sent);
    const pusher = new BackgroundPusher({
      connectors: new Map([['onebot', connector]]),
      conversations,
      stats,
      logger: createNullLogger(),
    });
    const target = groupTarget('onebot');
    // msgTs 很久以前也无所谓：OneBot 窗口是 +∞
    pusher.noteAnchor({ target, msgId: '', msgTs: 1_700_000_000_000, usedSeq: 0 });

    pusher.capture(target.key, '后台压缩完成，共 42 个文件');
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe('后台压缩完成，共 42 个文件');
    expect(sent[0]!.target.key).toBe(target.key);
    expect(stats.backgroundPushed).toBe(1);
    // 主动推送的内容进了对话记录（供冷启动回放）
    expect(conversations.readAll(target.key).some((t) => t.text.includes('42 个文件'))).toBe(true);
    // 推送成功就不该再暂存
    expect(pusher.takePending(target.key)).toEqual([]);
  });
});

describe('BackgroundPusher B：官方窗口内即时投递 / 超窗暂存', () => {
  const T0 = 1_700_000_000_000;

  it('窗口内 + 配额未尽：用最后 msg_id 续 seq 即时投递', async () => {
    setupStore();
    const sent: SentRecord[] = [];
    const stats = new PipelineStats();
    const connector = fakeConnector('qq-official', policy(), sent);
    const pusher = new BackgroundPusher({
      connectors: new Map([['qq-official', connector]]),
      conversations,
      stats,
      logger: createNullLogger(),
      now: () => T0 + 60_000, // 消息到达 1 分钟后，仍在 5 分钟窗口内
    });
    const target = groupTarget('qq-official');
    // 原轮次已用掉 2 条回复 → 下一条 seq 应为 3
    pusher.noteAnchor({ target, msgId: 'MSG-1', msgTs: T0, usedSeq: 2 });

    pusher.capture(target.key, '结果出来了');
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.msgId).toBe('MSG-1');
    expect(sent[0]!.seq).toBe(3);
    expect(stats.backgroundPushed).toBe(1);
  });

  it('超出被动窗口：不推送，转暂存待下次带出', async () => {
    setupStore();
    const sent: SentRecord[] = [];
    const stats = new PipelineStats();
    const connector = fakeConnector('qq-official', policy(), sent);
    const pusher = new BackgroundPusher({
      connectors: new Map([['qq-official', connector]]),
      conversations,
      stats,
      logger: createNullLogger(),
      now: () => T0 + 400_000, // 400s > 300s 窗口
    });
    const target = groupTarget('qq-official');
    pusher.noteAnchor({ target, msgId: 'MSG-1', msgTs: T0, usedSeq: 1 });

    pusher.capture(target.key, '迟到的结果');
    await flush();

    expect(sent).toHaveLength(0);
    expect(stats.backgroundPushed).toBe(0);
    expect(pusher.takePending(target.key)).toEqual(['迟到的结果']);
  });

  it('窗口内但回复配额已用尽：转暂存', async () => {
    setupStore();
    const sent: SentRecord[] = [];
    const connector = fakeConnector('qq-official', policy({ maxRepliesPerMsg: 4 }), sent);
    const pusher = new BackgroundPusher({
      connectors: new Map([['qq-official', connector]]),
      conversations,
      stats: new PipelineStats(),
      logger: createNullLogger(),
      now: () => T0 + 10_000,
    });
    const target = groupTarget('qq-official');
    pusher.noteAnchor({ target, msgId: 'MSG-1', msgTs: T0, usedSeq: 4 }); // 已用满 4

    pusher.capture(target.key, '没配额了');
    await flush();

    expect(sent).toHaveLength(0);
    expect(pusher.takePending(target.key)).toEqual(['没配额了']);
  });

  it('没有锚点（该会话还没来过消息）：转暂存', () => {
    setupStore();
    const sent: SentRecord[] = [];
    const connector = fakeConnector('qq-official', policy(), sent);
    const pusher = new BackgroundPusher({
      connectors: new Map([['qq-official', connector]]),
      conversations,
      stats: new PipelineStats(),
      logger: createNullLogger(),
    });
    pusher.capture('G-OPENID', '无锚点结果');
    expect(pusher.takePending('G-OPENID')).toEqual(['无锚点结果']);
  });

  it('发送失败：回落暂存，不丢结果', async () => {
    setupStore();
    const sent: SentRecord[] = [];
    const connector = fakeConnector('qq-official', policy(), sent, { fail: true });
    const pusher = new BackgroundPusher({
      connectors: new Map([['qq-official', connector]]),
      conversations,
      stats: new PipelineStats(),
      logger: createNullLogger(),
      now: () => T0 + 10_000,
    });
    const target = groupTarget('qq-official');
    pusher.noteAnchor({ target, msgId: 'MSG-1', msgTs: T0, usedSeq: 0 });

    pusher.capture(target.key, '会失败的结果');
    await flush();

    expect(sent).toHaveLength(0);
    expect(pusher.takePending(target.key)).toEqual(['会失败的结果']);
  });

  it('长文本按剩余配额分段，seq 连续递增', async () => {
    setupStore();
    const sent: SentRecord[] = [];
    const connector = fakeConnector('qq-official', policy({ maxChars: 10, maxRepliesPerMsg: 5 }), sent);
    const pusher = new BackgroundPusher({
      connectors: new Map([['qq-official', connector]]),
      conversations,
      stats: new PipelineStats(),
      logger: createNullLogger(),
      now: () => T0 + 10_000,
    });
    const target = groupTarget('qq-official');
    pusher.noteAnchor({ target, msgId: 'MSG-1', msgTs: T0, usedSeq: 1 });

    pusher.capture(target.key, 'AAAAABBBBBCCCCC'); // 15 字，maxChars 10 → 多段
    await flush();

    expect(sent.length).toBeGreaterThan(1);
    const seqs = sent.map((s) => s.seq);
    expect(seqs[0]).toBe(2); // 从 usedSeq+1 续号
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length); // 不重复，避免平台去重
  });
});

describe('BackgroundPusher C：暂存持久化', () => {
  it('暂存落盘，新实例（模拟重启）能加载回来', () => {
    setupStore();
    const persistPath = join(root, 'bot', 'background-pending.json');
    const connector = fakeConnector('qq-official', policy(), []);
    const make = () =>
      new BackgroundPusher({
        connectors: new Map([['qq-official', connector]]),
        conversations,
        stats: new PipelineStats(),
        logger: createNullLogger(),
        persistPath,
      });

    const first = make();
    first.capture('G-OPENID', '重启前要保住的结果'); // 无锚点 → 同步暂存并落盘

    const second = make(); // 模拟重启：从同一文件加载
    expect(second.takePending('G-OPENID')).toEqual(['重启前要保住的结果']);
  });

  it('超过单会话上限时丢最旧的', () => {
    setupStore();
    const connector = fakeConnector('qq-official', policy(), []);
    const pusher = new BackgroundPusher({
      connectors: new Map([['qq-official', connector]]),
      conversations,
      stats: new PipelineStats(),
      logger: createNullLogger(),
      maxPendingPerConversation: 2,
    });
    pusher.capture('G-OPENID', '一');
    pusher.capture('G-OPENID', '二');
    pusher.capture('G-OPENID', '三');
    expect(pusher.takePending('G-OPENID')).toEqual(['二', '三']);
  });
});

describe('BackgroundPusher D：快照', () => {
  it('snapshot 反映待带出的会话数与总条数', () => {
    setupStore();
    const connector = fakeConnector('qq-official', policy(), []);
    const pusher = new BackgroundPusher({
      connectors: new Map([['qq-official', connector]]),
      conversations,
      stats: new PipelineStats(),
      logger: createNullLogger(),
    });
    expect(pusher.snapshot()).toEqual({ pendingConversations: 0, pendingTotal: 0 });
    pusher.capture('G-OPENID', '结果甲');
    pusher.capture('OTHER', '结果乙');
    pusher.capture('OTHER', '结果丙');
    expect(pusher.snapshot()).toEqual({ pendingConversations: 2, pendingTotal: 3 });
  });
});
