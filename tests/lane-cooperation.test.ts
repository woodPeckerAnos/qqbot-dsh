import { afterEach, describe, expect, it, vi } from 'vitest';
import { Harness, until } from './bench/session/harness.js';
import { installLaneCooperation } from '../dsh-profile/plugins/task-control.js';
import { createTaskCooperation } from '../src/task/index.js';
import type { PluginHooks, MockCooperationMessage } from './helpers/cooperation-driver.js';

const active: Harness[] = [];
afterEach(async () => {
  for (const h of active.splice(0)) await h.close();
});
async function harness() {
  const h = await Harness.create();
  active.push(h);
  return h;
}

describe('双 lane 协作（离线 DSH、连接器与时钟）', () => {
  it('协作快照隔离只读，重复读取保持水位，关闭解除 pending 等待', async () => {
    const h = await harness();
    const t = await h.submit({ text: '只读快照' });
    const cooperation = createTaskCooperation(h.system.manager, h.system.queue);
    const snapshot = cooperation.read(t.taskId);
    expect(cooperation.read(t.taskId).revision).toBe(snapshot.revision);
    expect(Reflect.set(snapshot, 'ready', true)).toBe(false);
    const pending = cooperation.wait(t.taskId, new AbortController().signal);
    cooperation.close();
    await expect(pending).rejects.toThrow('取消');
    expect(() => cooperation.read(t.taskId)).toThrow('关闭');
  });
  it.each([false, true])(
    '结束顺序 reverse=%s：下一 step 消费快照，同 turn 一次结算',
    async (reverse) => {
      const h = await harness();
      const t = await h.submit({ text: '重复回答' });
      const fast = await h.runtime(t.taskId, 'fast'),
        slow = await h.runtime(t.taskId, 'slow');
      slow.cooperation!.responses.push('NO_REPLY');
      const end = vi.spyOn(h.system.manager, 'endExecution');
      if (reverse) slow.finish('重复回答');
      fast.finish('原始答案');
      if (!reverse) slow.finish('重复回答');
      const task = await t.done;
      await h.idle();
      expect(task.lanes.slow.result).toMatchObject({ kind: 'silent', reason: 'no-increment' });
      expect(h.received(t.taskId).map((a) => a.text)).toEqual(['原始答案']);
      expect(slow.prompts).toHaveLength(1);
      expect(
        slow.cooperation!.consumed.some((s) => s.includes('原始答案') && s.includes('"ready":true'))
      ).toBe(true);
      expect(end.mock.calls.filter(([, lane]) => lane === 'slow')).toHaveLength(1);
      expect(slow.cooperation!.inbox).toHaveLength(0);
    }
  );
  it.each(['新增：还支持负数。', '纠正先前快答：x=6、y=4。'])(
    '只交付增量或明确纠错：%s',
    async (answer) => {
      const h = await harness();
      const t = await h.submit({ text: '进一步核查' });
      const slow = await h.runtime(t.taskId, 'slow');
      slow.cooperation!.responses.push(answer);
      await h.finish(t, '初步答案', '草稿');
      expect(h.received(t.taskId).map((a) => a.text)).toEqual(['初步答案', answer]);
    }
  );
  it.each([false, true])('工具结果 isError=%s 决定执行后静默是否合法', async (isError) => {
    const h = await harness();
    const t = await h.submit({ text: '验证已有结论' });
    const slow = await h.runtime(t.taskId, 'slow');
    slow.event('tool/call', { callId: 'run', name: 'bash' });
    slow.event('tool/result', {
      message: {
        source: { kind: 'tool', callId: 'run' },
        content: [
          {
            type: 'tool-result',
            toolCallId: 'run',
            isError,
            content: [{ type: 'text', text: isError ? 'failed' : 'confirmed' }],
          },
        ],
      },
    });
    await h.finish(t, '已有结论', 'NO_REPLY');
    expect(h.task(t.taskId).lanes.slow.result?.kind).toBe(isError ? 'failed' : 'silent');
    if (!isError)
      expect(h.task(t.taskId).lanes.slow.result).toMatchObject({ reason: 'no-increment' });
  });
  it('附件仍须说明，正文精确去重不吞掉附件，重复 accept 幂等', async () => {
    const h = await harness();
    const t = await h.submit({ text: '报告' });
    await h.artifact(t, '报告内容');
    await h.finish(t, '共同正文', '共同正文');
    const task = h.task(t.taskId);
    const rows = h.system.queue.messages(t.taskId);
    expect(rows.filter((r) => r.candidate.body)).toHaveLength(1);
    expect(rows.filter((r) => r.candidate.attachment)).toHaveLength(1);
    await h.system.output.accept(task, 'slow', task.lanes.slow.result!);
    expect(h.system.queue.messages(t.taskId)).toHaveLength(rows.length);
    const silent = await h.submit({ text: '附件无说明' });
    await h.artifact(silent, '另一个文件');
    await h.finish(silent, '正在处理', 'NO_REPLY');
    expect(h.task(silent.taskId).lanes.slow.result).toMatchObject({
      kind: 'failed',
      error: 'silent-with-deliverables',
    });
    expect(h.received(silent.taskId).some((a) => a.attachments.length)).toBe(true);
  });
  it.each(['乙乙乙乙', '甲甲甲甲'])(
    '分段部分失败（第二段 %s）：按送达次数去重，失败分段由慢 lane 补答',
    async (second) => {
      const h = await harness();
      h.connector.maxChars = 4;
      let rejected = false;
      h.connector.send = async (_ctx, out) => {
        if (out.text === second && h.connector.actions.length === 2 && !rejected) {
          rejected = true;
          throw new Error('partial-failure');
        }
      };
      const t = await h.submit({ text: '分段' });
      await h.finish(t, `甲甲甲甲${second}`, `甲甲甲甲${second}`);
      const bodies = h.system.queue.messages(t.taskId).filter((r) => r.candidate.body);
      expect(bodies.map((r) => [r.candidate.lane, r.candidate.text, r.status])).toEqual([
        ['fast', '甲甲甲甲', 'sent'],
        ['fast', second, 'failed'],
        ['slow', second, 'sent'],
      ]);
      const slow = await h.runtime(t.taskId, 'slow');
      const snapshot = JSON.parse(
        slow.cooperation!.consumed.at(-1)!.split('快慢协作快照：')[1]!.split('\n')[0]!
      );
      expect(snapshot.bodies).toHaveLength(2);
      expect(snapshot.delivered.map((b: { text: string }) => b.text)).toEqual(['甲甲甲甲']);
      expect(bodies[1]!.id).not.toBe(bodies[2]!.id);
    }
  );
  it('pending 保持原执行 running，新快任务推进，出口恢复后完成衔接', async () => {
    const h = await harness();
    h.connector.connected = false;
    const t = await h.submit({ text: '旧任务' });
    const fast = await h.runtime(t.taskId, 'fast'),
      slow = await h.runtime(t.taskId, 'slow');
    fast.finish('原始答案');
    slow.finish('原始答案');
    await until(() => h.task(t.taskId).lanes.fast.status === 'completed');
    const execution = h.task(t.taskId).lanes.slow.execution;
    const next = await h.submit({ text: '新问题' });
    (await h.runtime(next.taskId, 'fast')).finish('NO_REPLY');
    await until(() => h.task(next.taskId).lanes.fast.status === 'completed');
    expect(h.task(t.taskId).lanes.slow).toMatchObject({ status: 'running', execution });
    expect(h.task(t.taskId).lanes.slow.executionEndedAt).toBeUndefined();
    expect(h.system.actor.snapshot().slow).toEqual({ running: 1, queued: 1 });
    h.connector.connected = true;
    h.system.queue.wake();
    await t.done;
    await h.idle();
    expect(h.received(t.taskId).map((a) => a.text)).toEqual(['原始答案']);
    (await h.runtime(next.taskId, 'slow')).finish('NO_REPLY');
    await next.done;
  });
  it.each(['stop', 'timeout', 'channel', 'shutdown'])(
    '等待期间 %s 解除等待并释放资源',
    async (action) => {
      const h = await harness();
      h.connector.connected = false;
      const t = await h.submit({ text: '等待出口' });
      const fast = await h.runtime(t.taskId, 'fast'),
        slow = await h.runtime(t.taskId, 'slow');
      const listenersBefore = slow.listenerCount('session.event');
      fast.finish('待发');
      slow.finish('结果');
      await until(() => h.task(t.taskId).lanes.fast.status === 'completed');
      if (action === 'stop') expect(h.system.actor.stop('group-A')).toBe(1);
      if (action === 'timeout') h.clock.advance(h.config.tasks.slowTimeoutMs);
      if (action === 'channel') slow.emit('task.channel.closed');
      if (action === 'shutdown') await h.system.close();
      await t.done;
      expect(h.task(t.taskId).status).toBe(
        action === 'stop' || action === 'shutdown' ? 'cancelled' : 'failed'
      );
      const retained = action === 'stop' || action === 'timeout';
      expect(slow.disposed).toBe(retained ? 0 : 1);
      expect(slow.listenerCount('session.event')).toBe(retained ? listenersBefore - 1 : 0);
      expect(h.system.pools.slow.health().running).toBe(0);
      expect(slow.listenerCount('task.channel.closed')).toBe(0);
      expect(slow.cooperation!.inbox).toHaveLength(0);
      expect(h.clock.pending).toBe(0);
      expect(h.system.pools.slow.size).toBe(retained ? 1 : 0);
      expect(
        h.system.queue
          .messages(t.taskId)
          .some((r) => r.candidate.lane === 'fast' && r.status === 'pending')
      ).toBe(true);
    }
  );
  it('快发送超时后慢答案保留；迟到成功不改变快正文送达状态', async () => {
    const h = await harness();
    const gate = h.defer();
    h.connector.send = async (_ctx, out) => {
      if (out.text === '答案' && h.connector.actions.length === 1) await gate.promise;
    };
    const t = await h.submit({ text: '超时投递' });
    (await h.runtime(t.taskId, 'fast')).finish('答案');
    const slow = await h.runtime(t.taskId, 'slow');
    slow.finish('答案');
    await until(() => h.system.queue.snapshot().sending === 1);
    h.clock.advance(120000);
    await t.done;
    await h.idle();
    expect(
      h.system.queue
        .messages(t.taskId)
        .filter((r) => r.candidate.body)
        .map((r) => r.status)
    ).toEqual(['failed', 'sent']);
    gate.resolve();
    await h.idle();
    expect(
      h.system.queue
        .messages(t.taskId)
        .filter((r) => r.candidate.body)
        .map((r) => r.status)
    ).toEqual(['failed', 'sent']);
  });
});

it('插件拒绝错 Task/execution/generation/session 及子代理更新，已消费水位不重复注入', async () => {
  const hooks: Partial<PluginHooks> = {};
  const binding = {
    taskId: 'task',
    executionId: 'exec',
    runtimeGeneration: 'gen',
    sessionId: 'root',
  };
  const snapshot = {
    taskId: 'task',
    revision: 2,
    ready: true,
    fastStatus: 'completed',
    bodies: [],
    delivered: [],
  };
  const injected: MockCooperationMessage[] = [];
  const root = {
    session: { id: 'root' },
    inject: (message: MockCooperationMessage) => injected.push(message),
  };
  const child = { session: { id: 'child' }, inject: vi.fn() };
  const plugin = installLaneCooperation(
    {
      on: <K extends keyof PluginHooks>(event: K, fn: PluginHooks[K]) => {
        hooks[event] = fn;
      },
    },
    async () => snapshot,
    binding
  );
  hooks['agent/created']!({ agent: child });
  for (const key of Object.keys(binding))
    plugin.receive({ binding: { ...binding, [key]: 'other' }, snapshot });
  expect(injected).toEqual([]);
  hooks['agent/created']!({ agent: root });
  hooks['session/event']!(root.session, {
    type: 'user/message',
    data: { id: 'current-prompt', source: { kind: 'user' } },
  });
  await Promise.resolve();
  expect(injected).toHaveLength(1);
  hooks['session/event']!(root.session, { type: 'user/message', data: injected[0]! });
  const signal = new AbortController().signal;
  await hooks['agent/turn-stopping']!({ agent: root, signal, turn: 1 });
  await hooks['agent/turn-stopping']!({ agent: root, signal, turn: 1 });
  expect(injected).toHaveLength(1);
  expect(child.inject).not.toHaveBeenCalled();
  plugin.close();
});
