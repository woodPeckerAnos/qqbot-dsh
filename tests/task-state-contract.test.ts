import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNullLogger } from '../src/logger.js';
import type { BotConnector, NormalizedMessage, ReplyContext } from '../src/core/connector.js';
import { TaskStore } from '../src/store/tasks.js';
import { TaskLifeCycleManager } from '../src/task/lifecycle.js';
import { TaskBudget, type BudgetRecord } from '../src/task/budget.js';
import { MessageQueue, type QueuedMessage } from '../src/task/message-queue.js';
import { SessionOutputCoordinator } from '../src/task/output-coordinator.js';
import { SessionActor, type SessionContextState } from '../src/task/session-actor.js';
import { LaneScheduler } from '../src/task/lane-scheduler.js';
import type { PromptPreparer } from '../src/task/prompt-preparer.js';
import type { Lane, ReplyCandidate, TaskInput, TaskSnapshot } from '../src/task/types.js';
import { ManualClock } from './helpers/task-mocks.js';

class FaultStore<T> extends TaskStore<T> {
  records: T[] = [];
  reject: (records: readonly T[]) => boolean = () => false;
  beforeSave: (records: readonly T[]) => void = () => {};
  override load(): T[] {
    return structuredClone(this.records);
  }
  override save(records: readonly T[]): void {
    this.beforeSave(records);
    if (this.reject(records)) throw new Error('injected-write-failure');
    this.records = structuredClone([...records]);
  }
}

function input(id = 'input'): TaskInput {
  const message: NormalizedMessage = {
    kind: 'group-at-message',
    target: { platform: 'qq-official', key: 'group', id: 'group', kind: 'group' },
    eventId: `qq:${id}`,
    msgId: id,
    senderId: 'owner',
    content: '固定问题',
    ts: 100,
    raw: {},
  };
  return {
    message,
    isAdmin: false,
    source: 'user',
    generation: 1,
    reference: { messageId: id, excerpt: message.content, senderId: 'owner', ts: 100 },
    context: { window: [], replay: '' },
  };
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});

describe('Task owner 持久化契约', () => {
  it('候选值保存之前不暴露状态，创建失败不消耗序号或留下 Task', () => {
    const store = new FaultStore<TaskSnapshot>();
    const manager = new TaskLifeCycleManager({ store, now: () => 100, idFactory: () => 'fixed' });
    store.reject = () => true;
    store.beforeSave = () => {
      expect(manager.list()).toEqual([]);
    };
    expect(() => manager.create(input(), 'task')).toThrow('injected-write-failure');
    expect(manager.list()).toEqual([]);
    store.reject = () => false;
    manager.create(input(), 'task');
    expect(manager.get('task')?.creationSequence).toBe(1);
    store.beforeSave = (records) => {
      expect(records[0]!.lanes.fast.status).toBe('running');
      expect(manager.get('task')?.lanes.fast.status).toBe('queued');
    };
    manager.start('task', 'fast');
    expect(manager.get('task')?.lanes.fast.status).toBe('running');
  });

  it.each(['start', 'bind', 'end', 'finish', 'cancel'] as const)(
    '%s 保存失败保持全部状态与观察次数，再调用可以完成',
    async (operation) => {
      const store = new FaultStore<TaskSnapshot>();
      const manager = new TaskLifeCycleManager({ store, now: () => 100, idFactory: () => 'fixed' });
      const handle = manager.create(input(), 'task');
      const execution = { executionId: 'exec', runtimeGeneration: 'runtime', sessionId: 'session' };
      if (operation !== 'start') manager.start('task', 'fast', execution);
      manager.finish('task', 'slow', { kind: 'silent', reason: 'no-long-skill' });
      const before = manager.get('task');
      const changed = vi.fn();
      const done = vi.fn();
      manager.onChange(changed);
      void handle.done.then(done);
      const actions = {
        start: () => manager.start('task', 'fast', execution),
        bind: () => manager.bindExecution('task', 'fast', { ...execution, executionId: 'new' }),
        end: () => {
          manager.endExecution('task', 'fast');
        },
        finish: () => {
          manager.finish('task', 'fast', { kind: 'reply', text: '答案' });
        },
        cancel: () => manager.cancel('task'),
      };
      store.reject = () => true;
      expect(actions[operation]).toThrow('injected-write-failure');
      expect(manager.get('task')).toEqual(before);
      expect(changed).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(done).not.toHaveBeenCalled();
      store.reject = () => false;
      actions[operation]();
      expect(changed).toHaveBeenCalledTimes(1);
      manager.finish('task', 'fast', { kind: 'silent', reason: 'no-long-skill' });
      await handle.done;
      expect(done).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['destroy', 'prune'] as const)('%s 保存失败保留终态记录', (operation) => {
    const store = new FaultStore<TaskSnapshot>();
    let time = 100;
    const manager = new TaskLifeCycleManager({ store, now: () => time, retentionMs: 1 });
    manager.create(input(), 'task');
    manager.finish('task', 'fast', { kind: 'silent', reason: 'no-long-skill' });
    manager.finish('task', 'slow', { kind: 'silent', reason: 'no-long-skill' });
    time += 2;
    const before = manager.get('task');
    store.reject = () => true;
    expect(() => (operation === 'destroy' ? manager.destroy('task') : manager.prune())).toThrow(
      'injected-write-failure'
    );
    expect(manager.get('task')).toEqual(before);
    store.reject = () => false;
    if (operation === 'destroy') manager.destroy('task');
    else manager.prune();
    expect(manager.list()).toEqual([]);
  });

  it('固定时钟、ID 的双 lane 金标准逐字节一致', async () => {
    let next = 0;
    let time = 100;
    const manager = new TaskLifeCycleManager({ now: () => time, idFactory: () => `id-${++next}` });
    const handle = manager.create(input(), 'golden');
    manager.start('golden', 'fast');
    time = 110;
    manager.finish('golden', 'fast', { kind: 'reply', text: '答案' });
    time = 120;
    manager.finish('golden', 'slow', { kind: 'silent', reason: 'no-long-skill' });
    const result = await handle.done;
    expect(
      JSON.stringify({
        taskId: result.taskId,
        status: result.status,
        createdAt: result.createdAt,
        endedAt: result.endedAt,
        sequence: result.creationSequence,
        trace: result.input.trace,
        lanes: result.lanes,
      })
    ).toBe(
      '{"taskId":"golden","status":"completed","createdAt":100,"endedAt":120,"sequence":1,"trace":{"sessionKey":"group","inputMessageId":"input","inputEventId":"qq:input","traceId":"id-1","spanId":"id-3","taskId":"golden","parentSpanId":"id-2"},"lanes":{"fast":{"status":"completed","trace":{"sessionKey":"group","inputMessageId":"input","inputEventId":"qq:input","traceId":"id-1","spanId":"id-4","taskId":"golden","parentSpanId":"id-3","lane":"fast"},"startedAt":100,"result":{"kind":"reply","text":"答案"},"endedAt":110},"slow":{"status":"completed","trace":{"sessionKey":"group","inputMessageId":"input","inputEventId":"qq:input","traceId":"id-1","spanId":"id-5","taskId":"golden","parentSpanId":"id-3","lane":"slow"},"result":{"kind":"silent","reason":"no-long-skill"},"endedAt":120}}}'
    );
  });

  it('固定种子重复事件、取消和乱序终结满足双终结与通知一次', async () => {
    const rng = random(0xc0ffee);
    const manager = new TaskLifeCycleManager({ now: () => 100, idFactory: () => 'fixed' });
    const handles = Array.from({ length: 24 }, (_, i) =>
      manager.create(input(`${i}`), `task-${i}`)
    );
    const terminalCounts = new Map<string, number>();
    manager.onChange((task) => {
      if (task.status !== 'running' && task.status !== 'pending')
        terminalCounts.set(task.taskId, (terminalCounts.get(task.taskId) ?? 0) + 1);
    });
    for (let i = 0; i < 800; i++) {
      const id = `task-${rng() % handles.length}`;
      const lane: Lane = rng() % 2 ? 'fast' : 'slow';
      const before = manager.get(id)!;
      if (rng() % 4 === 0) manager.cancel(id);
      else if (rng() % 3 === 0) manager.start(id, lane);
      else manager.finish(id, lane, { kind: 'silent', reason: 'no-long-skill' });
      const current = manager.get(id)!;
      if (before.status === 'completed' || before.status === 'cancelled')
        expect(current).toEqual(before);
      const ended = ['fast', 'slow'].every(
        (l) =>
          current.lanes[l as Lane].status !== 'queued' &&
          current.lanes[l as Lane].status !== 'running'
      );
      expect(current.status === 'completed' || current.status === 'cancelled').toBe(ended);
    }
    for (const handle of handles) {
      manager.finish(handle.taskId, 'fast', { kind: 'silent', reason: 'no-long-skill' });
      manager.finish(handle.taskId, 'slow', { kind: 'silent', reason: 'no-long-skill' });
    }
    await Promise.all(handles.map((handle) => handle.done));
    expect([...terminalCounts.values()]).toEqual(Array(24).fill(1));
  });
});

describe('Task budget owner 契约', () => {
  it('settle 和 finish 写入失败保留预留，恢复后首次提交一次', () => {
    const store = new FaultStore<BudgetRecord>();
    const budget = new TaskBudget(store);
    budget.reserve('task', 'old', 1);
    const before = budget.get('task');
    store.reject = () => true;
    expect(() => {
      budget.finish('task');
    }).toThrow('injected-write-failure');
    expect(() => budget.settle('task', true, false)).toThrow('injected-write-failure');
    expect(budget.get('task')).toEqual(before);
    store.reject = () => false;
    expect(budget.settle('task', true, false)).toBe('committed');
    expect(budget.settle('task', true, true)).toBeUndefined();
  });

  it('固定种子预算操作与故障保持预留、提交、释放守恒', () => {
    const rng = random(0xbadf00d);
    const store = new FaultStore<BudgetRecord>();
    const budget = new TaskBudget(store);
    const model = new Map<string, BudgetRecord>();
    for (let i = 0; i < 1200; i++) {
      const id = `task-${rng() % 40}`;
      const scope = `topic-${rng() % 4}`;
      const op = rng() % 3;
      const fail = rng() % 7 === 0;
      const success = rng() % 2 === 0;
      const finished = rng() % 2 === 0;
      const old = model.get(id);
      const used = [...model.values()].filter(
        (row) => row.scope === scope && row.status !== 'released'
      ).length;
      let change = !old && used < 3;
      if (op === 1) change = !!old && old.status === 'reserved' && (success || finished);
      if (op === 2) change = !!old && !old.executionFinished;
      store.reject = () => fail;
      const action = () => {
        if (op === 0) return budget.reserve(id, scope, 3);
        if (op === 1) return budget.settle(id, success, finished);
        budget.finish(id);
      };
      if (fail && change) expect(action).toThrow('injected-write-failure');
      else {
        action();
        if (change && op === 0) model.set(id, { taskId: id, scope, limit: 3, status: 'reserved' });
        if (change && op === 1 && old)
          model.set(id, { ...old, status: success ? 'committed' : 'released' });
        if (change && op === 2 && old) model.set(id, { ...old, executionFinished: true });
      }
      expect(budget.list()).toEqual([...model.values()]);
      for (let s = 0; s < 4; s++)
        expect(
          budget.list().filter((row) => row.scope === `topic-${s}` && row.status !== 'released')
            .length
        ).toBeLessThanOrEqual(3);
    }
  });
});

describe('Actor 与调度保存失败契约', () => {
  it('generation 保存失败拒绝准入，修复后仍从上次成功的 generation 递增', async () => {
    const sessions = new FaultStore<SessionContextState>();
    const clock = new ManualClock();
    clock.time = 100;
    const manager = new TaskLifeCycleManager({ now: clock.now });
    const fast = new LaneScheduler();
    const slow = new LaneScheduler();
    const preparer = {
      capture: () => ({ window: [], replay: '' }),
      judge: async () => ({ related: false, mentionsChatRecord: false }),
      release: () => {},
    } as unknown as PromptPreparer;
    const actor = new SessionActor({
      manager,
      preparer,
      schedulers: { fast, slow },
      budget: new TaskBudget(),
      sessions,
      clock,
      taskIdFactory: () => 'actor-task',
      runner: { run: async () => ({ kind: 'silent', reason: 'no-long-skill' }) },
      output: { accept: async () => {} } as unknown as SessionOutputCoordinator,
    });
    closes.push(() => {
      actor.close();
    });
    sessions.reject = () => true;
    const connector = {} as BotConnector;
    const context = {
      message: input().message,
      isAdmin: false,
      connector,
      logger: createNullLogger(),
    };
    await expect(actor.submit(context)).rejects.toThrow('injected-write-failure');
    expect(manager.list()).toEqual([]);
    expect(fast.snapshot()).toEqual({ running: 0, queued: 0 });
    expect(slow.snapshot()).toEqual({ running: 0, queued: 0 });
    sessions.reject = () => false;
    const handle = await actor.submit(context);
    await handle.done;
    expect(manager.get(handle.taskId)!.input.generation).toBe(2);
    expect(sessions.records).toEqual([{ sessionKey: 'group', generation: 2, sinceTs: 100 }]);
  });

  it('结算保存失败释放额度，修复后只重试 settle、done 一次、不重跑 run', async () => {
    const store = new FaultStore<TaskSnapshot>();
    const manager = new TaskLifeCycleManager({ store, now: () => 100 });
    const handle = manager.create(input(), 'scheduler-task');
    manager.finish(handle.taskId, 'slow', { kind: 'silent', reason: 'no-long-skill' });
    const error = vi.fn();
    const scheduler = new LaneScheduler(1, error);
    const run = vi.fn(async () => ({ kind: 'silent' as const, reason: 'no-long-skill' as const }));
    const done = vi.fn();
    void handle.done.then(done);
    store.reject = () => true;
    scheduler.enqueue({
      task: manager.get(handle.taskId)!,
      run,
      settle: (result) => {
        manager.finish(handle.taskId, 'fast', result);
      },
    });
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalled();
    });
    expect(scheduler.snapshot()).toEqual({ running: 0, queued: 0 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    store.reject = () => false;
    scheduler.flushSettlements();
    await handle.done;
    scheduler.flushSettlements();
    expect(run).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
    closes.push(() => {
      scheduler.close();
    });
  });
});

function queueHarness(transport?: (context: ReplyContext) => Promise<void>) {
  const store = new FaultStore<QueuedMessage>();
  const clock = new ManualClock();
  clock.time = 100;
  const sent: ReplyContext[] = [];
  let connected = true;
  const connector = {
    health: () => ({ connected, state: 'mock' }),
    policy: () => ({ passiveWindowMs: 10_000, maxRepliesPerMsg: 5 }),
  } as unknown as BotConnector;
  const queue = new MessageQueue({
    store,
    clock,
    idFactory: () => 'fixed',
    logger: createNullLogger(),
    connectors: new Map([['qq-official', connector]]),
    transport: async (_connector, context) => {
      sent.push(context);
      await transport?.(context);
    },
  });
  closes.push(() => {
    queue.close();
  });
  const request = input();
  const candidate: ReplyCandidate = {
    taskId: 'task',
    lane: 'fast',
    message: request.message,
    reference: request.reference,
    text: '答案',
    kind: 'final',
  };
  return {
    store,
    clock,
    sent,
    queue,
    candidate,
    connected: (value: boolean) => {
      connected = value;
    },
  };
}

describe('MessageQueue owner 持久化契约', () => {
  it('连接器修改发送目标不能改写队列记录，列表和计数快照均拒绝写入', async () => {
    const h = queueHarness(async (context) => {
      context.target.key = 'connector-owned-copy';
    });
    h.queue.enqueue(h.candidate, 'isolated');
    await vi.waitFor(() => {
      expect(h.queue.snapshot().sent).toBe(1);
    });
    expect(h.queue.messages()[0]!.candidate.message.target.key).toBe('group');
    expect(h.store.records[0]!.candidate.message.target.key).toBe('group');
    expect(Reflect.set(h.queue.messages(), 0, {})).toBe(false);
    expect(Reflect.set(h.queue.snapshot(), 'sent', 100)).toBe(false);
    expect(Reflect.set(h.queue.taskDelivery('task'), 'success', false)).toBe(false);
    const manager = new TaskLifeCycleManager({ now: () => 100 });
    manager.create(input(), 'isolated');
    expect(Reflect.set(manager.list(), 0, {})).toBe(false);
  });

  it('固定时钟发送超时保留未知结果，迟到成功与再次唤醒不重复通知或原动作', async () => {
    let resolve!: () => void;
    const work = new Promise<void>((done) => {
      resolve = done;
    });
    let attempts = 0;
    const h = queueHarness(async () => {
      if (++attempts === 1) await work;
    });
    const delivered = vi.fn();
    h.queue.onDelivery(delivered);
    h.queue.enqueue(h.candidate, 'timeout');
    await vi.waitFor(() => {
      expect(attempts).toBe(1);
    });
    h.clock.advance(120_000);
    await vi.waitFor(() => {
      expect(h.queue.messages()[0]!.status).toBe('failed');
    });
    expect(h.queue.messages()[0]).toMatchObject({
      outcome: 'unknown',
      failure: { code: 'TIMEOUT', retry: 'never' },
    });
    const calls = delivered.mock.calls.filter(([result]) => result.messageId === 'timeout');
    expect(calls).toHaveLength(1);
    resolve();
    h.queue.wake();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent.filter((context) => context.kind === 'final')).toHaveLength(1);
    expect(delivered.mock.calls.filter(([result]) => result.messageId === 'timeout')).toHaveLength(
      1
    );
  });

  it('发送前保存失败不暴露 sending、不发平台动作、不消耗 seq', async () => {
    const h = queueHarness();
    h.store.reject = (rows) => rows.some((row) => row.status === 'sending');
    h.queue.enqueue(h.candidate, 'message');
    await Promise.resolve();
    expect(h.sent).toEqual([]);
    expect(h.queue.messages()[0]!.status).toBe('pending');
    expect(h.store.records[0]!.status).toBe('pending');
    h.store.reject = () => false;
    h.queue.wake();
    await vi.waitFor(() => {
      expect(h.queue.snapshot().sent).toBe(1);
    });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.seq).toBe(1);
  });

  it('平台成功后保存失败保留结果未知，修复后只保存终态和通知一次', async () => {
    const h = queueHarness();
    const delivered = vi.fn();
    h.queue.onDelivery(delivered);
    h.store.reject = (rows) => rows.some((row) => row.status === 'sent');
    h.queue.enqueue(h.candidate, 'message');
    await vi.waitFor(() => {
      expect(h.queue.messages()[0]!.outcome).toBe('unknown');
    });
    expect(h.sent).toHaveLength(1);
    expect(h.store.records[0]!.status).toBe('sending');
    expect(delivered).not.toHaveBeenCalled();
    h.queue.observe({ ...h.candidate.message, msgId: 'new', ts: 200 });
    await Promise.resolve();
    expect(h.sent).toHaveLength(1);
    h.store.reject = () => false;
    h.queue.wake();
    await vi.waitFor(() => {
      expect(delivered).toHaveBeenCalledTimes(1);
    });
    expect(h.sent).toHaveLength(1);
    expect(h.queue.messages()[0]!.status).toBe('sent');
    expect(h.store.records[0]!.status).toBe('sent');
  });

  it('重启结果未知消息不会再次调用平台原动作', async () => {
    const h = queueHarness();
    h.store.reject = (rows) => rows.some((row) => row.status === 'sent');
    h.queue.enqueue(h.candidate, 'message');
    await vi.waitFor(() => {
      expect(h.queue.messages()[0]!.outcome).toBe('unknown');
    });
    h.queue.close();
    h.store.reject = () => false;
    const connector = {
      health: () => ({ connected: true, state: 'mock' }),
      policy: () => ({ passiveWindowMs: 10_000, maxRepliesPerMsg: 5 }),
    } as unknown as BotConnector;
    const texts: string[] = [];
    const restarted = new MessageQueue({
      store: h.store,
      clock: h.clock,
      connectors: new Map([['qq-official', connector]]),
      logger: createNullLogger(),
      transport: async (_c, _context, candidate) => {
        texts.push(candidate.text);
      },
    });
    closes.push(() => {
      restarted.close();
    });
    restarted.wake();
    await vi.waitFor(() => {
      expect(texts).toHaveLength(1);
    });
    expect(texts[0]).toContain('失败');
    expect(texts).not.toContain(h.candidate.text);
    expect(restarted.messages()[0]).toMatchObject({
      outcome: 'unknown',
      failure: { code: 'UNKNOWN_OUTCOME', retry: 'never' },
    });
  });

  it('正文部分入队失败后重试只补缺失分段，不丢正文或重复已落盘分段', async () => {
    const h = queueHarness();
    h.connected(false);
    const manager = new TaskLifeCycleManager({ now: () => 100 });
    manager.create(input(), 'task');
    const output = new SessionOutputCoordinator({
      manager,
      queue: h.queue,
      budget: new TaskBudget(),
      filesDir: '/unused',
      maxChars: () => 3,
      clock: h.clock,
    });
    closes.push(() => {
      output.close();
    });
    let writes = 0;
    h.store.reject = () => ++writes === 2;
    const result = { kind: 'reply' as const, text: 'abcdefgh' };
    await expect(output.accept(manager.get('task')!, 'fast', result)).rejects.toThrow(
      'injected-write-failure'
    );
    expect(h.queue.messages()).toHaveLength(1);
    h.store.reject = () => false;
    await output.accept(manager.get('task')!, 'slow', result);
    expect(h.queue.messages()).toHaveLength(3);
    expect(
      h.queue
        .messages()
        .map((row) => row.candidate.text)
        .join('')
    ).toBe('abcdefgh');
    await output.accept(manager.get('task')!, 'fast', result);
    expect(h.queue.messages()).toHaveLength(3);
  });
});
