import { afterEach, describe, expect, it, vi } from 'vitest';
import { failure } from '@qqbot/contracts';
import type {
  DeepReadonly,
  FrontendReply,
  JobExecutionV3,
  MessageContext,
  PromptPreparerV3,
  Result,
  SessionOutputCoordinatorV3,
  SessionStateWriterV3,
  TaskInput,
  TaskJobOutcomeV3,
  TaskJobV3,
  TaskLifeCycleManagerV3,
  TaskRunnerV3,
  TaskSnapshotV3,
  TaskStateWriterV3,
  WorkerResult,
} from '@qqbot/contracts';
import {
  createJobSchedulerV3,
  createSessionActorV3,
  createTaskBudget,
  createTaskLifeCycleManagerV3,
} from '../src/task/index.js';
import { createNullLogger } from '../src/observability/index.js';
import { ManualClock } from './helpers/task-mocks.js';

class FaultStore implements TaskStateWriterV3 {
  records: unknown[] = [];
  reject: (records: readonly unknown[]) => boolean = () => false;
  load(): unknown[] {
    return structuredClone(this.records);
  }
  save(records: readonly unknown[]): void {
    if (this.reject(records)) throw new Error('injected-write-failure');
    this.records = structuredClone([...records]);
  }
}
class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()));
});
function success<T>(value: T): Result<T> {
  return { ok: true, value };
}
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.code, { cause: result.error });
  return result.value;
}
function input(id = 'input', sessionKey = 'group'): TaskInput {
  return {
    message: {
      kind: 'group-at-message',
      target: { platform: 'qq-official', key: sessionKey, id: sessionKey, kind: 'group' },
      eventId: `qq:${id}`,
      msgId: id,
      senderId: 'owner',
      content: `请求 ${id}`,
      ts: 100,
      raw: {},
    },
    isAdmin: false,
    source: 'user',
    generation: 1,
    reference: { messageId: id, excerpt: '固定问题', senderId: 'owner', ts: 100 },
    context: { replay: '', window: [] },
  };
}
const assignment = {
  instruction: '完成业务计算',
  deliverables: ['计算报告'],
  acknowledgement: '我开始处理了。',
};
const workerResult: WorkerResult = {
  status: 'completed',
  text: '计算结果 42',
  evidence: ['原始数据为 40 和 2'],
  attachments: [],
  unfinished: [],
};
function started(manager: TaskLifeCycleManagerV3, id = 'task') {
  const handle = unwrap(manager.create(input(id), id));
  const job = manager.pendingJobs().find((job) => job.taskId === id)!;
  unwrap(manager.claimJob(job.jobId));
  const execution: JobExecutionV3 = {
    jobId: job.jobId,
    executionId: `${id}-exec`,
    runtimeGeneration: 'runtime',
    sessionId: id,
  };
  unwrap(manager.bindExecution(id, job.jobId, execution));
  return {
    handle,
    job,
    execution,
    request: { taskId: id, jobId: job.jobId, execution, assignment },
  };
}
function completedWorker(manager: TaskLifeCycleManagerV3, id = 'task') {
  const initial = started(manager, id);
  const receipt = unwrap(manager.acceptWorker(initial.request));
  unwrap(manager.finishFrontend(id, initial.job.jobId, success({ kind: 'dispatched' })));
  unwrap(manager.claimJob(receipt.jobId));
  unwrap(manager.saveWorkerResult(id, receipt.jobId, success(workerResult)));
  const summary = manager.pendingJobs().find((job) => job.taskId === id && job.kind === 'summary')!;
  return { ...initial, receipt, summary };
}
function cancelledWorker(manager: TaskLifeCycleManagerV3) {
  const initial = started(manager);
  const receipt = unwrap(manager.acceptWorker(initial.request));
  unwrap(manager.finishFrontend('task', initial.job.jobId, success({ kind: 'dispatched' })));
  unwrap(manager.claimJob(receipt.jobId));
  const execution = { ...initial.execution, jobId: receipt.jobId, executionId: 'worker-execution' };
  unwrap(manager.bindExecution('task', receipt.jobId, execution));
  unwrap(manager.cancel('task'));
  return { ...initial, receipt, execution };
}
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe('V3 执行状态持久化', () => {
  it('创建保存失败不留下可调度任务，不消耗准入序号', () => {
    const store = new FaultStore();
    const manager = createTaskLifeCycleManagerV3({ store, now: () => 100 });
    store.reject = () => true;
    expect(manager.create(input(), 'task')).toMatchObject({
      ok: false,
      error: { code: 'PERSISTENCE_FAILED' },
    });
    expect(manager.list()).toEqual([]);
    expect(manager.pendingJobs()).toEqual([]);
    store.reject = () => false;
    unwrap(manager.create(input(), 'task'));
    expect(manager.get('task')?.creationSequence).toBe(1);
  });
  it.each(['claim', 'assignment', 'result', 'reply', 'confirm', 'cancel'] as const)(
    '%s 保存失败保留旧状态与观察次数，重试只保存同一结果',
    (operation) => {
      const store = new FaultStore();
      const manager = createTaskLifeCycleManagerV3({ store, now: () => 100 });
      let action: () => Result<unknown>;
      if (operation === 'claim') {
        unwrap(manager.create(input(), 'task'));
        action = () => manager.claimJob('task:frontend:1');
      } else if (operation === 'assignment' || operation === 'cancel') {
        const state = started(manager);
        action =
          operation === 'assignment'
            ? () => manager.acceptWorker(state.request)
            : () => manager.cancel('task');
      } else {
        const state = completedWorker(manager);
        if (operation === 'result') {
          const second = started(manager, 'second');
          const receipt = unwrap(manager.acceptWorker(second.request));
          unwrap(manager.claimJob(receipt.jobId));
          action = () => manager.saveWorkerResult('second', receipt.jobId, success(workerResult));
        } else {
          unwrap(manager.claimJob(state.summary.jobId));
          const reply: FrontendReply = { replyId: 'chosen-id', text: '最终答案 42' };
          if (operation === 'confirm')
            unwrap(manager.saveFinalReply('task', state.summary.jobId, success(reply)));
          action =
            operation === 'reply'
              ? () => manager.saveFinalReply('task', state.summary.jobId, success(reply))
              : () => manager.confirmEnqueued('task', 'task:reply:1');
        }
      }
      const before = manager.list();
      const changed = vi.fn();
      manager.onChange(changed);
      store.reject = () => true;
      expect(action()).toMatchObject({ ok: false, error: { code: 'PERSISTENCE_FAILED' } });
      expect(manager.list()).toEqual(before);
      expect(changed).not.toHaveBeenCalled();
      store.reject = () => false;
      expect(action().ok).toBe(true);
      expect(changed).toHaveBeenCalledTimes(1);
    }
  );
  it('派发保存成功但回执丢失和前台超时，已接受 worker 继续且重复派发只接受一次', () => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    const state = started(manager);
    const receipt = unwrap(manager.acceptWorker(state.request));
    expect(
      unwrap(
        manager.acceptWorker({
          ...state.request,
          assignment: {
            deliverables: ['计算报告'],
            instruction: '  完成业务计算  ',
            acknowledgement: '我开始处理了。',
          },
        })
      )
    ).toEqual(receipt);
    expect(
      manager.acceptWorker({
        ...state.request,
        assignment: { ...assignment, instruction: '不同工作' },
      })
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    unwrap(
      manager.finishFrontend('task', state.job.jobId, { ok: false, error: failure('TIMEOUT') })
    );
    expect(manager.get('task')).toMatchObject({
      phase: 'worker-waiting',
      status: 'running',
      worker: { receipt: { workerId: receipt.workerId, status: 'queued' } },
    });
    expect(manager.pendingJobs().filter((job) => job.kind === 'worker')).toHaveLength(1);
  });
  it('worker 提前完成只保存结果，首次前台退出后才可领取整理，重复结果不增加版本', () => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    const state = started(manager);
    const receipt = unwrap(manager.acceptWorker(state.request));
    unwrap(manager.claimJob(receipt.jobId));
    unwrap(manager.saveWorkerResult('task', receipt.jobId, success(workerResult)));
    expect(manager.pendingJobs().filter((job) => job.kind === 'summary')).toEqual([]);
    expect(manager.claimJob('task:summary:1')).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    unwrap(
      manager.saveWorkerResult(
        'task',
        receipt.jobId,
        success({ ...workerResult, text: '迟到正文' })
      )
    );
    expect(manager.get('task')?.worker).toMatchObject({
      resultVersion: 1,
      result: { text: '计算结果 42' },
    });
    unwrap(manager.finishFrontend('task', state.job.jobId, success({ kind: 'dispatched' })));
    expect(manager.pendingJobs().map((job) => job.kind)).toEqual(['summary']);
    unwrap(manager.claimJob('task:summary:1'));
    expect(manager.get('task')?.frontend.summaryAttempts).toBe(1);
  });
  it('整理可重试故障最多两个回合，失败说明保留业务结果且不重跑 worker', async () => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    const state = completedWorker(manager);
    for (const attempt of [1, 2]) {
      const jobId = `task:summary:${attempt}`;
      unwrap(manager.claimJob(jobId));
      unwrap(manager.saveFinalReply('task', jobId, { ok: false, error: failure('TIMEOUT') }));
    }
    const final = manager.get('task')!;
    expect(final.frontend.summaryAttempts).toBe(2);
    expect(final.finalReply?.text).toContain('执行已结束');
    expect(final.worker?.result).toEqual(workerResult);
    expect(manager.pendingJobs()).toEqual([]);
    unwrap(manager.confirmEnqueued('task', final.finalReply!.replyId));
    expect((await state.handle.done).status).toBe('failed');
  });
  it('空整理正文为不可重试失败，不再启动第二回合', () => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    const state = completedWorker(manager);
    unwrap(manager.claimJob(state.summary.jobId));
    unwrap(
      manager.saveFinalReply(
        'task',
        state.summary.jobId,
        success({ replyId: 'reply', text: '   ' })
      )
    );
    expect(manager.get('task')).toMatchObject({
      phase: 'reply-pending',
      frontend: { summaryAttempts: 1, failure: { code: 'INVALID_INPUT', retry: 'never' } },
    });
    expect(manager.pendingJobs()).toEqual([]);
  });
  it('仅控制字符的整理正文固定失败说明，避免永久重试入队', () => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    const state = completedWorker(manager);
    unwrap(manager.claimJob(state.summary.jobId));
    unwrap(
      manager.saveFinalReply(
        'task',
        state.summary.jobId,
        success({ replyId: 'reply', text: '\u0000\u001b' })
      )
    );
    expect(manager.get('task')).toMatchObject({
      phase: 'reply-pending',
      finalStatus: 'failed',
      frontend: { failure: { code: 'INVALID_INPUT' } },
    });
    expect(manager.get('task')?.finalReply?.text).toContain('整理失败');
  });
  it('派发拒绝计数独立于首次前台失败，重复成功回执不计数', () => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    const state = started(manager);
    expect(
      manager.acceptWorker({ ...state.request, assignment: { instruction: '', deliverables: [] } })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    unwrap(manager.acceptWorker(state.request));
    unwrap(manager.acceptWorker(state.request));
    expect(manager.handoffFailureCount()).toBe(1);
  });
  it('状态先保存再记录阶段日志，日志失败不影响已保存状态和通知', () => {
    const store = new FaultStore();
    const logger = createNullLogger();
    vi.spyOn(logger, 'child').mockReturnValue(logger);
    vi.spyOn(logger, 'withTrace').mockReturnValue(logger);
    const logs = vi.spyOn(logger, 'event').mockImplementation(() => {
      throw new Error('log-failed');
    });
    vi.spyOn(logger, 'error').mockImplementation(() => {
      throw new Error('log-failed');
    });
    const manager = createTaskLifeCycleManagerV3({ store, now: () => 100, logger });
    const changed = vi.fn();
    manager.onChange(changed);
    store.reject = () => true;
    expect(manager.create(input(), 'task')).toMatchObject({
      ok: false,
      error: { code: 'PERSISTENCE_FAILED' },
    });
    expect(logs).not.toHaveBeenCalled();
    store.reject = () => false;
    unwrap(manager.create(input(), 'task'));
    expect(store.records).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it('派发、worker、整理和终态日志保留身份和实际耗时', () => {
    let now = 100;
    const logger = createNullLogger();
    const metadata = vi.spyOn(logger, 'child').mockReturnValue(logger);
    vi.spyOn(logger, 'withTrace').mockReturnValue(logger);
    const logs = vi.spyOn(logger, 'event');
    const manager = createTaskLifeCycleManagerV3({ now: () => now, logger });
    const state = started(manager);
    now = 110;
    const receipt = unwrap(manager.acceptWorker(state.request));
    unwrap(manager.finishFrontend('task', state.job.jobId, success({ kind: 'dispatched' })));
    now = 120;
    unwrap(manager.claimJob(receipt.jobId));
    now = 150;
    unwrap(manager.saveWorkerResult('task', receipt.jobId, success(workerResult)));
    now = 160;
    unwrap(manager.claimJob('task:summary:1'));
    now = 180;
    unwrap(
      manager.saveFinalReply('task', 'task:summary:1', success({ replyId: 'reply', text: '正文' }))
    );
    unwrap(manager.confirmEnqueued('task', 'task:reply:1'));
    expect(logs).toHaveBeenCalledWith('task.created', { source: 'user', generation: 1 });
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: receipt.jobId,
        workerId: receipt.workerId,
        dispatchElapsedMs: 10,
        workerDurationMs: 30,
      })
    );
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'task:summary:1', summaryAttempt: 1, summaryDurationMs: 20 })
    );
    expect(logs).toHaveBeenCalledWith('task.terminal', { status: 'completed', durationMs: 80 });
  });
  it('最终回复身份由服务端固定，入队未确认时 Task 保持运行', () => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    const state = completedWorker(manager);
    unwrap(manager.claimJob(state.summary.jobId));
    unwrap(
      manager.saveFinalReply(
        'task',
        state.summary.jobId,
        success({ replyId: 'untrusted', text: '最终答案' })
      )
    );
    expect(manager.get('task')).toMatchObject({
      status: 'running',
      phase: 'reply-pending',
      finalReply: { replyId: 'task:reply:1' },
    });
    expect(manager.confirmEnqueued('task', 'untrusted')).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    unwrap(manager.confirmEnqueued('task', 'task:reply:1'));
    expect(manager.get('task')?.status).toBe('completed');
  });
  it('取消优先，旧执行身份、迟到结果和入队确认都不能重新启动 Task', () => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    const state = started(manager);
    const receipt = unwrap(manager.acceptWorker(state.request));
    expect(
      manager.matches('task', state.job.jobId, { ...state.execution, executionId: 'wrong' })
    ).toBe(false);
    unwrap(manager.cancel('task'));
    expect(manager.acceptWorker(state.request)).toMatchObject({
      ok: false,
      error: { code: 'CANCELLED' },
    });
    unwrap(manager.saveWorkerResult('task', receipt.jobId, success(workerResult)));
    expect(manager.get('task')).toMatchObject({
      status: 'cancelled',
      phase: 'terminal',
      worker: { result: { status: 'cancelled' } },
    });
    expect(manager.pendingJobs()).toEqual([]);
  });
  it.each(['completed', 'failed', 'unknown'] as const)('取消收尾拒绝迟到的 %s 结果', (status) => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    const state = cancelledWorker(manager);
    const before = manager.get('task');
    unwrap(
      manager.saveWorkerResult('task', state.receipt.jobId, success({ ...workerResult, status }))
    );
    expect(manager.get('task')).toEqual(before);
    expect(manager.matches('task', state.receipt.jobId, state.execution)).toBe(false);
  });
  it('取消材料保存失败保留空结果，补保存幂等且恢复后仍为取消', () => {
    const store = new FaultStore();
    const manager = createTaskLifeCycleManagerV3({ store, now: () => 100 });
    const state = cancelledWorker(manager);
    const before = manager.get('task')!;
    const result: WorkerResult = {
      ...workerResult,
      status: 'cancelled',
      text: '已经算出部分结果。',
      failure: failure('CANCELLED'),
      unfinished: ['已按要求停止，现有内容已保留。'],
    };
    store.reject = () => true;
    expect(manager.saveWorkerResult('task', state.receipt.jobId, success(result))).toMatchObject({
      ok: false,
      error: { code: 'PERSISTENCE_FAILED' },
    });
    expect(manager.get('task')).toEqual(before);
    store.reject = () => false;
    unwrap(manager.saveWorkerResult('task', state.receipt.jobId, success(result)));
    const saved = manager.get('task')!;
    expect(saved).toMatchObject({
      status: 'cancelled',
      phase: 'terminal',
      endedAt: before.endedAt,
      worker: {
        receipt: { status: 'cancelled' },
        endedAt: before.worker?.endedAt,
        resultVersion: before.worker!.resultVersion + 1,
        result,
      },
    });
    unwrap(
      manager.saveWorkerResult(
        'task',
        state.receipt.jobId,
        success({ ...result, text: '重复调用试图换正文' })
      )
    );
    expect(manager.get('task')).toEqual(saved);
    const restarted = createTaskLifeCycleManagerV3({ store, now: () => 200 });
    unwrap(restarted.recover());
    expect(restarted.get('task')).toEqual(saved);
    expect(restarted.pendingJobs()).toEqual([]);
  });
  it('取消已保存结果后，迟到的取消材料不能覆盖已有业务内容', () => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    const state = completedWorker(manager);
    unwrap(manager.cancel('task'));
    const before = manager.get('task');
    unwrap(
      manager.saveWorkerResult(
        'task',
        state.receipt.jobId,
        success({
          ...workerResult,
          status: 'cancelled',
          text: '尝试覆盖',
          failure: failure('CANCELLED'),
        })
      )
    );
    expect(manager.get('task')).toEqual(before);
  });
  it('持久数据非法明确拒绝', () => {
    const store = new FaultStore();
    store.records = [{ schemaVersion: 3, taskId: 'bad', status: 'running' }];
    expect(() => createTaskLifeCycleManagerV3({ store })).toThrow('V3 Task 持久记录非法');
  });
  it.each([
    ['schemaVersion', 4],
    ['input.reference.excerpt', 9],
    ['input.reference.ts', '100'],
    ['input.message.parts', [{ type: 'media', mediaKind: 'file', sizeBytes: '100' }]],
    [
      'input.context.window',
      [
        {
          msgId: 'old',
          eventId: 'old',
          senderId: 'owner',
          text: '',
          ts: 100,
          addressed: true,
          reference: { excerpt: '', senderId: 9, ts: 100 },
        },
      ],
    ],
    ['worker.handoff.originalInput.reference.senderId', 'other-user'],
    ['worker.handoff.attachments', [{ id: 'attachment', name: 'report.csv', path: 9 }]],
    ['worker.handoff.constraints', [9]],
    ['worker.assignmentKey', 'wrong'],
    [
      'worker.execution',
      { jobId: 'other-job', executionId: 'exec', runtimeGeneration: 'runtime', sessionId: 'task' },
    ],
    ['frontend.initialJob.jobId', 'other-job'],
    ['frontend.summaryJob.resultVersion', 2],
    ['frontend.summaryAttempts', 2],
    [
      'worker.result.attachments',
      [{ kind: 'file', absPath: '/tmp/report', fileName: '../report', sizeBytes: 100 }],
    ],
    ['phase', 'summary-running'],
  ])('持久记录的 %s 非法或身份错配时拒绝启动', (path, value) => {
    const store = new FaultStore();
    completedWorker(createTaskLifeCycleManagerV3({ store, now: () => 100 }));
    replacePersistedField(store.records[0], path, value);
    expect(() => createTaskLifeCycleManagerV3({ store })).toThrow();
  });
  it('worker 已保存结果后旧执行身份失效', () => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    const initial = started(manager);
    const receipt = unwrap(manager.acceptWorker(initial.request));
    unwrap(manager.claimJob(receipt.jobId));
    const execution = {
      ...initial.execution,
      jobId: receipt.jobId,
      executionId: 'worker-execution',
    };
    unwrap(manager.bindExecution('task', receipt.jobId, execution));
    expect(manager.matches('task', receipt.jobId, execution)).toBe(true);
    unwrap(manager.saveWorkerResult('task', receipt.jobId, success(workerResult)));
    expect(manager.matches('task', receipt.jobId, execution)).toBe(false);
  });
});

function replacePersistedField(record: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  let parent = record;
  for (const key of keys.slice(0, -1)) {
    if (typeof parent !== 'object' || parent === null || !(key in parent))
      throw new Error('持久测试记录缺字段');
    parent = (parent as Record<string, unknown>)[key];
  }
  const key = keys.at(-1);
  if (!key || typeof parent !== 'object' || parent === null) throw new Error('持久测试字段非法');
  (parent as Record<string, unknown>)[key] = value;
}

describe('V3 重启与排队截止', () => {
  it('旧记录恢复保存失败后重试仍执行保存，保留已完成 lane 结果', () => {
    const store = new FaultStore();
    const reply = { kind: 'reply', text: '已有快答' };
    store.records = [
      {
        taskId: 'legacy',
        input: input(),
        status: 'running',
        lanes: { fast: { status: 'completed', result: reply }, slow: { status: 'running' } },
      },
    ];
    const manager = createTaskLifeCycleManagerV3({ store, now: () => 200 });
    const interruptions = manager.pendingLegacyInterruptions();
    expect(interruptions).toEqual([{ taskId: 'legacy', input: input() }]);
    expect(Object.isFrozen(interruptions[0]?.input.message.target)).toBe(true);
    expect(manager.list()).toEqual([]);
    expect(manager.get('legacy')).toBeUndefined();
    store.reject = () => true;
    expect(manager.recover()).toMatchObject({ ok: false, error: { code: 'PERSISTENCE_FAILED' } });
    expect(store.records[0]).toMatchObject({ status: 'running' });
    expect(manager.pendingLegacyInterruptions()).toEqual(interruptions);
    store.reject = () => false;
    unwrap(manager.recover());
    expect(store.records[0]).toMatchObject({
      status: 'failed',
      lanes: {
        fast: { result: reply },
        slow: { result: { failure: { code: 'UNKNOWN_OUTCOME' } } },
      },
    });
    expect(manager.pendingJobs()).toEqual([]);
    expect(manager.pendingLegacyInterruptions()).toEqual([]);
  });
  it('等待整理超过排队截止时固定失败说明，不消耗整理次数', () => {
    let now = 100;
    const manager = createTaskLifeCycleManagerV3({ now: () => now, queueTimeoutMs: 10 });
    const state = completedWorker(manager);
    now = 111;
    unwrap(
      manager.saveFinalReply('task', state.summary.jobId, { ok: false, error: failure('TIMEOUT') })
    );
    expect(manager.get('task')).toMatchObject({
      phase: 'reply-pending',
      frontend: { summaryAttempts: 0, failure: { code: 'TIMEOUT' } },
      finalReply: { text: expect.stringContaining('执行已结束') },
    });
    expect(manager.pendingJobs()).toEqual([]);
  });
  it('排队 worker 保留原截止，已开始却缺结果的 worker 只整理未知结果', () => {
    const store = new FaultStore();
    let now = 100;
    const manager = createTaskLifeCycleManagerV3({ store, now: () => now, queueTimeoutMs: 1000 });
    const queued = started(manager, 'queued');
    const receipt = unwrap(manager.acceptWorker(queued.request));
    unwrap(manager.finishFrontend('queued', queued.job.jobId, success({ kind: 'dispatched' })));
    const active = started(manager, 'active');
    const runningReceipt = unwrap(manager.acceptWorker(active.request));
    unwrap(manager.claimJob(runningReceipt.jobId));
    now = 200;
    const restarted = createTaskLifeCycleManagerV3({ store, now: () => now, queueTimeoutMs: 1000 });
    unwrap(restarted.recover());
    expect(restarted.pendingJobs().find((job) => job.taskId === 'queued')).toMatchObject({
      kind: 'worker',
      deadlineAt: receipt.deadlineAt,
    });
    expect(
      restarted
        .pendingJobs()
        .filter((job) => job.taskId === 'active')
        .map((job) => job.kind)
    ).toEqual(['summary']);
    expect(restarted.get('active')?.worker?.result).toMatchObject({
      status: 'unknown',
      failure: { code: 'UNKNOWN_OUTCOME', retry: 'never' },
    });
  });
  it('已保存结果恢复整理，已开始整理计入两次上限，已固定回复仅恢复入队', () => {
    const store = new FaultStore();
    const manager = createTaskLifeCycleManagerV3({ store, now: () => 100 });
    const waiting = completedWorker(manager, 'waiting');
    const summarizing = completedWorker(manager, 'summarizing');
    unwrap(manager.claimJob(summarizing.summary.jobId));
    const fixed = completedWorker(manager, 'fixed');
    unwrap(manager.claimJob(fixed.summary.jobId));
    unwrap(
      manager.saveFinalReply(
        'fixed',
        fixed.summary.jobId,
        success({ replyId: 'reply', text: '固定正文' })
      )
    );
    const restarted = createTaskLifeCycleManagerV3({ store, now: () => 200 });
    unwrap(restarted.recover());
    expect(restarted.pendingJobs().map((job) => job.jobId)).toContain(waiting.summary.jobId);
    expect(restarted.pendingJobs().map((job) => job.jobId)).toContain('summarizing:summary:2');
    expect(restarted.get('summarizing')?.frontend.summaryAttempts).toBe(1);
    expect(restarted.get('fixed')).toMatchObject({
      phase: 'reply-pending',
      finalReply: { text: '固定正文', replyId: 'fixed:reply:1' },
    });
    expect(restarted.pendingJobs().filter((job) => job.taskId === 'fixed')).toEqual([]);
  });
  it('首次排队和 worker 排队分别截止，不借执行额度等待', () => {
    const clock = new ManualClock();
    clock.time = 100;
    const manager = createTaskLifeCycleManagerV3({ now: clock.now, queueTimeoutMs: 10 });
    unwrap(manager.create(input('initial'), 'initial'));
    const state = started(manager, 'worker');
    const receipt = unwrap(manager.acceptWorker(state.request));
    unwrap(manager.finishFrontend('worker', state.job.jobId, success({ kind: 'dispatched' })));
    clock.advance(11);
    unwrap(manager.expire());
    expect(manager.get('initial')).toMatchObject({
      phase: 'reply-pending',
      frontend: { failure: { code: 'TIMEOUT' } },
    });
    expect(manager.get('worker')?.worker).toMatchObject({
      receipt: { jobId: receipt.jobId, status: 'failed' },
      result: { failure: { code: 'TIMEOUT' } },
    });
    expect(manager.pendingJobs().find((job) => job.taskId === 'worker')?.kind).toBe('summary');
  });
});

describe('V3 job 调度', () => {
  it('worker结果待补保存时取消，仍以取消分类补存材料且不重跑', async () => {
    const store = new FaultStore();
    const manager = createTaskLifeCycleManagerV3({ store, now: () => 100 });
    const state = started(manager);
    const receipt = unwrap(manager.acceptWorker(state.request));
    unwrap(manager.finishFrontend('task', state.job.jobId, success({ kind: 'dispatched' })));
    const task = unwrap(manager.claimJob(receipt.jobId));
    unwrap(
      manager.bindExecution('task', receipt.jobId, { ...state.execution, jobId: receipt.jobId })
    );
    const failedSave = new Deferred<void>();
    const scheduler = createJobSchedulerV3({
      onSettlementError: () => {
        failedSave.resolve();
      },
    });
    closes.push(() => scheduler.close());
    const run = vi.fn(async (): Promise<TaskJobOutcomeV3> => ({
      kind: 'worker',
      result: success(workerResult),
    }));
    store.reject = () => true;
    unwrap(
      scheduler.enqueue({
        job: {
          jobId: receipt.jobId,
          taskId: 'task',
          sessionKey: task.input.message.target.key,
          kind: 'worker',
          createdAt: Date.now(),
          deadlineAt: Date.now() + 60_000,
        },
        run,
        settle: (outcome) =>
          outcome.kind === 'worker'
            ? manager.saveWorkerResult('task', receipt.jobId, outcome.result)
            : success(undefined),
      })
    );
    await failedSave.promise;
    await tick();
    expect(scheduler.snapshot()).toMatchObject({ running: 0, pendingSettlements: 1 });
    store.reject = () => false;
    unwrap(manager.cancel('task'));
    scheduler.cancel('task');
    scheduler.flushSettlements();
    const saved = manager.get('task');
    expect(saved).toMatchObject({
      status: 'cancelled',
      phase: 'terminal',
      worker: {
        result: { status: 'cancelled', text: workerResult.text, failure: { code: 'CANCELLED' } },
      },
    });
    scheduler.flushSettlements();
    expect(manager.get('task')).toEqual(saved);
    expect(manager.pendingJobs()).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot().pendingSettlements).toBe(0);
  });

  it('同 Session 首次前台与整理交替，跨 Session 轮转，同 Session worker 串行', async () => {
    const scheduler = createJobSchedulerV3({ capacity: 1 });
    closes.push(() => scheduler.close());
    const order: string[] = [];
    const done = new Deferred<void>();
    let settled = 0;
    for (const [id, kind, sessionKey] of [
      ['a1', 'frontend', 'a'],
      ['a2', 'frontend', 'a'],
      ['s1', 'summary', 'a'],
      ['s2', 'summary', 'a'],
      ['b1', 'frontend', 'b'],
    ] as const) {
      const job: TaskJobV3 = {
        jobId: id,
        taskId: id,
        sessionKey,
        kind,
        createdAt: Date.now(),
        deadlineAt: Date.now() + 60_000,
      };
      unwrap(
        scheduler.enqueue({
          job,
          run: async () => {
            order.push(id);
            return { kind, result: { ok: false, error: failure('CANCELLED') } };
          },
          settle: () => {
            if (++settled === 5) done.resolve();
            return success(undefined);
          },
        })
      );
    }
    await done.promise;
    expect(order).toEqual(['a1', 'b1', 's1', 'a2', 's2']);
  });
  it('两个独立 job 的保存故障分别保留，维护补保存不重跑执行', async () => {
    const scheduler = createJobSchedulerV3({ capacity: 2 });
    closes.push(() => scheduler.close());
    const executed = new Deferred<void>();
    let count = 0;
    let failSave = true;
    const runs = vi.fn(async (_signal: AbortSignal): Promise<TaskJobOutcomeV3> => {
      if (++count === 2) executed.resolve();
      return { kind: 'worker', result: success(workerResult) };
    });
    const saved: string[] = [];
    for (const id of ['first', 'second'])
      unwrap(
        scheduler.enqueue({
          job: {
            jobId: id,
            taskId: 'same-task',
            sessionKey: id,
            kind: 'worker',
            createdAt: Date.now(),
            deadlineAt: Date.now() + 60_000,
          },
          run: runs,
          settle: () => {
            if (failSave) return { ok: false, error: failure('PERSISTENCE_FAILED') };
            saved.push(id);
            return success(undefined);
          },
        })
      );
    await executed.promise;
    await tick();
    expect(scheduler.snapshot().pendingSettlements).toBe(2);
    failSave = false;
    scheduler.flushSettlements();
    scheduler.flushSettlements();
    expect(saved).toEqual(['first', 'second']);
    expect(runs).toHaveBeenCalledTimes(2);
  });
  it('满额度时排队截止与取消立即结算，关闭等运行工作释放', async () => {
    const clock = new ManualClock();
    clock.time = 100;
    const scheduler = createJobSchedulerV3({ capacity: 1, clock });
    const startedJob = new Deferred<void>();
    const cancelled = new Deferred<void>();
    const failures: string[] = [];
    unwrap(
      scheduler.enqueue({
        job: {
          jobId: 'running',
          taskId: 'running',
          sessionKey: 'a',
          kind: 'worker',
          createdAt: 100,
          deadlineAt: 110,
        },
        run: (signal) =>
          new Promise((resolve) => {
            startedJob.resolve();
            signal.addEventListener(
              'abort',
              () => {
                cancelled.resolve();
                resolve({ kind: 'worker', result: { ok: false, error: failure('CANCELLED') } });
              },
              { once: true }
            );
          }),
        settle: () => success(undefined),
      })
    );
    await startedJob.promise;
    for (const id of ['deadline', 'cancel'])
      unwrap(
        scheduler.enqueue({
          job: {
            jobId: id,
            taskId: id,
            sessionKey: 'b',
            kind: 'worker',
            createdAt: 100,
            deadlineAt: 110,
          },
          run: async () => {
            throw new Error('不能运行');
          },
          settle: (outcome) => {
            if (!outcome.result.ok) failures.push(`${id}:${outcome.result.error.code}`);
            return success(undefined);
          },
        })
      );
    scheduler.cancel('cancel');
    clock.advance(11);
    expect(failures).toEqual(['cancel:CANCELLED', 'deadline:TIMEOUT']);
    const closed = scheduler.close();
    await cancelled.promise;
    await closed;
    expect(scheduler.snapshot()).toMatchObject({ running: 0, queued: 0, pendingSettlements: 0 });
  });
});

function actorHarness(
  runner: TaskRunnerV3,
  manager = createTaskLifeCycleManagerV3({ now: () => 100 }),
  output?: SessionOutputCoordinatorV3,
  sessions?: SessionStateWriterV3
) {
  const logger = createNullLogger();
  const context = (task: DeepReadonly<TaskSnapshotV3>) =>
    ({
      message: structuredClone(task.input.message),
      isAdmin: task.input.isAdmin,
      logger,
    }) as unknown as MessageContext;
  const preparer = {
    capture: () => ({ replay: '', window: [] }),
    judge: async () => ({ related: true, mentionsChatRecord: false }),
    release: () => {},
  } as unknown as PromptPreparerV3;
  const accepted: DeepReadonly<FrontendReply>[] = [];
  const coordinator =
    output ??
    ({
      accept: async (_task, reply) => {
        accepted.push(structuredClone(reply));
      },
      acknowledge: () => {},
      reconcile: () => {},
      forget: () => {},
      close: () => {},
    } satisfies SessionOutputCoordinatorV3);
  const clock = new ManualClock();
  clock.time = 100;
  const actor = createSessionActorV3({
    manager,
    runner,
    preparer,
    output: coordinator,
    budget: createTaskBudget(),
    clock,
    sessions,
    schedulers: {
      frontend: createJobSchedulerV3({ capacity: 1, clock }),
      worker: createJobSchedulerV3({ capacity: 1, clock }),
    },
    context,
    taskIdFactory: (() => {
      let next = 0;
      return () => `task-${++next}`;
    })(),
  });
  closes.push(() => actor.close());
  return {
    actor,
    manager,
    accepted,
    context: (request: TaskInput) =>
      ({ message: request.message, isAdmin: request.isAdmin, logger }) as unknown as MessageContext,
  };
}
describe('V3 Actor 补遗漏与取消', () => {
  it('失败结果补保存不重复增加整理失败数', async () => {
    const store = new FaultStore();
    const manager = createTaskLifeCycleManagerV3({ store, now: () => 100 });
    const state = completedWorker(manager);
    const summaries = vi.fn(async (): Promise<Result<FrontendReply>> => ({
      ok: false,
      error: failure('TIMEOUT'),
    }));
    const h = actorHarness(
      {
        runFrontend: async () => success({ kind: 'dispatched' }),
        runWorker: async () => success(workerResult),
        runSummary: summaries,
      },
      manager
    );
    store.reject = (records) =>
      records.some(
        (record) =>
          typeof record === 'object' &&
          record !== null &&
          'frontend' in record &&
          typeof record.frontend === 'object' &&
          record.frontend !== null &&
          'failure' in record.frontend
      );
    h.actor.flushSettlements();
    await tick();
    h.actor.flushSettlements();
    expect(h.actor.snapshot().summaryFailures).toBe(0);
    store.reject = () => false;
    h.actor.flushSettlements();
    expect((await state.handle.done).status).toBe('failed');
    expect(h.actor.snapshot().summaryFailures).toBe(2);
    expect(summaries).toHaveBeenCalledTimes(2);
  });

  const runner: TaskRunnerV3 = {
    runFrontend: async () => success({ kind: 'reply', reply: { replyId: 'reply', text: '正文' } }),
    runWorker: async () => success(workerResult),
    runSummary: async () => success({ replyId: 'reply', text: '正文' }),
  };
  it.each([
    null,
    { sessionKey: '', generation: 1, sinceTs: 100 },
    { sessionKey: 'group', generation: 0, sinceTs: 100 },
    { sessionKey: 'group', generation: 1, sinceTs: Infinity },
  ])('会话持久记录非法时拒绝启动', (record) => {
    const sessions: SessionStateWriterV3 = { load: () => [record], save: () => {} };
    expect(() => actorHarness(runner, undefined, undefined, sessions)).toThrow(
      'Session 持久记录非法'
    );
  });
  it('重复会话记录拒绝启动', () => {
    const record = { sessionKey: 'group', generation: 1, sinceTs: 100 };
    const sessions: SessionStateWriterV3 = { load: () => [record, record], save: () => {} };
    expect(() => actorHarness(runner, undefined, undefined, sessions)).toThrow(
      'Session 持久记录重复'
    );
  });
  it('Actor 的交接失败数读取管理器统计', () => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    const state = started(manager);
    expect(
      manager.acceptWorker({ ...state.request, assignment: { instruction: '', deliverables: [] } })
        .ok
    ).toBe(false);
    expect(actorHarness(runner, manager).actor.snapshot().handoffFailures).toBe(1);
  });
  it('维护的排队截止保存失败明确报错，重试才固定失败回复', () => {
    const store = new FaultStore();
    const manager = createTaskLifeCycleManagerV3({ store, now: () => 100, queueTimeoutMs: 10 });
    unwrap(manager.create(input(), 'expired'));
    const h = actorHarness(runner, manager);
    store.reject = () => true;
    const restarted = createTaskLifeCycleManagerV3({ store, now: () => 111 });
    const expired = actorHarness(runner, restarted);
    expect(() => {
      expired.actor.flushSettlements();
    }).toThrow('PERSISTENCE_FAILED');
    expect(restarted.get('expired')?.phase).toBe('frontend-queued');
    store.reject = () => false;
    expired.actor.flushSettlements();
    expect(restarted.get('expired')?.phase).toBe('reply-pending');
    h.actor.cancel('expired');
  });
  it('漏完成通知后维护仍领取整理，固定回复入队失败不重写模型', async () => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    // Actor 注册前完成业务，模拟完成通知遗漏。
    const state = completedWorker(manager);
    const summaries = vi.fn(async () => success({ replyId: 'model-id', text: '固定回复' }));
    const runner: TaskRunnerV3 = {
      runFrontend: async () =>
        success({ kind: 'reply', reply: { replyId: 'new', text: '新回复' } }),
      runWorker: async () => success(workerResult),
      runSummary: summaries,
    };
    let failEnqueue = true;
    const attempts: string[] = [];
    const failed = new Deferred<void>();
    const output: SessionOutputCoordinatorV3 = {
      accept: async (_task, reply) => {
        attempts.push(reply.replyId);
        if (failEnqueue) {
          failed.resolve();
          throw new Error('queue-save-failed');
        }
      },
      acknowledge: () => {},
      reconcile: () => {},
      forget: () => {},
      close: () => {},
    };
    const h = actorHarness(runner, manager, output);
    h.actor.flushSettlements();
    await failed.promise;
    await tick();
    expect(manager.get('task')?.phase).toBe('reply-pending');
    failEnqueue = false;
    h.actor.flushSettlements();
    expect((await state.handle.done).status).toBe('completed');
    expect(summaries).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual(['task:reply:1', 'task:reply:1']);
  });
  it('stop 取消等待 worker 和等待整理，保留首次尚未开始 Task，new 再取消排队输入', () => {
    const manager = createTaskLifeCycleManagerV3({ now: () => 100 });
    const waiting = started(manager, 'waiting');
    unwrap(manager.acceptWorker(waiting.request));
    unwrap(manager.finishFrontend('waiting', waiting.job.jobId, success({ kind: 'dispatched' })));
    completedWorker(manager, 'summary');
    unwrap(manager.create(input('queued'), 'queued'));
    const runner: TaskRunnerV3 = {
      runFrontend: async () =>
        success({ kind: 'reply', reply: { replyId: 'reply', text: '正文' } }),
      runWorker: async () => success(workerResult),
      runSummary: async () => success({ replyId: 'reply', text: '正文' }),
    };
    const h = actorHarness(runner, manager);
    expect(h.actor.stop('group')).toBe(2);
    expect(manager.get('queued')?.status).toBe('pending');
    expect(h.actor.reset('group')).toBe(1);
    expect(manager.get('queued')?.status).toBe('cancelled');
    expect(h.actor.generation('group')).toBe(2);
  });
});
