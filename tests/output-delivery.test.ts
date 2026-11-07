import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { OutgoingAttachment, QueuedMessage, TaskSnapshotV2 } from '@qqbot/contracts';
import { createTaskCooperation } from '../src/task/index.js';
import { createMessageQueue } from '../src/delivery/index.js';
import { createNullLogger } from '../src/observability/index.js';
import { loadConfig } from '../src/config/index.js';
import { Harness, until } from './bench/session/harness.js';
import { OnebotProbe, digest } from './bench/session/onebot-probe.js';
import { outputCases } from './bench/session/output-cases.js';
import { runCase } from './bench/session/runner.js';

const active: { h: Harness; probe: OnebotProbe }[] = [];
afterEach(async () => {
  for (const { h, probe } of active.splice(0)) {
    await probe.stop();
    await h.close();
    await h.remove();
  }
});
async function harness(
  options: ConstructorParameters<typeof OnebotProbe>[1] = {},
  maxFileBytes?: number
) {
  const config = maxFileBytes
    ? loadConfig({
        BOT_CONNECTORS: 'onebot',
        ONEBOT_ACCESS_TOKEN: 'offline',
        DEEPSEEK_API_KEY: 'offline',
      })
    : undefined;
  if (config && maxFileBytes) config.media.maxFileBytes = maxFileBytes;
  const h = await Harness.create({ config });
  h.connector.recordCapable = true;
  const probe = new OnebotProbe(h.connector, options);
  active.push({ h, probe });
  await probe.start();
  return { h, probe };
}
const long = '中文👩‍💻\n```ts\nconst answer = 42;\n```\n'.repeat(100);

describe('输出交付 benchmark', () => {
  it.each(outputCases)('$id $title', async (c) => {
    const record = await runCase(c, {
      mode: 'offline',
      cases: [c.id],
      seed: 42,
      full: false,
      strict: true,
      output: 'tmp/output-test',
    });
    expect(record.assertions.filter((a) => a.status !== 'pass')).toEqual([]);
    expect(record.outputDelivery?.externalMessages).toBe(record.outputDelivery?.targetMessages);
    expect(Object.values(record.resources).every((n) => n === 0)).toBe(true);
  });
});

describe('记录、队列与正文所有权', () => {
  it('交付组落盘失败无半组，同一ID恢复入队只发送一次', async () => {
    const { h, probe } = await harness();
    const t = await h.submit({ text: '原子交付' });
    await h.finish(t, 'NO_REPLY', 'NO_REPLY');
    const attachments: OutgoingAttachment[] = [];
    for (const name of ['a.txt', 'b.txt']) {
      const absPath = join(h.root, name);
      await writeFile(absPath, name);
      attachments.push({ kind: 'file', absPath, fileName: name, sizeBytes: name.length });
    }
    const result = { kind: 'reply' as const, text: long, attachments };
    h.stores.messages.fail = (rows) => rows.some((r) => r.candidate.delivery?.index === 2);
    await expect(
      h.system.output.accept(h.task(t.taskId), 'slow', result, 'atomic')
    ).rejects.toThrow('persistence');
    expect(h.system.queue.messages(t.taskId)).toHaveLength(0);
    expect(h.stores.messages.load()).toHaveLength(0);
    expect(probe.actions).toHaveLength(0);
    h.stores.messages.fail = () => false;
    await h.system.output.accept(h.task(t.taskId), 'slow', result, 'atomic');
    await h.idle();
    await h.system.output.accept(h.task(t.taskId), 'slow', result, 'atomic');
    expect(probe.actions.map((a) => a.action)).toEqual([
      'send_group_msg',
      'send_group_forward_msg',
      'upload_group_file',
    ]);
  });
  it('长文单普通文件保留原文件，正文仅一条记录，交付组按序送达', async () => {
    const { h, probe } = await harness();
    const t = await h.submit({ text: '原请求', sender: '10001' });
    await h.artifact(t, 'single-file', '答复.txt');
    await h.finish(t, 'NO_REPLY', long);
    expect(probe.actions.map((a) => a.action)).toEqual([
      'send_group_msg',
      'send_group_forward_msg',
      'upload_group_file',
    ]);
    expect(probe.actions.at(-1)?.nodes[0]?.[0]?.sha256).toBe(digest('single-file'));
    expect(probe.actions.at(-1)?.zipEntries).toBeUndefined();
  });
  it('记录上传阻塞时新 Task 快正文推进，ZIP 等记录终结后尝试', async () => {
    const { h, probe } = await harness();
    const gate = h.defer();
    probe.block = async (action) => {
      if (action.includes('forward')) await gate.promise;
    };
    const t = await h.submit({ text: '旧请求' });
    await h.artifact(t, 'A', 'a.txt');
    await h.artifact(t, 'B', 'b.txt');
    (await h.runtime(t.taskId, 'fast')).finish('NO_REPLY');
    (await h.runtime(t.taskId, 'slow')).finish(long);
    await t.done;
    await until(() => probe.actions.some((a) => a.action.includes('forward')));
    expect(probe.actions.some((a) => a.action.includes('upload'))).toBe(false);
    const next = await h.submit({ text: '新短问' });
    (await h.runtime(next.taskId, 'fast')).finish('新快答');
    await until(() => h.received(next.taskId).some((a) => a.text === '新快答'));
    expect(h.system.queue.messages(t.taskId).find((r) => r.candidate.record)?.status).toBe(
      'sending'
    );
    gate.resolve();
    await h.idle();
    expect(probe.actions.at(-1)?.action).toBe('upload_group_file');
    (await h.runtime(next.taskId, 'slow')).finish('NO_REPLY');
    await next.done;
  });
  it('成功记录展开原分段用于协作、历史和去重，短提示不参与正文', async () => {
    const { h } = await harness();
    const cooperation = createTaskCooperation(h.system.manager, h.system.queue);
    try {
      const t = await h.submit({ text: '同一结果' });
      const fast = await h.runtime(t.taskId, 'fast'),
        slow = await h.runtime(t.taskId, 'slow');
      fast.finish(long);
      await until(() => cooperation.read(t.taskId).ready);
      const snapshot = cooperation.read(t.taskId);
      expect(snapshot.delivered.map((p) => p.text).join('')).toBe(long.trim());
      expect(snapshot.delivered.length).toBeGreaterThan(1);
      expect(snapshot.delivered.every((p) => !p.text.includes('结果已整理'))).toBe(true);
      expect(h.preparer.capture(h.message({ text: '后续' })).replay).toContain('const answer = 42');
      slow.finish(long);
      await t.done;
      await h.idle();
      const bodies = h.system.queue.messages(t.taskId).filter((r) => r.candidate.body);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.candidate.text).toBe(long.trim());
      expect(bodies[0]?.candidate.body?.segments?.map((s) => s.text).join('')).toBe(long.trim());
    } finally {
      cooperation.close();
    }
  });
  it('失败记录不吞掉慢正文，每组只生成一条通知', async () => {
    const { h, probe } = await harness();
    let failed = false;
    probe.block = async (action) => {
      if (action.includes('forward') && !failed) {
        failed = true;
        throw new Error('injected');
      }
    };
    const t = await h.submit({ text: '重述未送达结果' });
    await h.finish(t, long, long);
    const rows = h.system.queue.messages(t.taskId);
    expect(rows.filter((r) => r.candidate.body).map((r) => r.status)).toEqual(['failed', 'sent']);
    expect(rows.filter((r) => r.candidate.notification)).toHaveLength(1);
    expect(rows.filter((r) => r.candidate.record)).toHaveLength(2);
    const result = h.task(t.taskId).lanes.slow.result!;
    await h.system.output.accept(h.task(t.taskId), 'slow', result);
    expect(h.system.queue.messages(t.taskId)).toHaveLength(rows.length);
  });
  it('同组记录与ZIP均失败时只通知一次，通知失败不递归', async () => {
    const { h, probe } = await harness();
    let tipSent = false;
    probe.block = async (action) => {
      if (!tipSent && action === 'send_group_msg') {
        tipSent = true;
        return;
      }
      throw new Error('injected-failure');
    };
    const t = await h.submit({ text: '失败组' });
    await h.artifact(t, 'A', 'a.txt');
    await h.artifact(t, 'B', 'b.txt');
    await h.finish(t, 'NO_REPLY', long);
    const rows = h.system.queue.messages(t.taskId);
    expect(rows.filter((r) => r.candidate.notification)).toHaveLength(1);
    expect(
      rows.filter((r) => r.candidate.record || r.candidate.attachment).map((r) => r.status)
    ).toEqual(['failed', 'failed']);
    expect(rows.find((r) => r.candidate.notification)?.candidate).toMatchObject({
      record: undefined,
      attachment: undefined,
      body: undefined,
      delivery: undefined,
    });
    expect(h.task(t.taskId).status).toBe('completed');
    h.system.queue.wake();
    await h.idle();
    expect(probe.actions).toHaveLength(4);
  });
  it('ZIP同名条目确定性改名，两个独立源文件完整保留', async () => {
    const { h, probe } = await harness();
    const t = await h.submit({ text: '同名文件' });
    await h.finish(t, 'NO_REPLY', 'NO_REPLY');
    const files: OutgoingAttachment[] = [];
    for (const [index, value] of ['first', 'second'].entries()) {
      const absPath = join(h.root, `source-${index}.txt`);
      await writeFile(absPath, value);
      files.push({ kind: 'file', fileName: '同名.txt', sizeBytes: value.length, absPath });
    }
    await h.system.output.accept(
      h.task(t.taskId),
      'slow',
      { kind: 'reply', text: '', attachments: files },
      'same-names'
    );
    await h.idle();
    expect(probe.actions.at(-1)?.zipEntries?.map((e) => [e.name, e.sha256])).toEqual([
      ['同名.txt', digest('first')],
      ['同名-1.txt', digest('second')],
    ]);
  });
  it.each([0, -1])('完整序列化帧边界 offset=%s，按字节而非字符判断', async (offset) => {
    const first = await harness();
    const out = {
      text: '',
      record: { nodes: [{ type: 'text' as const, text: '中文🙂'.repeat(50) }] },
    };
    const ctx = {
      target: first.h.message({ text: '输入' }).target,
      seq: 0,
      kind: 'final' as const,
    };
    await first.probe.reply(ctx, out);
    const bytes = first.probe.actions[0]!.payloadBytes;
    const bounded = await harness({ maxPayloadBytes: bytes + offset });
    if (offset === 0) {
      await bounded.probe.reply(ctx, out);
      expect(bounded.probe.actions[0]?.payloadBytes).toBe(bytes);
    } else {
      await expect(bounded.probe.reply(ctx, out)).rejects.toThrow('序列化载荷超过');
      expect(bounded.probe.actions).toHaveLength(0);
    }
  });
  it.each(['record', 'zip'] as const)('Task 清理后 %s 独立副本仍能实际发送', async (kind) => {
    const { h, probe } = await harness({ fileTransport: 'path' });
    h.connector.connected = false;
    const t = await h.submit({ text: '待发附件' });
    const names = kind === 'record' ? ['a.png', 'b.mp4'] : ['a.txt', 'b.csv'];
    for (const name of names) await h.artifact(t, `content:${name}`, name);
    await h.finish(t, 'NO_REPLY', '附件结果');
    const task = h.task(t.taskId);
    const workspace = h.preparer.workspace(task);
    h.system.manager.destroy(t.taskId);
    h.system.output.forget(t.taskId);
    await h.preparer.removeWorkspace(task);
    await expect(access(workspace)).rejects.toThrow();
    h.connector.connected = true;
    h.system.queue.wake();
    await h.idle();
    const hashes =
      kind === 'record'
        ? probe.actions.flatMap((a) => a.nodes.flat())
        : probe.actions.flatMap((a) => a.zipEntries ?? []);
    expect(names.every((name) => hashes.some((n) => n.sha256 === digest(`content:${name}`)))).toBe(
      true
    );
  });
  it('缺失消息ID使用摘录，原引用与新的发送锚点分离', async () => {
    const { h, probe } = await harness();
    const t = await h.submit({ text: '原问题', sender: '10001' });
    await h.finish(t, 'NO_REPLY', 'NO_REPLY');
    const task = structuredClone(h.task(t.taskId)) as TaskSnapshotV2;
    task.input.reference.messageId = undefined;
    task.input.message.msgId = '';
    await h.system.output.accept(task, 'slow', { kind: 'reply', text: long }, 'missing-id');
    await h.idle();
    const tip = probe.actions[0]?.nodes.flat();
    expect(tip?.some((n) => n.text?.includes('原问题'))).toBe(true);
    expect(tip?.some((n) => n.type === 'reply')).toBe(false);
    const message = h.message({ text: '新出口' }, 'new-anchor');
    h.connector.official = true;
    h.clock.advance(300001);
    message.ts = h.clock.now();
    h.system.queue.observe(message);
    await h.system.output.accept(
      h.task(t.taskId),
      'slow',
      { kind: 'reply', text: long },
      'old-reference'
    );
    await h.idle();
    const row = h.system.queue
      .messages(t.taskId)
      .find((r) => r.id.includes('old-reference') && r.candidate.body);
    expect(row?.anchor?.msgId).toBe('new-anchor');
    expect(row?.candidate.reference?.messageId).toBe(
      task.input.reference.messageId ?? h.task(t.taskId).input.reference.messageId
    );
  });
  it('记录超时后迟到响应不重新结算；两次恢复不重发且通知不重复', async () => {
    const { h, probe } = await harness();
    const gate = h.defer();
    probe.block = async (action) => {
      if (action.includes('forward')) await gate.promise;
    };
    const t = await h.submit({ text: '超时记录' });
    (await h.runtime(t.taskId, 'fast')).finish('NO_REPLY');
    (await h.runtime(t.taskId, 'slow')).finish(long);
    await t.done;
    await until(() => probe.actions.some((a) => a.action.includes('forward')));
    const crash = structuredClone(h.system.queue.messages()) as QueuedMessage[];
    h.clock.advance(120000);
    await h.idle();
    expect(h.system.queue.messages().find((r) => r.candidate.record)).toMatchObject({
      status: 'failed',
      outcome: 'unknown',
    });
    gate.resolve();
    await h.idle();
    expect(h.system.queue.messages().find((r) => r.candidate.record)?.status).toBe('failed');
    let saved = crash;
    for (let i = 0; i < 2; i++) {
      const queue = createMessageQueue({
        connectors: new Map([['onebot', h.connector]]),
        logger: createNullLogger(),
        clock: h.clock,
        store: {
          domain: 'messages',
          load: () => saved,
          save: (rows) => {
            saved = structuredClone(rows) as QueuedMessage[];
          },
        },
      });
      queue.wake();
      await until(() => queue.snapshot().pending === 0 && queue.snapshot().sending === 0);
      expect(queue.messages().filter((r) => r.candidate.notification)).toHaveLength(1);
      queue.close();
    }
    expect(probe.actions.filter((a) => a.action.includes('forward'))).toHaveLength(1);
  });
  it('序列化大小计入中文UTF-8和base64；超限拒绝记录且通知一次', async () => {
    const { h, probe } = await harness({ maxPayloadBytes: 1200 });
    const t = await h.submit({ text: '载荷上限' });
    await h.artifact(t, 'x'.repeat(600), 'a.png');
    await h.artifact(t, 'y'.repeat(600), 'b.png');
    await h.finish(t, 'NO_REPLY', '中文'.repeat(200));
    const rows = h.system.queue.messages(t.taskId);
    expect(rows.find((r) => r.candidate.record)).toMatchObject({ status: 'failed' });
    expect(rows.find((r) => r.candidate.record)?.error).toContain('序列化载荷超过');
    expect(rows.filter((r) => r.candidate.notification)).toHaveLength(1);
    expect(probe.actions.some((a) => a.action.includes('forward'))).toBe(false);
    expect(rows.find((r) => r.candidate.record)?.candidate.record?.nodes).toHaveLength(3);
  });
  it('单文件和ZIP越界不删减、不截断，由队列结算准备错误', async () => {
    const { h, probe } = await harness({}, 90);
    const t = await h.submit({ text: '超限ZIP' });
    await h.artifact(t, 'A'.repeat(60), 'a.txt');
    await h.artifact(t, 'B'.repeat(60), 'b.txt');
    await h.finish(t, 'NO_REPLY', '文件说明');
    expect(
      h.system.queue.messages(t.taskId).find((r) => r.candidate.preparationError)?.error
    ).toContain('ZIP 超过 maxFileBytes');
    expect(probe.actions.some((a) => a.action.includes('upload'))).toBe(false);
    const path = join(h.root, 'large.txt');
    await writeFile(path, 'C'.repeat(h.config.media.maxFileBytes + 1));
    const file: OutgoingAttachment = {
      kind: 'file',
      absPath: path,
      fileName: 'large.txt',
      sizeBytes: 1,
    };
    await h.system.output.accept(
      h.task(t.taskId),
      'slow',
      { kind: 'reply', text: '结果', attachments: [file] },
      'single-limit'
    );
    await h.idle();
    expect(
      h.system.queue
        .messages(t.taskId)
        .find((r) => r.id.includes('single-limit') && r.candidate.preparationError)?.error
    ).toContain('超过 maxFileBytes');
    expect((await readFile(path)).length).toBe(h.config.media.maxFileBytes + 1);
  });
});
