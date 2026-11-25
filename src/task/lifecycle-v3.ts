import { randomUUID } from 'node:crypto';
import {
  failure,
  isTaskTerminal,
  readonlySnapshot,
  TASK_RESTART_INTERRUPTION_TEXT,
} from '@qqbot/contracts';
import { stripControlChars } from '../content/index.js';
import { legacyTrace } from '../observability/index.js';
import { failedWorker } from './worker-outcome-v3.js';
import type {
  AttachmentReference,
  ContractFailure,
  DeepReadonly,
  LegacyTaskInterruptionV3,
  FrontendReply,
  FrontendTurnResultV3,
  JobExecutionV3,
  Logger,
  Result,
  SessionEvent,
  TaskHandleV3,
  TaskInput,
  TaskJobV3,
  TaskLifeCycleManagerV3 as ManagerContract,
  TaskSnapshotV3,
  WorkerAssignment,
  WorkerReceipt,
  MessagePart,
  NormalizedMessage,
  WorkerHandoff,
  WorkerSnapshotV3,
  WorkerResult,
  createTaskLifeCycleManagerFactoryV3,
} from '@qqbot/contracts';

const QUEUE_TIMEOUT_MS = 30 * 60_000;
const MAX_HANDOFF_BYTES = 256 * 1024;
const PHASES = new Set([
  'frontend-queued',
  'frontend-running',
  'worker-waiting',
  'summary-queued',
  'summary-running',
  'reply-pending',
  'terminal',
]);
const STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);
const WORKER_STATUSES = new Set([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'unknown',
]);

/** 唯一执行状态写者。候选先落盘，成功后才提交、通知或完成 handle。 */
export class TaskLifeCycleManagerV3 implements ManagerContract {
  private readonly tasks = new Map<string, TaskSnapshotV3>();
  private readonly legacy: (Record<string, unknown> & LegacyTaskInterruptionV3)[] = [];
  private readonly listeners = new Set<(task: DeepReadonly<TaskSnapshotV3>) => void>();
  private readonly eventListeners = new Set<(event: DeepReadonly<SessionEvent>) => void>();
  private readonly completions = new Map<
    string,
    { handle: TaskHandleV3; resolve: (task: DeepReadonly<TaskSnapshotV3>) => void }
  >();
  private sequence = 0;
  private handoffFailures = 0;
  private readonly now: () => number;
  constructor(
    private readonly options: NonNullable<Parameters<createTaskLifeCycleManagerFactoryV3>[0]> = {}
  ) {
    this.now = options.now ?? Date.now;
    for (const record of options.store?.load() ?? []) {
      if (!isRecord(record)) throw new Error('Task 持久记录必须是对象');
      if (record.schemaVersion === 3) {
        validateTaskRecord(record);
        const task = structuredClone(record) as unknown as TaskSnapshotV3;
        if (this.tasks.has(task.taskId)) throw new Error(`重复 Task 持久记录：${task.taskId}`);
        this.tasks.set(task.taskId, task);
        this.sequence = Math.max(this.sequence, task.creationSequence);
      } else {
        validateLegacyTaskRecord(record);
        this.legacy.push(structuredClone(record));
      }
    }
  }
  onChange(listener: (task: DeepReadonly<TaskSnapshotV3>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onEvent(listener: (event: DeepReadonly<SessionEvent>) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }
  assertAdmission(sessionKey: string): Result<void> {
    const unfinished = [...this.tasks.values()].filter((task) => !isTaskTerminal(task));
    if (
      unfinished.length >= (this.options.maxGlobal ?? 128) ||
      unfinished.filter((task) => task.input.message.target.key === sessionKey).length >=
        (this.options.maxPerSession ?? 32)
    )
      return { ok: false, error: failure('CONFLICT', 'Task 容量已满') };
    return { ok: true, value: undefined };
  }
  create(
    input: TaskInput,
    taskId = this.options.idFactory?.() ?? randomUUID()
  ): Result<TaskHandleV3> {
    if (this.tasks.has(taskId)) return { ok: false, error: failure('CONFLICT', taskId) };
    const admission = this.assertAdmission(input.message.target.key);
    if (!admission.ok) return admission;
    const createdAt = this.now();
    const task: TaskSnapshotV3 = {
      schemaVersion: 3,
      taskId,
      input: structuredClone(input),
      createdAt,
      creationSequence: this.sequence + 1,
      status: 'pending',
      phase: 'frontend-queued',
      cancelAccepted: false,
      frontend: {
        initialJob: this.job(taskId, input.message.target.key, 'frontend', 1, createdAt),
        summaryAttempts: 0,
      },
    };
    const saved = this.commit(task);
    if (!saved.ok) return saved;
    this.sequence = task.creationSequence;
    return this.handle(taskId);
  }
  get(taskId: string): DeepReadonly<TaskSnapshotV3> | undefined {
    const task = this.tasks.get(taskId);
    return task && readonlySnapshot(task);
  }
  list(sessionKey?: string): DeepReadonly<TaskSnapshotV3[]> {
    return readonlySnapshot(
      [...this.tasks.values()].filter(
        (task) => sessionKey === undefined || task.input.message.target.key === sessionKey
      )
    );
  }
  handle(taskId: string): Result<TaskHandleV3> {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: failure('NOT_FOUND', taskId) };
    let completion = this.completions.get(taskId);
    if (!completion) {
      let resolve!: (snapshot: DeepReadonly<TaskSnapshotV3>) => void;
      const done = new Promise<DeepReadonly<TaskSnapshotV3>>((r) => {
        resolve = r;
      });
      completion = { handle: { taskId, done }, resolve };
      this.completions.set(taskId, completion);
      if (isTaskTerminal(task)) resolve(readonlySnapshot(task));
    }
    return { ok: true, value: completion.handle };
  }
  pendingJobs(): DeepReadonly<TaskJobV3[]> {
    return readonlySnapshot([...this.tasks.values()].flatMap(pendingTaskJobs));
  }
  pendingLegacyInterruptions(): DeepReadonly<LegacyTaskInterruptionV3[]> {
    return readonlySnapshot(
      this.legacy
        .filter((task) => task.status === 'pending' || task.status === 'running')
        .map((task) => ({ taskId: task.taskId, input: task.input }))
    );
  }
  handoffFailureCount(): number {
    return this.handoffFailures;
  }
  claimJob(jobId: string): Result<DeepReadonly<TaskSnapshotV3>> {
    const source = [...this.tasks.values()].find(
      (task) =>
        task.frontend.initialJob.jobId === jobId ||
        task.frontend.summaryJob?.jobId === jobId ||
        task.worker?.receipt.jobId === jobId
    );
    if (!source) return { ok: false, error: failure('NOT_FOUND', jobId) };
    const task = structuredClone(source);
    if (task.cancelAccepted || isTaskTerminal(task))
      return { ok: false, error: failure('CANCELLED', task.taskId) };
    const job = this.pendingJobs().find((item) => item.jobId === jobId);
    if (!job) return { ok: false, error: failure('CONFLICT', jobId) };
    if (job.deadlineAt <= this.now()) return { ok: false, error: failure('TIMEOUT', jobId) };
    recordJobClaim(task, job, this.now());
    const saved = this.commit(task);
    return saved.ok ? { ok: true, value: readonlySnapshot(task) } : saved;
  }
  bindExecution(taskId: string, jobId: string, execution: JobExecutionV3): Result<void> {
    const source = this.tasks.get(taskId);
    if (!source) return { ok: false, error: failure('NOT_FOUND', taskId) };
    if (execution.jobId !== jobId || source.cancelAccepted || isTaskTerminal(source))
      return { ok: false, error: failure('CANCELLED', jobId) };
    const task = structuredClone(source);
    const bound = recordJobExecution(task, jobId, execution);
    return bound.ok ? this.commit(task) : bound;
  }
  matches(taskId: string, jobId: string, execution: JobExecutionV3): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !acceptsExecution(task)) return false;
    const current = currentJobExecution(task, jobId);
    return current !== undefined && sameExecution(current, execution);
  }
  acceptWorker(request: {
    taskId: string;
    jobId: string;
    execution: JobExecutionV3;
    assignment: WorkerAssignment;
    attachments?: AttachmentReference[];
    constraints?: string[];
    controlOperations?: string[];
  }): Result<WorkerReceipt> {
    const result = this.saveWorkerAssignment(request);
    if (!result.ok) this.handoffFailures++;
    return result;
  }
  private saveWorkerAssignment(
    request: Parameters<ManagerContract['acceptWorker']>[0]
  ): Result<WorkerReceipt> {
    const source = this.tasks.get(request.taskId);
    if (!source) return { ok: false, error: failure('NOT_FOUND', request.taskId) };
    if (
      !this.matches(request.taskId, request.jobId, request.execution) ||
      source.frontend.initialJob.jobId !== request.jobId
    )
      return {
        ok: false,
        error: failure(source.cancelAccepted ? 'CANCELLED' : 'CONFLICT', request.jobId),
      };
    if (!validWorkerAuthorization(source, request.assignment))
      return { ok: false, error: failure('INVALID_INPUT', '进度查询或重试目标没有本次执行授权') };
    const prepared = createWorkerHandoff(source.input, request);
    if (!prepared.ok) return prepared;
    const { handoff, assignmentKey } = prepared.value;
    if (source.worker) return existingWorkerReceipt(source.worker, assignmentKey);
    const task = structuredClone(source);
    const acceptedAt = this.now();
    const receipt: WorkerReceipt = {
      workerId: `${task.taskId}:worker`,
      jobId: `${task.taskId}:worker:1`,
      acceptedAt,
      deadlineAt: acceptedAt + (this.options.queueTimeoutMs ?? QUEUE_TIMEOUT_MS),
      status: 'queued',
    };
    task.worker = { receipt, handoff, assignmentKey, resultVersion: 0 };
    task.phase = 'worker-waiting';
    const saved = this.commit(task, {
      type: 'worker-accepted',
      taskId: task.taskId,
      jobId: receipt.jobId,
      workerId: receipt.workerId,
      execution: request.execution,
    });
    return saved.ok ? { ok: true, value: structuredClone(receipt) } : saved;
  }
  finishFrontend(
    taskId: string,
    jobId: string,
    result: Result<FrontendTurnResultV3>
  ): Result<void> {
    const source = this.tasks.get(taskId);
    if (!source) return { ok: false, error: failure('NOT_FOUND', taskId) };
    if (source.frontend.initialJob.jobId !== jobId)
      return { ok: false, error: failure('CONFLICT', jobId) };
    if (source.frontend.initialEndedAt !== undefined || isTaskTerminal(source))
      return { ok: true, value: undefined };
    const task = structuredClone(source);
    task.frontend.initialEndedAt = this.now();
    delete task.frontend.activeJob;
    delete task.frontend.execution;
    if (task.cancelAccepted) return this.commit(task);
    if (task.worker) task.phase = task.worker.result ? 'summary-queued' : 'worker-waiting';
    else {
      const reply = frontendReplyFromOutcome(result);
      if (reply.ok) this.fixReply(task, reply.value, 'completed');
      else this.fixFailureReply(task, reply.error, '前台处理失败，请稍后重试。');
    }
    return this.commit(task, { type: 'frontend-finished', taskId, jobId });
  }
  saveWorkerResult(taskId: string, jobId: string, result: Result<WorkerResult>): Result<void> {
    const source = this.tasks.get(taskId);
    if (!source?.worker) return { ok: false, error: failure('NOT_FOUND', jobId) };
    if (source.worker.receipt.jobId !== jobId)
      return { ok: false, error: failure('CONFLICT', jobId) };
    if (source.cancelAccepted || source.worker.result || !acceptsExecution(source))
      return source.cancelAccepted
        ? this.saveCancelledWorkerMaterials(source, result)
        : { ok: true, value: undefined };
    if (source.worker.receipt.status !== 'running' && source.worker.receipt.status !== 'queued')
      return { ok: false, error: failure('CONFLICT', jobId) };
    const task = structuredClone(source);
    const worker = structuredClone(source.worker);
    worker.result = workerResultFromOutcome(result);
    worker.receipt.status = worker.result.status;
    worker.endedAt = this.now();
    worker.resultVersion++;
    task.worker = worker;
    task.frontend.summaryJob = this.job(
      taskId,
      task.input.message.target.key,
      'summary',
      task.frontend.summaryAttempts + 1,
      this.now(),
      worker.resultVersion
    );
    task.phase = 'summary-queued';
    return this.commit(task, {
      type: 'worker-finished',
      taskId,
      jobId,
      workerId: worker.receipt.workerId,
      execution: worker.execution,
      resultVersion: worker.resultVersion,
    });
  }
  private saveCancelledWorkerMaterials(
    source: TaskSnapshotV3,
    outcome: Result<WorkerResult>
  ): Result<void> {
    if (
      !source.worker ||
      !hasCancelledWorkerPlaceholder(source.worker) ||
      !outcome.ok ||
      !validCancelledWorkerMaterials(outcome.value)
    )
      return { ok: true, value: undefined };
    const task = structuredClone(source);
    const worker = structuredClone(source.worker);
    worker.result = structuredClone(outcome.value);
    worker.resultVersion++;
    task.worker = worker;
    return this.commit(task);
  }
  saveFinalReply(taskId: string, jobId: string, result: Result<FrontendReply>): Result<void> {
    const source = this.tasks.get(taskId);
    if (!source) return { ok: false, error: failure('NOT_FOUND', taskId) };
    if (source.finalReply || !acceptsExecution(source)) return { ok: true, value: undefined };
    if (isQueuedSummaryTimeout(source, jobId, result)) {
      const task = structuredClone(source);
      this.fixFailureReply(task, result.error, summaryFailureText(task.worker?.result));
      return this.commit(task, {
        type: 'reply-saved',
        taskId,
        jobId,
        resultVersion: task.worker?.resultVersion,
      });
    }
    if (!isActiveSummary(source, jobId)) return { ok: false, error: failure('CONFLICT', jobId) };
    const task = structuredClone(source);
    this.recordSummaryOutcome(task, result);
    return this.commit(
      task,
      task.finalReply
        ? { type: 'reply-saved', taskId, jobId, resultVersion: task.worker?.resultVersion }
        : undefined
    );
  }
  confirmEnqueued(taskId: string, replyId: string): Result<void> {
    const source = this.tasks.get(taskId);
    if (!source) return { ok: false, error: failure('NOT_FOUND', taskId) };
    if (source.finalReply?.replyId !== replyId)
      return { ok: false, error: failure('CONFLICT', replyId) };
    if (source.replyEnqueuedAt !== undefined || source.cancelAccepted)
      return { ok: true, value: undefined };
    const task = structuredClone(source);
    task.replyEnqueuedAt = this.now();
    task.phase = 'terminal';
    task.status = task.finalStatus ?? 'failed';
    task.endedAt = this.now();
    return this.commit(task);
  }
  cancel(taskId: string): Result<boolean> {
    const source = this.tasks.get(taskId);
    if (!source) return { ok: false, error: failure('NOT_FOUND', taskId) };
    if (source.cancelAccepted || isTaskTerminal(source)) return { ok: true, value: false };
    const task = structuredClone(source);
    task.cancelAccepted = true;
    task.phase = 'terminal';
    task.status = 'cancelled';
    task.endedAt = this.now();
    if (task.worker && !task.worker.result) {
      task.worker.result = failedWorker(failure('CANCELLED', taskId));
      task.worker.receipt.status = 'cancelled';
      task.worker.endedAt = this.now();
      task.worker.resultVersion++;
    }
    const saved = this.commit(task, { type: 'cancelled', taskId, jobId: currentTaskJobId(task) });
    return saved.ok ? { ok: true, value: true } : saved;
  }
  recover(): Result<DeepReadonly<TaskSnapshotV3[]>> {
    const changed: TaskSnapshotV3[] = [];
    for (const source of this.tasks.values()) {
      if (isTaskTerminal(source)) continue;
      const task = this.recoverTask(source);
      const saved = this.commit(task);
      if (!saved.ok) return saved;
      changed.push(task);
    }
    const legacy = this.recoverLegacy();
    if (!legacy.ok) return legacy;
    const expired = this.expire();
    return expired.ok ? { ok: true, value: readonlySnapshot(changed) } : expired;
  }
  expire(): Result<DeepReadonly<TaskSnapshotV3[]>> {
    const changed = new Set<string>();
    for (const job of this.pendingJobs()) {
      if (job.deadlineAt > this.now()) continue;
      const error = failure('TIMEOUT', `排队截止：${job.jobId}`);
      let saved: Result<void>;
      if (job.kind === 'worker')
        saved = this.saveWorkerResult(job.taskId, job.jobId, { ok: false, error });
      else if (job.kind === 'frontend')
        saved = this.finishFrontend(job.taskId, job.jobId, { ok: false, error });
      else saved = this.saveFinalReply(job.taskId, job.jobId, { ok: false, error });
      if (!saved.ok) return saved;
      changed.add(job.taskId);
    }
    return { ok: true, value: this.list().filter((task) => changed.has(task.taskId)) };
  }
  destroy(taskId: string): Result<boolean> {
    const source = this.tasks.get(taskId);
    if (!source) return { ok: true, value: false };
    if (!isTaskTerminal(source)) return { ok: false, error: failure('CONFLICT', taskId) };
    const next = new Map(this.tasks);
    next.delete(taskId);
    try {
      this.options.store?.save(structuredClone([...this.legacy, ...next.values()]));
    } catch (cause) {
      return { ok: false, error: failure('PERSISTENCE_FAILED', cause) };
    }
    this.tasks.delete(taskId);
    this.completions.delete(taskId);
    return { ok: true, value: true };
  }
  prune(): Result<DeepReadonly<TaskSnapshotV3[]>> {
    const expired = [...this.tasks.values()].filter(
      (task) =>
        isTaskTerminal(task) &&
        (task.endedAt ?? task.createdAt) + (this.options.retentionMs ?? 7 * 86_400_000) <=
          this.now()
    );
    for (const task of expired) {
      const removed = this.destroy(task.taskId);
      if (!removed.ok) return removed;
    }
    return { ok: true, value: readonlySnapshot(expired) };
  }
  private job(
    taskId: string,
    sessionKey: string,
    kind: TaskJobV3['kind'],
    attempt: number,
    createdAt: number,
    resultVersion?: number
  ): TaskJobV3 {
    return {
      jobId: `${taskId}:${kind}:${attempt}`,
      taskId,
      sessionKey,
      kind,
      createdAt,
      deadlineAt: createdAt + (this.options.queueTimeoutMs ?? QUEUE_TIMEOUT_MS),
      ...(resultVersion === undefined ? {} : { resultVersion }),
    };
  }
  private recordSummaryOutcome(task: TaskSnapshotV3, result: Result<FrontendReply>): void {
    delete task.frontend.activeJob;
    delete task.frontend.execution;
    if (result.ok && validReply(result.value)) {
      this.fixReply(
        task,
        result.value,
        task.worker?.receipt.status === 'completed' ? 'completed' : 'failed'
      );
      return;
    }
    const error = result.ok ? failure('INVALID_INPUT', '整理答复必须有正文') : result.error;
    task.frontend.failure = error;
    if (error.retry === 'safe' && task.frontend.summaryAttempts < 2) {
      task.phase = 'summary-queued';
      task.frontend.summaryJob = this.job(
        task.taskId,
        task.input.message.target.key,
        'summary',
        task.frontend.summaryAttempts + 1,
        this.now(),
        task.worker?.resultVersion
      );
    } else this.fixFailureReply(task, error, summaryFailureText(task.worker?.result));
  }
  private recoverTask(source: TaskSnapshotV3): TaskSnapshotV3 {
    const task = structuredClone(source);
    if (task.worker?.receipt.status === 'running' && !task.worker.result) {
      recordInterruptedWorker(task.worker, this.now());
      task.frontend.summaryJob = this.job(
        task.taskId,
        task.input.message.target.key,
        'summary',
        task.frontend.summaryAttempts + 1,
        this.now(),
        task.worker.resultVersion
      );
    }
    this.recordInterruptedFrontend(task);
    delete task.frontend.activeJob;
    delete task.frontend.execution;
    if (task.finalReply) task.phase = 'reply-pending';
    else if (task.worker?.result) task.phase = 'summary-queued';
    else if (task.worker) task.phase = 'worker-waiting';
    return task;
  }
  private recordInterruptedFrontend(task: TaskSnapshotV3): void {
    if (task.frontend.activeJob?.kind === 'frontend') {
      task.frontend.initialEndedAt = this.now();
      if (!task.worker)
        this.fixFailureReply(
          task,
          failure('UNKNOWN_OUTCOME', '首次前台被重启中断'),
          '前台处理被重启中断，请重新发起请求。'
        );
    } else if (task.frontend.activeJob?.kind === 'summary') {
      if (task.frontend.summaryAttempts >= 2)
        this.fixFailureReply(
          task,
          failure('UNKNOWN_OUTCOME', '结果整理被重启中断'),
          summaryFailureText(task.worker?.result)
        );
      else
        task.frontend.summaryJob = this.job(
          task.taskId,
          task.input.message.target.key,
          'summary',
          task.frontend.summaryAttempts + 1,
          this.now(),
          task.worker?.resultVersion
        );
    }
  }
  private recoverLegacy(): Result<void> {
    const nextLegacy = structuredClone(this.legacy);
    const changed = nextLegacy.reduce<number>(
      (count, record) => count + Number(recordInterruptedLegacy(record, this.now())),
      0
    );
    if (changed === 0) return { ok: true, value: undefined };
    try {
      this.options.store?.save(structuredClone([...nextLegacy, ...this.tasks.values()]));
    } catch (cause) {
      return { ok: false, error: failure('PERSISTENCE_FAILED', cause) };
    }
    this.legacy.splice(0, this.legacy.length, ...nextLegacy);
    return { ok: true, value: undefined };
  }
  private fixReply(
    task: TaskSnapshotV3,
    reply: FrontendReply,
    status: 'completed' | 'failed'
  ): void {
    task.finalReply = structuredClone({ ...reply, replyId: `${task.taskId}:reply:1` });
    task.finalStatus = status;
    task.phase = 'reply-pending';
  }
  private fixFailureReply(task: TaskSnapshotV3, error: ContractFailure, text: string): void {
    task.frontend.failure = structuredClone(error);
    this.fixReply(task, { replyId: `${task.taskId}:reply:1`, text }, 'failed');
  }
  private commit(task: TaskSnapshotV3, event?: SessionEvent): Result<void> {
    const previous = this.tasks.get(task.taskId);
    const next = new Map(this.tasks).set(task.taskId, task);
    try {
      this.options.store?.save(structuredClone([...this.legacy, ...next.values()]));
    } catch (cause) {
      return { ok: false, error: failure('PERSISTENCE_FAILED', cause) };
    }
    this.tasks.set(task.taskId, task);
    if (isTaskTerminal(task)) this.completions.get(task.taskId)?.resolve(readonlySnapshot(task));
    this.publishTransition({ previous, current: task, event, at: this.now() });
    return { ok: true, value: undefined };
  }
  private publishTransition(transition: TaskTransition): void {
    const task = transition.current;
    try {
      logTaskTransition(this.options.logger, transition);
    } catch (error) {
      logObserverFailure(this.options.logger, task.taskId, error);
    }
    for (const listener of this.listeners) {
      try {
        listener(readonlySnapshot(task));
      } catch (error) {
        logObserverFailure(this.options.logger, task.taskId, error);
      }
    }
    if (transition.event) this.publishEvent(transition.event);
  }
  private publishEvent(event: SessionEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(readonlySnapshot(event));
      } catch (error) {
        logObserverFailure(this.options.logger, event.taskId, error);
      }
    }
  }
}

interface TaskTransition {
  previous?: TaskSnapshotV3;
  current: TaskSnapshotV3;
  event?: SessionEvent;
  at: number;
}
function logTaskTransition(logger: Logger | undefined, transition: TaskTransition): void {
  if (!logger) return;
  const task = transition.current;
  const scoped = logger
    .child({
      taskId: task.taskId,
      sessionKey: task.input.message.target.key,
      ...taskTransitionMetadata(transition),
    })
    .withTrace(task.input.trace ?? legacyTrace(task.taskId, task.input.message.target.key));
  if (!transition.previous)
    scoped.event('task.created', { source: task.input.source, generation: task.input.generation });
  if (taskTransitionChanged(transition))
    scoped.event('task.lane', {
      status: task.status,
      resultKind: task.worker?.receipt.status,
    });
  if (isTaskTerminal(task) && !isPreviousTerminal(transition.previous)) {
    scoped.child(terminalFailureMetadata(task)).event('task.terminal', {
      status: task.status,
      durationMs: transition.at - task.createdAt,
    });
  }
}
function isPreviousTerminal(task: TaskSnapshotV3 | undefined): boolean {
  return task !== undefined && isTaskTerminal(task);
}
function taskTransitionMetadata(transition: TaskTransition): Record<string, unknown> {
  const task = transition.current;
  return {
    phase: task.phase,
    previousPhase: transition.previous?.phase,
    role: taskPhaseRole(task),
    jobId: transition.event?.jobId ?? taskTransitionJobId(task),
    ...workerTransitionFields(task, transition.at),
    ...summaryTransitionFields(transition),
  };
}
function taskTransitionJobId(task: TaskSnapshotV3): string {
  if (task.phase === 'worker-waiting' && task.worker) return task.worker.receipt.jobId;
  return currentTaskJobId(task);
}
function taskTransitionChanged(transition: TaskTransition): boolean {
  const previous = transition.previous;
  if (!previous || transition.event) return true;
  const current = transition.current;
  return (
    previous.phase !== current.phase ||
    previous.status !== current.status ||
    previous.worker?.receipt.status !== current.worker?.receipt.status ||
    previous.frontend.summaryAttempts !== current.frontend.summaryAttempts
  );
}
function taskPhaseRole(task: TaskSnapshotV3): string {
  if (task.phase.startsWith('summary') || (task.finalReply && task.worker)) return 'summary';
  return task.phase === 'worker-waiting' ? 'worker' : 'frontend';
}
function workerTransitionFields(task: TaskSnapshotV3, at: number): Record<string, unknown> {
  const worker = task.worker;
  if (!worker) return {};
  return {
    workerId: worker.receipt.workerId,
    resultKind: worker.receipt.status,
    resultVersion: worker.resultVersion,
    dispatchElapsedMs:
      worker.receipt.acceptedAt - (task.frontend.initialStartedAt ?? task.createdAt),
    workerDurationMs:
      worker.startedAt === undefined ? undefined : (worker.endedAt ?? at) - worker.startedAt,
  };
}
function summaryTransitionFields(transition: TaskTransition): Record<string, unknown> {
  const task = transition.current;
  const frontend = task.frontend;
  if (transition.previous?.phase !== 'summary-running' && task.phase !== 'summary-running')
    return { summaryAttempt: frontend.summaryAttempts };
  return {
    summaryAttempt: frontend.summaryAttempts,
    summaryDurationMs:
      frontend.summaryStartedAt === undefined
        ? undefined
        : transition.at - frontend.summaryStartedAt,
  };
}
function logObserverFailure(logger: Logger | undefined, taskId: string, error: unknown): void {
  try {
    logger?.error('Task 观察者失败', {
      taskId,
      errorClass: error instanceof Error ? error.name : 'unknown',
    });
  } catch {
    /* 日志失败不能回滚已保存状态，也不能中断其他观察者。 */
  }
}
function sameExecution(left: JobExecutionV3, right: JobExecutionV3): boolean {
  return (
    left.jobId === right.jobId &&
    left.executionId === right.executionId &&
    left.runtimeGeneration === right.runtimeGeneration &&
    left.sessionId === right.sessionId
  );
}
function acceptsExecution(task: TaskSnapshotV3): boolean {
  return !task.cancelAccepted && !isTaskTerminal(task);
}
function isActiveSummary(task: TaskSnapshotV3, jobId: string): boolean {
  const active = task.frontend.activeJob;
  return (
    active?.jobId === jobId &&
    active.kind === 'summary' &&
    active.resultVersion === task.worker?.resultVersion
  );
}
function isQueuedSummaryTimeout(
  task: TaskSnapshotV3,
  jobId: string,
  result: Result<FrontendReply>
): result is Extract<Result<FrontendReply>, { ok: false }> {
  return (
    task.phase === 'summary-queued' &&
    task.frontend.summaryJob?.jobId === jobId &&
    !result.ok &&
    result.error.code === 'TIMEOUT'
  );
}
function currentJobExecution(task: TaskSnapshotV3, jobId: string): JobExecutionV3 | undefined {
  if (task.worker?.receipt.jobId === jobId)
    return task.worker.receipt.status === 'running' && !task.worker.result
      ? task.worker.execution
      : undefined;
  if (task.frontend.activeJob?.jobId !== jobId) return undefined;
  if (task.frontend.activeJob.kind === 'summary' && !isActiveSummary(task, jobId)) return undefined;
  return task.frontend.execution;
}
function currentTaskJobId(task: TaskSnapshotV3): string {
  return (
    task.frontend.activeJob?.jobId ?? task.worker?.receipt.jobId ?? task.frontend.initialJob.jobId
  );
}
function pendingTaskJobs(task: TaskSnapshotV3): TaskJobV3[] {
  if (!acceptsExecution(task)) return [];
  const jobs: TaskJobV3[] = [];
  if (task.phase === 'frontend-queued') jobs.push(task.frontend.initialJob);
  if (task.worker?.receipt.status === 'queued') {
    const receipt = task.worker.receipt;
    jobs.push({
      jobId: receipt.jobId,
      taskId: task.taskId,
      sessionKey: task.input.message.target.key,
      kind: 'worker',
      createdAt: receipt.acceptedAt,
      deadlineAt: receipt.deadlineAt,
    });
  }
  if (
    task.phase === 'summary-queued' &&
    task.frontend.initialEndedAt !== undefined &&
    !task.frontend.activeJob &&
    task.frontend.summaryJob
  )
    jobs.push(task.frontend.summaryJob);
  return jobs;
}
function recordJobClaim(task: TaskSnapshotV3, job: DeepReadonly<TaskJobV3>, now: number): void {
  task.status = 'running';
  if (job.kind === 'worker' && task.worker) {
    task.worker.receipt.status = 'running';
    task.worker.startedAt = now;
    return;
  }
  task.frontend.activeJob = structuredClone(job);
  delete task.frontend.execution;
  task.phase = job.kind === 'frontend' ? 'frontend-running' : 'summary-running';
  if (job.kind === 'frontend') task.frontend.initialStartedAt = now;
  else {
    task.frontend.summaryAttempts++;
    task.frontend.summaryStartedAt = now;
  }
}
function recordJobExecution(
  task: TaskSnapshotV3,
  jobId: string,
  execution: JobExecutionV3
): Result<void> {
  const current = currentJobExecution(task, jobId);
  if (current && !sameExecution(current, execution))
    return { ok: false, error: failure('CONFLICT', jobId) };
  if (task.worker?.receipt.jobId === jobId && task.worker.receipt.status === 'running')
    task.worker.execution = structuredClone(execution);
  else if (task.frontend.activeJob?.jobId === jobId)
    task.frontend.execution = structuredClone(execution);
  else return { ok: false, error: failure('CONFLICT', jobId) };
  return { ok: true, value: undefined };
}
function createWorkerHandoff(
  input: TaskInput,
  request: Parameters<ManagerContract['acceptWorker']>[0]
): Result<{ handoff: WorkerHandoff; assignmentKey: string }> {
  if (!validAssignment(request.assignment))
    return { ok: false, error: failure('INVALID_INPUT', 'worker 任务说明或交付要求非法') };
  const supplement = {
    attachments: request.attachments ?? [],
    constraints: request.constraints ?? [],
    controlOperations: request.controlOperations ?? [],
  };
  if (!validWorkerHandoffFields(supplement))
    return { ok: false, error: failure('INVALID_INPUT', 'worker 交接附件或约束非法') };
  const assignment = normalizedAssignment(request.assignment);
  const handoff = {
    assignment,
    originalInput: structuredClone(input),
    attachments: structuredClone(supplement.attachments),
    constraints: [...supplement.constraints],
    controlOperations: [...supplement.controlOperations],
  };
  if (Buffer.byteLength(canonicalDispatch(handoff)) > MAX_HANDOFF_BYTES)
    return { ok: false, error: failure('INVALID_INPUT', 'worker 交接数据超限') };
  return { ok: true, value: { handoff, assignmentKey: canonicalDispatch(assignment) } };
}
function normalizedAssignment(assignment: WorkerAssignment): WorkerAssignment {
  return {
    instruction: assignment.instruction.trim(),
    ...(assignment.deliveryIntent === undefined
      ? {}
      : { deliveryIntent: assignment.deliveryIntent }),
    ...(assignment.retryOf === undefined ? {} : { retryOf: assignment.retryOf }),
    ...(assignment.requiredCapabilities === undefined
      ? {}
      : { requiredCapabilities: [...new Set(assignment.requiredCapabilities)].sort() }),
    deliverables: assignment.deliverables.map((item) => item.trim()),
    ...(assignment.acknowledgement === undefined
      ? {}
      : { acknowledgement: assignment.acknowledgement.trim() }),
  };
}
function frontendReplyFromOutcome(result: Result<FrontendTurnResultV3>): Result<FrontendReply> {
  if (!result.ok) return result;
  if (result.value.kind === 'reply' && validReply(result.value.reply))
    return { ok: true, value: result.value.reply };
  return { ok: false, error: failure('INVALID_INPUT', '首次前台未返回答复或有效派发') };
}
function workerResultFromOutcome(result: Result<WorkerResult>): WorkerResult {
  if (!result.ok) return failedWorker(result.error);
  return validWorkerResult(result.value)
    ? structuredClone(result.value)
    : failedWorker(failure('INVALID_INPUT', 'worker 结果非法'));
}
function recordInterruptedWorker(worker: WorkerSnapshotV3, now: number): void {
  worker.result = failedWorker(failure('UNKNOWN_OUTCOME', '进程重启，worker 执行结果未知'));
  worker.receipt.status = 'unknown';
  worker.endedAt = now;
  worker.resultVersion++;
}
function recordInterruptedLegacy(record: unknown, now: number): boolean {
  if (!isRecord(record) || ['completed', 'failed', 'cancelled'].includes(String(record.status)))
    return false;
  record.status = 'failed';
  record.endedAt = now;
  if (!isRecord(record.lanes)) return true;
  for (const lane of Object.values(record.lanes)) {
    if (!isRecord(lane) || !['queued', 'running'].includes(String(lane.status))) continue;
    lane.status = 'failed';
    lane.endedAt = now;
    lane.result = {
      kind: 'failed',
      text: TASK_RESTART_INTERRUPTION_TEXT,
      error: 'interrupted',
      failure: failure('UNKNOWN_OUTCOME'),
    };
  }
  return true;
}
function canonicalDispatch(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDispatch).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalDispatch(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function validAssignment(value: unknown): value is WorkerAssignment {
  return (
    isRecord(value) &&
    validBusinessText(value.instruction) &&
    validDeliverables(value.deliverables) &&
    validOptionalStrings(value, ['acknowledgement']) &&
    validOptional(value, 'retryOf', validNonemptyString) &&
    validAssignmentCapabilities(value)
  );
}
function validDeliverables(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(validBusinessText);
}
function validAssignmentCapabilities(value: Record<string, unknown>): boolean {
  return (
    (value.deliveryIntent === undefined ||
      value.deliveryIntent === 'chat' ||
      value.deliveryIntent === 'text-document') &&
    (value.requiredCapabilities === undefined ||
      (Array.isArray(value.requiredCapabilities) &&
        value.requiredCapabilities.every((item) => item === 'web-search')))
  );
}
function validWorkerAuthorization(source: TaskSnapshotV3, assignment: WorkerAssignment): boolean {
  return !source.input.progressOnly && source.input.retryOf === assignment.retryOf;
}
function taskFailure(task: TaskSnapshotV3): ContractFailure | undefined {
  return task.worker?.result?.failure ?? task.frontend.failure;
}

function validReply(value: unknown): value is FrontendReply {
  return (
    isRecord(value) &&
    typeof value.replyId === 'string' &&
    value.replyId.length > 0 &&
    typeof value.text === 'string' &&
    stripControlChars(value.text).trim().length > 0 &&
    (value.attention === undefined || value.attention === 'strong') &&
    (value.attachments === undefined ||
      (Array.isArray(value.attachments) && value.attachments.every(validOutgoingAttachment)))
  );
}
function validWorkerResult(value: unknown): value is WorkerResult {
  return (
    isRecord(value) &&
    ['completed', 'failed', 'cancelled', 'unknown'].includes(String(value.status)) &&
    typeof value.text === 'string' &&
    validStrings(value.evidence) &&
    validStrings(value.unfinished) &&
    Array.isArray(value.attachments) &&
    value.attachments.every(validOutgoingAttachment) &&
    (value.failure === undefined || validFailure(value.failure))
  );
}
function hasCancelledWorkerPlaceholder(worker: WorkerSnapshotV3): boolean {
  const saved = worker.result;
  return (
    !!worker.execution &&
    saved?.status === 'cancelled' &&
    !saved.text &&
    !saved.attachments.length &&
    !saved.evidence.length
  );
}
function validCancelledWorkerMaterials(value: unknown): value is WorkerResult {
  return (
    validWorkerResult(value) &&
    value.status === 'cancelled' &&
    value.failure?.code === 'CANCELLED' &&
    !!(value.text.trim() || value.attachments.length || value.evidence.length)
  );
}
function summaryFailureText(result?: WorkerResult): string {
  if (result?.status === 'completed')
    return '执行已结束，但结果整理失败。结果和附件已保存，可稍后查询。';
  if (result?.status === 'unknown')
    return '执行中断，完成情况暂时无法确认，结果整理失败。已保存现有记录，请稍后查询。';
  return '执行未能顺利结束，结果整理失败。已保存现有结果和附件，可稍后查询。';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validateTaskRecord(value: Record<string, unknown>): void {
  if (!validTaskCore(value)) throw new Error('V3 Task 持久记录非法');
  if (!validFrontendSnapshot(value.frontend))
    throw new Error(`V3 Task 前台记录非法：${value.taskId}`);
  if (
    !validOptional(value, 'finalReply', validReply) ||
    !validOptionalTimes(value, ['endedAt', 'replyEnqueuedAt'])
  )
    throw new Error(`V3 Task 回复或时间非法：${value.taskId}`);
  if (value.worker !== undefined && !validWorkerSnapshot(value.worker, value.taskId, value.input))
    throw new Error(`V3 Task worker 记录非法：${value.taskId}`);
  if (
    value.finalStatus !== undefined &&
    value.finalStatus !== 'completed' &&
    value.finalStatus !== 'failed'
  )
    throw new Error(`V3 Task 最终分类非法：${value.taskId}`);
  const task = value as unknown as TaskSnapshotV3;
  validateTaskJobIdentity(task);
  validateTerminalTask(task);
  validateFrontendPhase(task);
  validateWorkerPhase(task);
}
function validTaskCore(
  value: Record<string, unknown>
): value is Record<string, unknown> & { taskId: string; input: TaskInput } {
  return (
    validNonemptyString(value.taskId) &&
    validTime(value.createdAt) &&
    validSequence(value.creationSequence) &&
    STATUSES.has(String(value.status)) &&
    PHASES.has(String(value.phase)) &&
    typeof value.cancelAccepted === 'boolean' &&
    validInput(value.input)
  );
}
function validFrontendSnapshot(value: unknown): value is TaskSnapshotV3['frontend'] {
  if (!isRecord(value) || !validJob(value.initialJob) || value.initialJob.kind !== 'frontend')
    return false;
  return (
    validSequence(value.summaryAttempts, 0) &&
    value.summaryAttempts <= 2 &&
    validOptional(value, 'activeJob', validJob) &&
    validOptional(value, 'summaryJob', validJob) &&
    validOptional(value, 'execution', validExecution) &&
    validOptional(value, 'failure', validFailure) &&
    validOptionalTimes(value, ['initialStartedAt', 'initialEndedAt', 'summaryStartedAt'])
  );
}
function validateTaskJobIdentity(task: TaskSnapshotV3): void {
  const frontend = task.frontend;
  for (const job of [frontend.initialJob, frontend.activeJob, frontend.summaryJob]) {
    if (job && (job.taskId !== task.taskId || job.sessionKey !== task.input.message.target.key))
      throw new Error(`V3 job 归属非法：${task.taskId}`);
  }
  if (frontend.initialJob.jobId !== `${task.taskId}:frontend:1`)
    throw new Error(`V3 首次 job 身份非法：${task.taskId}`);
  if (frontend.summaryJob && !validSummaryJob(frontend.summaryJob, task.taskId))
    throw new Error(`V3 整理 job 身份非法：${task.taskId}`);
  validateActiveJobIdentity(task);
}
function validateActiveJobIdentity(task: TaskSnapshotV3): void {
  const frontend = task.frontend;
  const active = frontend.activeJob;
  if (frontend.execution && frontend.execution.jobId !== active?.jobId)
    throw new Error(`V3 前台执行身份非法：${task.taskId}`);
  if (!active) return;
  const expected = active.kind === 'frontend' ? frontend.initialJob : frontend.summaryJob;
  if (
    !expected ||
    canonicalDispatch(active) !== canonicalDispatch(expected) ||
    frontend.initialStartedAt === undefined
  )
    throw new Error(`V3 当前 job 身份非法：${task.taskId}`);
}
function validateTerminalTask(task: TaskSnapshotV3): void {
  const terminal = isTaskTerminal(task);
  if (
    (task.phase === 'terminal') !== terminal ||
    (task.cancelAccepted && task.status !== 'cancelled') ||
    (terminal && task.endedAt === undefined)
  )
    throw new Error(`V3 Task 终态非法：${task.taskId}`);
  validateTaskReplyIdentity(task);
  if (
    ['completed', 'failed'].includes(task.status) &&
    (task.finalReply === undefined || task.replyEnqueuedAt === undefined)
  )
    throw new Error(`V3 入队确认缺失：${task.taskId}`);
}
function validateTaskReplyIdentity(task: TaskSnapshotV3): void {
  if (task.finalReply && task.finalReply.replyId !== `${task.taskId}:reply:1`)
    throw new Error(`V3 Task 回复身份非法：${task.taskId}`);
}
function validateFrontendPhase(task: TaskSnapshotV3): void {
  const frontend = task.frontend;
  if (task.phase === 'frontend-queued' && !validInitialQueue(task))
    throw new Error(`V3 首次排队状态非法：${task.taskId}`);
  if (task.phase === 'frontend-running' && frontend.activeJob?.kind !== 'frontend')
    throw new Error(`V3 首次执行状态非法：${task.taskId}`);
  if (
    task.phase === 'reply-pending' &&
    (task.finalReply === undefined ||
      task.finalStatus === undefined ||
      task.replyEnqueuedAt !== undefined)
  )
    throw new Error(`V3 回复等待状态非法：${task.taskId}`);
}
function validInitialQueue(task: TaskSnapshotV3): boolean {
  return (
    task.status === 'pending' &&
    task.frontend.initialStartedAt === undefined &&
    task.worker === undefined &&
    task.finalReply === undefined
  );
}
function validateWorkerPhase(task: TaskSnapshotV3): void {
  if (!['worker-waiting', 'summary-queued', 'summary-running'].includes(task.phase)) return;
  if (!task.worker) throw new Error(`V3 worker 阶段缺少交接：${task.taskId}`);
  if (task.phase === 'worker-waiting') {
    if (task.worker.result) throw new Error(`V3 等待 worker 已有结果：${task.taskId}`);
    return;
  }
  if (!validSummaryResultVersion(task)) throw new Error(`V3 整理结果版本非法：${task.taskId}`);
  validateSummaryAttempt(task);
  if (
    task.phase === 'summary-running' &&
    (!isActiveSummary(task, task.frontend.summaryJob.jobId) ||
      task.frontend.initialEndedAt === undefined)
  )
    throw new Error(`V3 整理执行状态非法：${task.taskId}`);
}
function validateSummaryAttempt(task: TaskSnapshotV3): void {
  const frontend = task.frontend;
  if (
    task.phase === 'summary-queued' &&
    (frontend.summaryAttempts >= 2 ||
      frontend.summaryJob?.jobId !== `${task.taskId}:summary:${frontend.summaryAttempts + 1}`)
  )
    throw new Error(`V3 整理次数非法：${task.taskId}`);
  if (
    task.phase === 'summary-running' &&
    frontend.summaryJob?.jobId !== `${task.taskId}:summary:${frontend.summaryAttempts}`
  )
    throw new Error(`V3 当前整理次数非法：${task.taskId}`);
}
function validSummaryResultVersion(
  task: TaskSnapshotV3
): task is TaskSnapshotV3 & { frontend: TaskSnapshotV3['frontend'] & { summaryJob: TaskJobV3 } } {
  return (
    task.worker?.result !== undefined &&
    task.frontend.summaryJob?.resultVersion === task.worker.resultVersion
  );
}
function validJob(value: unknown): value is TaskJobV3 {
  if (!isRecord(value) || !validStringFields(value, ['jobId', 'taskId', 'sessionKey']))
    return false;
  return (
    ['frontend', 'worker', 'summary'].includes(String(value.kind)) &&
    validTime(value.createdAt) &&
    validTime(value.deadlineAt) &&
    value.deadlineAt >= value.createdAt &&
    validOptional(value, 'resultVersion', validSequence)
  );
}
function validSummaryJob(job: TaskJobV3, taskId: string): boolean {
  return (
    job.kind === 'summary' &&
    [1, 2].some((attempt) => job.jobId === `${taskId}:summary:${attempt}`) &&
    validSequence(job.resultVersion)
  );
}
function validExecution(value: unknown): value is JobExecutionV3 {
  return (
    isRecord(value) &&
    ['jobId', 'executionId', 'runtimeGeneration', 'sessionId'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0
    )
  );
}
function validFailure(value: unknown): value is ContractFailure {
  return (
    isRecord(value) &&
    [
      'INVALID_INPUT',
      'NOT_FOUND',
      'STALE_DATA',
      'PERSISTENCE_FAILED',
      'UPSTREAM_FAILED',
      'TIMEOUT',
      'CANCELLED',
      'CLOSED',
      'CONFLICT',
      'UNKNOWN_OUTCOME',
    ].includes(String(value.code)) &&
    ['safe', 'never', 'after-change'].includes(String(value.retry)) &&
    (value.errorId === undefined || typeof value.errorId === 'string')
  );
}
function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function validSequence(value: unknown, minimum = 1): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function validOptionalTimes(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => value[field] === undefined || validTime(value[field]));
}
function validStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function validAttachmentReference(value: unknown): value is AttachmentReference {
  return (
    isRecord(value) &&
    ['id', 'name', 'path'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0
    ) &&
    validAbsolutePath(value.path) &&
    (value.mime === undefined || typeof value.mime === 'string')
  );
}
function validOutgoingAttachment(value: unknown): boolean {
  return (
    isRecord(value) &&
    ['image', 'file'].includes(String(value.kind)) &&
    validAbsolutePath(value.absPath) &&
    validFileName(value.fileName) &&
    validNonnegativeInteger(value.sizeBytes)
  );
}
function validAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0');
}
function validFileName(value: unknown): boolean {
  return (
    validNonemptyString(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}
function validInput(value: unknown): value is TaskInput {
  if (!isRecord(value)) return false;
  return (
    ['user', 'proactive'].includes(String(value.source)) &&
    typeof value.isAdmin === 'boolean' &&
    validSequence(value.generation) &&
    validMessage(value.message) &&
    validReference(value.reference) &&
    validInputContext(value.context) &&
    validInputOptions(value)
  );
}
function validInputOptions(value: Record<string, unknown>): boolean {
  return (
    validOptionalStrings(value, ['followUpOf', 'retryOf']) &&
    validOptionalBooleans(value, ['progressOnly']) &&
    validOptional(value, 'proactive', validProactiveInput) &&
    validOptional(value, 'trace', validTrace)
  );
}
function validMessage(value: unknown): value is NormalizedMessage {
  if (!isRecord(value) || !isRecord(value.target) || !isRecord(value.raw)) return false;
  const target = value.target;
  return (
    ['group-at-message', 'c2c-message', 'group-message'].includes(String(value.kind)) &&
    validMessageTarget(target, value.kind) &&
    validStringFields(value, ['eventId', 'msgId', 'senderId', 'content']) &&
    validTime(value.ts) &&
    validOptionalStrings(value, ['username']) &&
    validOptional(value, 'parts', validMessageParts)
  );
}
function validMessageTarget(target: Record<string, unknown>, kind: unknown): boolean {
  return (
    ['platform', 'key', 'id'].every((key) => validNonemptyString(target[key])) &&
    target.kind === (kind === 'c2c-message' ? 'c2c' : 'group')
  );
}
function validReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    validStringFields(value, ['excerpt', 'senderId']) &&
    validTime(value.ts) &&
    validOptionalStrings(value, ['messageId', 'senderName'])
  );
}
function validInputContext(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.replay === 'string' &&
    Array.isArray(value.window) &&
    value.window.every(validObservation) &&
    validOptionalBooleans(value, ['mentionsChatRecord'])
  );
}
function validObservation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    validStringFields(value, ['msgId', 'eventId', 'senderId', 'text']) &&
    validTime(value.ts) &&
    typeof value.addressed === 'boolean' &&
    validObservationOptions(value)
  );
}
function validObservationOptions(value: Record<string, unknown>): boolean {
  return (
    validOptionalBooleans(value, ['isBot']) &&
    validOptionalStrings(value, ['senderName', 'taskId']) &&
    validOptional(value, 'reference', validReference) &&
    validOptional(value, 'recordIds', validStrings) &&
    validOptional(value, 'media', validObservationMedia) &&
    validOptional(value, 'lane', validLegacyLaneName)
  );
}
function validObservationMedia(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.images) &&
    value.images.every(
      (item) => isRecord(item) && item.type === 'image' && validMessagePart(item)
    ) &&
    Array.isArray(value.files) &&
    value.files.every((item) => isRecord(item) && item.type === 'media' && validMessagePart(item))
  );
}
function validMessageParts(value: unknown): value is MessagePart[] {
  return Array.isArray(value) && value.every(validMessagePart);
}
function validMessagePart(value: unknown): value is MessagePart {
  if (!isRecord(value)) return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (['quote', 'forward'].includes(String(value.type))) return validStructuredMessagePart(value);
  return validMediaMessagePart(value);
}
function validStructuredMessagePart(value: Record<string, unknown>): boolean {
  return (
    validMessageParts(value.parts) &&
    validOptionalStrings(value, ['author', 'title', 'refId']) &&
    validOptional(value, 'nodeCount', validNonnegativeInteger) &&
    validOptionalBooleans(value, ['truncated'])
  );
}
function validMediaMessagePart(value: Record<string, unknown>): boolean {
  if (!['image', 'voice', 'media'].includes(String(value.type))) return false;
  if (!validOptionalStrings(value, ['url', 'fileId', 'mimeType', 'filename', 'text'])) return false;
  if (
    !validOptional(value, 'width', validSequence) ||
    !validOptional(value, 'height', validSequence) ||
    !validOptional(value, 'sizeBytes', validNonnegativeInteger)
  )
    return false;
  return value.type !== 'media' || ['video', 'file', 'unknown'].includes(String(value.mediaKind));
}
function validWorkerSnapshot(value: unknown, taskId: string, input: TaskInput): boolean {
  if (
    !isRecord(value) ||
    !validWorkerReceipt(value.receipt, taskId) ||
    !validWorkerHandoff(value.handoff, input)
  )
    return false;
  if (
    value.assignmentKey !== canonicalDispatch(value.handoff.assignment) ||
    !validSequence(value.resultVersion, 0) ||
    !validOptionalTimes(value, ['startedAt', 'endedAt'])
  )
    return false;
  if (
    value.execution !== undefined &&
    (!validExecution(value.execution) || value.execution.jobId !== value.receipt.jobId)
  )
    return false;
  return validWorkerCompletion(value, value.receipt);
}
function validWorkerReceipt(value: unknown, taskId: string): value is WorkerReceipt {
  return (
    isRecord(value) &&
    value.workerId === `${taskId}:worker` &&
    value.jobId === `${taskId}:worker:1` &&
    validTime(value.acceptedAt) &&
    validTime(value.deadlineAt) &&
    value.deadlineAt >= value.acceptedAt &&
    WORKER_STATUSES.has(String(value.status))
  );
}
function validWorkerHandoff(value: unknown, input: TaskInput): value is WorkerHandoff {
  if (!isRecord(value) || !validAssignment(value.assignment) || !validInput(value.originalInput))
    return false;
  return (
    canonicalDispatch(value.originalInput) === canonicalDispatch(input) &&
    validWorkerHandoffFields({
      attachments: value.attachments,
      constraints: value.constraints,
      controlOperations: value.controlOperations,
    }) &&
    Buffer.byteLength(canonicalDispatch(value)) <= MAX_HANDOFF_BYTES
  );
}
function validWorkerHandoffFields(value: {
  attachments: unknown;
  constraints: unknown;
  controlOperations: unknown;
}): boolean {
  return (
    Array.isArray(value.attachments) &&
    value.attachments.every(validAttachmentReference) &&
    validStrings(value.constraints) &&
    validStrings(value.controlOperations)
  );
}
function validWorkerCompletion(value: Record<string, unknown>, receipt: WorkerReceipt): boolean {
  if (value.result !== undefined)
    return (
      validWorkerResult(value.result) &&
      value.result.status === receipt.status &&
      validSequence(value.resultVersion) &&
      value.endedAt !== undefined
    );
  if (receipt.status === 'queued') return validQueuedWorker(value);
  return (
    receipt.status === 'running' &&
    value.resultVersion === 0 &&
    value.startedAt !== undefined &&
    value.endedAt === undefined
  );
}
function validQueuedWorker(value: Record<string, unknown>): boolean {
  return (
    value.resultVersion === 0 &&
    value.startedAt === undefined &&
    value.execution === undefined &&
    value.endedAt === undefined
  );
}
function validTrace(value: unknown): boolean {
  if (!isRecord(value) || !validStringFields(value, ['traceId', 'spanId'])) return false;
  return (
    validOptionalStrings(value, [
      'parentSpanId',
      'sessionKey',
      'inputMessageId',
      'inputEventId',
      'taskId',
      'executionId',
      'runtimeGeneration',
      'dshSessionId',
      'messageId',
    ]) &&
    validOptionalBooleans(value, ['historicalTraceMissing']) &&
    validOptional(value, 'lane', validLegacyLaneName)
  );
}
function validLegacyLaneName(value: unknown): boolean {
  return value === 'fast' || value === 'slow';
}
function validProactiveInput(value: unknown): boolean {
  return (
    isRecord(value) &&
    validStringFields(value, ['directive', 'scene', 'budgetScope']) &&
    validOptionalStrings(value, ['evidence'])
  );
}
function validNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function validNonnegativeInteger(value: unknown): value is number {
  return validSequence(value, 0);
}
function validStringFields(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === 'string');
}
function validOptionalStrings(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => validOptional(value, field, (item) => typeof item === 'string'));
}
function validOptionalBooleans(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => validOptional(value, field, (item) => typeof item === 'boolean'));
}
function validOptional(
  value: Record<string, unknown>,
  field: string,
  predicate: (item: unknown) => boolean
): boolean {
  return value[field] === undefined || predicate(value[field]);
}
function validateLegacyTaskRecord(
  record: Record<string, unknown>
): asserts record is Record<string, unknown> & LegacyTaskInterruptionV3 {
  if (
    record.schemaVersion !== undefined &&
    record.schemaVersion !== 1 &&
    record.schemaVersion !== 2
  )
    throw new Error('无法读取未知版本 Task 持久记录');
  if (
    !validNonemptyString(record.taskId) ||
    !validInput(record.input) ||
    !isRecord(record.lanes) ||
    !STATUSES.has(String(record.status))
  )
    throw new Error('无法读取旧 Task 持久记录');
}

function terminalCauseKind(task: TaskSnapshotV3): string | undefined {
  const cause = taskFailure(task)?.cause;
  return isRecord(cause) && typeof cause.kind === 'string' ? cause.kind : undefined;
}

function existingWorkerReceipt(
  worker: WorkerSnapshotV3,
  assignmentKey: string
): Result<WorkerReceipt> {
  return worker.assignmentKey === assignmentKey
    ? { ok: true, value: structuredClone(worker.receipt) }
    : { ok: false, error: failure('CONFLICT', worker.receipt.workerId) };
}
function terminalFailureMetadata(task: TaskSnapshotV3): Record<string, unknown> {
  const error = taskFailure(task);
  return {
    code: error?.code,
    retry: error?.retry,
    errorId: error?.errorId,
    causeKind: terminalCauseKind(task),
  };
}
function validBusinessText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
