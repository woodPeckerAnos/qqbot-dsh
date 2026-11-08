import { afterEach, describe, expect, it } from 'vitest';
import { Harness, until } from './bench/session/harness.js';
import { loadConfig } from '../src/config/index.js';
import type { TaskHandleV2, SessionContextSettings } from '@qqbot/contracts';

const active: Harness[] = [];
afterEach(async () => {
  for (const h of active.splice(0)) {
    await h.close();
    await h.remove();
  }
});
async function harness(settings: Partial<SessionContextSettings> = {}) {
  const config = loadConfig(
    { BOT_CONNECTORS: 'onebot', ONEBOT_ACCESS_TOKEN: 'offline', DEEPSEEK_API_KEY: 'offline' },
    { sessionContext: settings }
  );
  const h = await Harness.create({ config });
  active.push(h);
  return h;
}
async function running(h: Harness) {
  const a = (await h.input({ text: '核实采购数据并给出来源' }))!;
  const fast = await h.runtime(a.taskId, 'fast');
  const slow = await h.runtime(a.taskId, 'slow');
  fast.finish('正在核实');
  await h.idle();
  return { a, slow };
}
async function query(h: Harness, b: TaskHandleV2, a: TaskHandleV2, answer = '原任务仍在处理') {
  const r = await h.runtime(b.taskId, 'fast');
  expect(JSON.stringify(r.prompts)).toContain(`taskId=${a.taskId}`);
  const result = r.options.taskControl!({
    action: 'query',
    taskId: a.taskId,
    sessionId: r.prompts[0]!.sessionId,
  }) as { taskId: string; status: string; delivery?: unknown }[];
  expect(result[0]!.taskId).toBe(a.taskId);
  expect(result[0]).not.toHaveProperty('delivery');
  r.finish(answer);
  await b.done;
  return result;
}

describe('Actor/scheduler/DSH runner offline acceptance', () => {
  it('13:44 progress query actually calls the original bridge, uses zero slow resources and keeps A delivering to its original reference', async () => {
    const h = await harness();
    h.clock.time = Date.parse('2026-11-08T05:44:00Z');
    const { a, slow } = await running(h);
    const b = (await h.input({ text: '还没有核实完成吗' }))!;
    expect(h.task(b.taskId).input).toMatchObject({ followUpOf: a.taskId, progressOnly: true });
    expect(h.task(b.taskId).lanes.slow).toMatchObject({
      status: 'completed',
      result: { kind: 'silent', reason: 'no-increment' },
    });
    expect(h.system.actor.snapshot().slow).toEqual({ running: 1, queued: 0 });
    const result = await query(h, b, a);
    expect(result[0]!.status).toBe('running');
    const c = (await h.input({ text: '结果呢？' }))!;
    await query(h, c, a);
    expect(h.task(c.taskId).input.followUpOf).toBe(a.taskId);
    h.clock.advance(300000);
    expect(
      h.runtimes.filter(
        (r) =>
          [b.taskId, c.taskId].includes(r.options.env!.QQBOT_TASK_ID!) &&
          r.options.env!.QQBOT_LANE === 'slow'
      )
    ).toHaveLength(0);
    expect(h.connector.fetches).toBe(0);
    for (const id of [b.taskId, c.taskId])
      expect(
        h.system.queue
          .messages(id)
          .every(
            (m) =>
              m.candidate.lane === 'fast' &&
              !m.candidate.attachment &&
              m.candidate.kind !== 'progress'
          )
      ).toBe(true);
    slow.finish('核实结论：金额一致，来源为原始采购表');
    await a.done;
    await h.idle();
    const delivered = h.received(a.taskId).find((action) => action.lane === 'slow');
    expect(delivered?.reference?.messageId).toBe(h.task(a.taskId).input.message.msgId);
    const evidence = h.evidence.executions.find((execution) => execution.taskId === b.taskId)!;
    expect(evidence.taskQueries?.[0]?.result).toEqual(result);
    expect(evidence.childrenStarted).toBe(0);
  });
  it('includes A completed during B slow queueing; fast snapshot stays frozen and B does not ingest old media again', async () => {
    const h = await harness();
    const { a, slow } = await running(h);
    const b = (await h.input({ text: '请把刚才的结果整理成表格' }))!;
    const fast = await h.runtime(b.taskId, 'fast');
    fast.finish('好的');
    expect(h.system.actor.snapshot().slow.queued).toBe(1);
    slow.finish('排队期间完成的核实结论');
    await a.done;
    const current = await h.runtime(b.taskId, 'slow');
    expect(JSON.stringify(current.prompts)).toContain('排队期间完成的核实结论');
    expect(JSON.stringify(fast.prompts)).not.toContain('排队期间完成的核实结论');
    current.finish('整理后的表格');
    await b.done;
    await h.idle();
    expect(h.connector.fetches).toBe(0);
  });
  it('reads after runtime initialization, including results that finished after preparation', async () => {
    const h = await harness();
    const { a, slow } = await running(h);
    const gate = h.defer();
    h.runtimeSetup = (r) => {
      if (r.options.env!.QQBOT_LANE === 'slow') r.startGate = gate.promise;
    };
    const b = (await h.input({ text: '8加9等于几' }))!;
    (await h.runtime(b.taskId, 'fast')).finish('17');
    slow.finish('初始化期间可见的旧结论');
    await a.done;
    await until(() =>
      h.runtimes.some(
        (r) => r.options.env!.QQBOT_TASK_ID === b.taskId && r.options.env!.QQBOT_LANE === 'slow'
      )
    );
    const initializing = h.runtimes.find(
      (r) => r.options.env!.QQBOT_TASK_ID === b.taskId && r.options.env!.QQBOT_LANE === 'slow'
    )!;
    expect(initializing.prompts).toHaveLength(0);
    gate.resolve();
    const current = await h.runtime(b.taskId, 'slow');
    expect(JSON.stringify(current.prompts)).toContain('初始化期间可见的旧结论');
    current.finish('NO_REPLY');
    await b.done;
  });
  it('queries completed A with pending delivery without re-executing it', async () => {
    const h = await harness();
    const { a, slow } = await running(h);
    h.connector.connected = false;
    slow.finish('结果等待出口');
    await a.done;
    expect(h.system.queue.messages(a.taskId).some((m) => m.status === 'pending')).toBe(true);
    const b = (await h.input({ text: '核实完成了吗' }))!;
    const fast = await h.runtime(b.taskId, 'fast');
    const instruction = JSON.stringify(fast.prompts);
    expect(instruction).toContain('completed 仅表示执行完成');
    expect(instruction).toContain('任务执行已完成，结果送达情况尚未核实');
    expect(instruction).toContain('不能笼统说');
    expect(instruction).toContain('不推断已发送、发送失败或正在发送');
    expect((await query(h, b, a, '任务执行已完成，结果送达情况尚未核实'))[0]!.status).toBe(
      'completed'
    );
    h.connector.connected = true;
    h.system.queue.wake();
    await h.idle();
    expect(h.runtimes.filter((r) => r.options.env!.QQBOT_TASK_ID === b.taskId)).toHaveLength(1);
  });
  it('progress A completes while B fast is queued, and the eventual query sees completed state', async () => {
    const h = await harness();
    const a = (await h.input({ text: '核实原始数据' }))!;
    const originalFast = await h.runtime(a.taskId, 'fast');
    const originalSlow = await h.runtime(a.taskId, 'slow');
    const b = (await h.input({ text: '查到了吗' }))!;
    expect(h.system.actor.snapshot().fast.queued).toBe(1);
    expect(h.system.actor.snapshot().slow.queued).toBe(0);
    originalSlow.finish('原始数据已核实');
    originalFast.finish('正在核实');
    await a.done;
    expect((await query(h, b, a, '原任务已完成'))[0]!.status).toBe('completed');
  });
  it('a queued proactive result enters the View with source but cannot become a progress target', async () => {
    const h = await harness();
    const a = await h.submit({ text: '主动核实现场信息' }, true);
    const originalFast = await h.runtime(a.taskId, 'fast');
    const originalSlow = await h.runtime(a.taskId, 'slow');
    originalFast.finish('我会核实');
    await h.idle();
    const b = (await h.input({ text: '结果呢' }))!;
    expect(h.task(b.taskId).input.followUpOf).toBeUndefined();
    (await h.runtime(b.taskId, 'fast')).finish('请说明要查询哪项结果');
    originalSlow.finish('主动来源的已核实结果');
    await a.done;
    const slow = await h.runtime(b.taskId, 'slow');
    const prompt = JSON.stringify(slow.prompts);
    expect(prompt).toContain('主动来源的已核实结果');
    expect(prompt).toContain('proactive');
    slow.finish('NO_REPLY');
    await b.done;
  });
  it('silent save failure retries only settlement without runner, artifacts or another query', async () => {
    const h = await harness();
    const { a } = await running(h);
    let failing = true;
    h.stores.tasks.fail = (records) =>
      failing && records.some((t) => t.input.progressOnly && t.lanes.slow.status === 'completed');
    const b = (await h.input({ text: '完成了吗' }))!;
    const fast = await h.runtime(b.taskId, 'fast');
    fast.options.taskControl!({
      action: 'query',
      taskId: a.taskId,
      sessionId: fast.prompts[0]!.sessionId,
    });
    fast.finish('还在核实');
    await until(() => h.task(b.taskId).lanes.fast.status === 'completed');
    expect(h.task(b.taskId).lanes.slow.status).toBe('queued');
    expect(h.system.actor.snapshot().slow.queued).toBe(0);
    h.system.actor.flushSettlements();
    expect(h.task(b.taskId).lanes.slow.status).toBe('queued');
    failing = false;
    h.system.actor.flushSettlements();
    await b.done;
    h.system.actor.flushSettlements();
    expect(h.runtimes.filter((r) => r.options.env!.QQBOT_TASK_ID === b.taskId)).toHaveLength(1);
    expect(h.evidence.executions.find((e) => e.taskId === b.taskId)!.taskQueries).toHaveLength(1);
  });
  it.each(['cancel', 'reset', 'close'] as const)(
    '%s releases progress fast lane and does not start a slow runtime',
    async (action) => {
      const h = await harness();
      await running(h);
      const b = (await h.input({ text: '完成了吗' }))!;
      await h.runtime(b.taskId, 'fast');
      if (action === 'cancel') h.system.actor.cancel(b.taskId);
      if (action === 'reset') h.system.actor.reset('group-A');
      if (action === 'close') h.system.actor.close();
      expect((await b.done).status).toBe('cancelled');
      expect(
        h.runtimes.filter(
          (r) => r.options.env!.QQBOT_TASK_ID === b.taskId && r.options.env!.QQBOT_LANE === 'slow'
        )
      ).toHaveLength(0);
    }
  );
  it('fast failure preserves silent slow lane and true Task failure', async () => {
    const h = await harness();
    await running(h);
    const b = (await h.input({ text: '完成了吗' }))!;
    (await h.runtime(b.taskId, 'fast')).finish('查询失败', 'error');
    expect((await b.done).status).toBe('failed');
    expect(h.task(b.taskId).lanes.slow.result?.kind).toBe('silent');
  });
  it('verified progress keeps its generation despite an unrelated topic verdict', async () => {
    const h = await harness();
    const { a } = await running(h);
    h.topicJudge = async () => ({ related: false, mentionsChatRecord: false });
    const b = (await h.input({ text: '上个任务进度怎样？' }))!;
    expect(h.task(b.taskId).input).toMatchObject({
      generation: 1,
      followUpOf: a.taskId,
      progressOnly: true,
    });
    await query(h, b, a);
  });
  it('reset during topic judgment discards old target and creates a normal new-generation Task', async () => {
    const h = await harness();
    const { a } = await running(h);
    const gate = h.defer();
    h.topicJudge = async () => {
      await gate.promise;
      return { related: true, mentionsChatRecord: false };
    };
    const waiting = h.input({ text: '完成了吗' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    h.system.actor.reset('group-A');
    gate.resolve();
    const b = (await waiting)!;
    expect(h.task(b.taskId).input.followUpOf).toBeUndefined();
    expect(h.task(b.taskId).input.generation).toBe(2);
    await a.done;
    await h.finish(b);
  });
  it.each([{ mode: 'off' as const }, { progressGuard: false }])(
    'rollback setting %j uses ordinary dual lanes',
    async (settings) => {
      const h = await harness(settings);
      const { a, slow } = await running(h);
      const b = (await h.input({ text: '完成了吗' }))!;
      expect(h.task(b.taskId).input.progressOnly).toBeUndefined();
      expect(h.task(b.taskId).input.followUpOf).toBe(
        settings.mode === 'off' ? undefined : a.taskId
      );
      (await h.runtime(b.taskId, 'fast')).finish('处理中');
      slow.finish('原任务结论');
      await a.done;
      (await h.runtime(b.taskId, 'slow')).finish('NO_REPLY');
      await b.done;
    }
  );
  it('read failure degrades to empty View without changing execution or delivery state', async () => {
    const h = await harness();
    const { a, slow } = await running(h);
    const original = h.system.queue.messages.bind(h.system.queue);
    h.system.queue.messages = (id) => {
      if (id === a.taskId && h.task(a.taskId).status === 'completed')
        throw new Error('injected-view-read');
      return original(id);
    };
    const b = (await h.input({ text: '新问题，1加1等于几' }))!;
    (await h.runtime(b.taskId, 'fast')).finish('2');
    slow.finish('旧结果');
    await a.done;
    const current = await h.runtime(b.taskId, 'slow');
    expect(JSON.stringify(current.prompts)).not.toContain('只读背景');
    h.system.queue.messages = original;
    current.finish('NO_REPLY');
    expect((await b.done).status).toBe('completed');
  });
});
