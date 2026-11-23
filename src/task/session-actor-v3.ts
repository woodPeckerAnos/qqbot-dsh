import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SESSION_CONTEXT,
  failure,
  isTaskTerminal,
  readonlySnapshot,
} from '@qqbot/contracts';
import type {
  ContractFailure,
  DeepReadonly,
  MessageContext,
  Result,
  SessionActorV3 as ActorContract,
  SessionContextState,
  SessionEvent,
  TaskHandleV3,
  TaskInput,
  TaskJobOutcomeV3,
  TaskJobV3,
  TaskSnapshotV3,
  TraceContext,
  createSessionActorFactoryV3,
} from '@qqbot/contracts';
import { classifyTaskFollowUpV3 } from '../session/index.js';
import { createTrace } from '../observability/index.js';

/** 只串行输入判定与准入，整轮执行和消息发送均在队列之外。 */
class SessionInputQueue {
  private readonly pending = new Map<string, Promise<void>>();
  async run<T>(sessionKey: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.set(sessionKey, completion);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.pending.get(sessionKey) === completion) this.pending.delete(sessionKey);
    }
  }
}

/** 事件唤醒与维护都扫描已保存状态，工作领取只通过管理器。 */
export class SessionActorV3 implements ActorContract {
  private readonly generations = new Map<string, { generation: number; sinceTs: number }>();
  private readonly inputs = new SessionInputQueue();
  private readonly contexts = new Map<string, MessageContext>();
  private readonly enqueuing = new Map<string, Promise<void>>();
  private readonly unsubscribers: (() => void)[];
  private closed = false;
  private wakeScheduled = false;
  private summaryFailures = 0;
  constructor(private readonly options: Parameters<createSessionActorFactoryV3>[0]) {
    for (const state of options.sessions?.load() ?? []) {
      if (!validSessionState(state)) throw new Error('Session 持久记录非法');
      if (this.generations.has(state.sessionKey))
        throw new Error(`Session 持久记录重复：${state.sessionKey}`);
      this.generations.set(state.sessionKey, structuredClone(state));
    }
    this.unsubscribers = [
      options.manager.onEvent((event) => {
        this.notify(event);
      }),
      options.manager.onChange((task) => {
        if (isTaskTerminal(task)) {
          this.options.output.reconcile(task.taskId);
          this.contexts.delete(task.taskId);
          this.options.preparer.release(task.taskId);
        }
        this.scheduleWake();
      }),
    ];
  }
  generation(sessionKey: string): number {
    return this.generations.get(sessionKey)?.generation ?? 1;
  }
  sinceTs(sessionKey: string): number {
    return this.generations.get(sessionKey)?.sinceTs ?? 0;
  }
  async submit(
    context: MessageContext,
    proactive?: TaskInput['proactive'],
    budgetLimit?: number
  ): Promise<TaskHandleV3> {
    const trace =
      context.trace ??
      createTrace({
        sessionKey: context.message.target.key,
        inputMessageId: context.message.msgId,
        inputEventId: context.message.eventId,
      });
    context = {
      ...context,
      trace,
      logger: context.logger.withTrace(trace),
      message: structuredClone(context.message),
    };
    const key = context.message.target.key;
    const trigger = this.generations.get(key) ?? { generation: 1, sinceTs: 0 };
    const frozen = proactive
      ? {
          generation: trigger.generation,
          context: this.options.preparer.capture(context.message, trigger.sinceTs),
        }
      : undefined;
    return this.inputs.run(key, () => this.admitTask(context, { proactive, budgetLimit, frozen }));
  }
  cancel(taskId: string, initiator?: TraceContext): boolean {
    const cancelled = this.options.manager.cancel(taskId, initiator);
    if (!cancelled.ok) throw actorFailure(cancelled.error);
    if (cancelled.value) this.cancelExecution(taskId);
    return cancelled.value;
  }
  cancelExecution(taskId: string): void {
    this.options.schedulers.frontend.cancel(taskId);
    this.options.schedulers.worker.cancel(taskId);
  }
  stop(sessionKey: string, initiator?: TraceContext): number {
    const tasks = this.options.manager
      .list(sessionKey)
      .filter((task) => !isTaskTerminal(task) && task.frontend.initialStartedAt !== undefined);
    for (const task of tasks) this.cancel(task.taskId, initiator);
    return tasks.length;
  }
  reset(sessionKey: string, initiator?: TraceContext): number {
    this.saveGeneration(sessionKey, {
      generation: this.generation(sessionKey) + 1,
      sinceTs: this.options.clock?.now() ?? Date.now(),
    });
    const tasks = this.options.manager.list(sessionKey).filter((task) => !isTaskTerminal(task));
    for (const task of tasks) this.cancel(task.taskId, initiator);
    return tasks.length;
  }
  notify(event: DeepReadonly<SessionEvent>): void {
    const task = this.options.manager.get(event.taskId);
    if (!task || task.cancelAccepted) return;
    if (event.type === 'worker-accepted' && task.worker?.receipt.jobId === event.jobId)
      this.options.output.acknowledge(task, task.worker.receipt);
    if (
      event.type === 'worker-finished' &&
      (task.worker?.receipt.jobId !== event.jobId ||
        task.worker.resultVersion !== event.resultVersion)
    )
      return;
    this.scheduleWake();
  }
  snapshot() {
    const frontend = this.options.schedulers.frontend.snapshot();
    const worker = this.options.schedulers.worker.snapshot();
    return readonlySnapshot({
      frontend,
      worker,
      fast: frontend,
      slow: worker,
      unfinished: this.options.manager.list().filter((task) => !isTaskTerminal(task)).length,
      handoffFailures: this.options.manager.handoffFailureCount(),
      summaryFailures: this.summaryFailures,
    });
  }
  flushSettlements(): void {
    this.options.schedulers.frontend.flushSettlements();
    this.options.schedulers.worker.flushSettlements();
    const expired = this.options.manager.expire();
    if (!expired.ok) throw actorFailure(expired.error);
    for (const task of this.options.manager.list()) this.options.output.reconcile(task.taskId);
    this.scheduleWake();
  }
  recover(): Result<void> {
    const recovered = this.options.manager.recover();
    if (!recovered.ok) return recovered;
    try {
      this.flushSettlements();
    } catch (cause) {
      return { ok: false, error: failure('PERSISTENCE_FAILED', cause) };
    }
    return { ok: true, value: undefined };
  }
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribers.forEach((unsubscribe) => {
      unsubscribe();
    });
    for (const task of this.options.manager.list())
      if (!isTaskTerminal(task)) this.cancel(task.taskId);
    await Promise.all([
      this.options.schedulers.frontend.close(),
      this.options.schedulers.worker.close(),
    ]);
    await Promise.all([...this.enqueuing.values()]);
    this.contexts.clear();
  }
  private scheduleWake(): void {
    if (this.closed || this.wakeScheduled) return;
    this.wakeScheduled = true;
    queueMicrotask(() => {
      this.wakeScheduled = false;
      if (this.closed) return;
      this.enqueuePendingJobs();
      for (const task of this.options.manager.list())
        if (task.phase === 'reply-pending' && task.finalReply && !task.cancelAccepted)
          this.enqueueReply(task);
    });
  }
  private async admitTask(
    context: MessageContext,
    request: {
      proactive?: TaskInput['proactive'];
      budgetLimit?: number;
      frozen?: { generation: number; context: TaskInput['context'] };
    }
  ): Promise<TaskHandleV3> {
    this.assertOpen(context.message.target.key);
    const admitted = this.options.manager.assertAdmission(context.message.target.key);
    if (!admitted.ok) throw actorFailure(admitted.error);
    const input = await this.saveAdmissionInput(context, request);
    this.assertOpen(context.message.target.key);
    const taskId = this.options.taskIdFactory?.() ?? randomUUID();
    if (
      request.proactive &&
      !this.options.budget.reserve(taskId, request.proactive.budgetScope, request.budgetLimit ?? 1)
    )
      throw actorFailure(failure('CONFLICT', '主动 Task 预算已耗尽'));
    const created = this.options.manager.create(input, taskId);
    if (!created.ok) {
      this.options.budget.settle(taskId, false, true);
      throw actorFailure(created.error);
    }
    this.contexts.set(taskId, context);
    this.scheduleWake();
    return created.value;
  }
  private async saveAdmissionInput(
    context: MessageContext,
    request: {
      proactive?: TaskInput['proactive'];
      frozen?: { generation: number; context: TaskInput['context'] };
    }
  ): Promise<TaskInput> {
    const key = context.message.target.key;
    const generation = this.generations.get(key) ?? { generation: 1, sinceTs: 0 };
    let captured = this.options.preparer.capture(context.message, generation.sinceTs);
    const verdict = request.proactive
      ? { related: true, mentionsChatRecord: false }
      : await this.options.preparer.judge(context.message, captured);
    context.logger.event('input.decision', {
      related: verdict.related,
      mentionsChatRecord: verdict.mentionsChatRecord,
    });
    let current = this.generations.get(key) ?? generation;
    const followUp = this.classifyFollowUp(context, {
      proactive: request.proactive,
      generation,
      current,
    });
    if (!request.proactive && !verdict.related && !followUp.followUpOf && current === generation)
      current = { generation: generation.generation + 1, sinceTs: context.message.ts };
    if (!request.proactive) this.saveGeneration(key, current);
    if (current !== generation)
      captured = this.options.preparer.capture(context.message, current.sinceTs);
    return createAdmissionInput(context, {
      followUp,
      generation: current.generation,
      captured,
      proactive: request.proactive,
      frozen: request.frozen,
      mentionsChatRecord: verdict.mentionsChatRecord,
    });
  }
  private assertOpen(sessionKey: string): void {
    if (this.closed) throw actorFailure(failure('CLOSED', sessionKey));
  }
  private classifyFollowUp(
    context: MessageContext,
    request: {
      proactive?: TaskInput['proactive'];
      generation: Pick<SessionContextState, 'generation' | 'sinceTs'>;
      current: Pick<SessionContextState, 'generation' | 'sinceTs'>;
    }
  ) {
    const settings = { ...DEFAULT_SESSION_CONTEXT, ...this.options.sessionContext };
    if (settings.mode === 'off' || request.current !== request.generation || request.proactive)
      return {};
    const followUp = classifyTaskFollowUpV3({
      message: context.message,
      generation: request.current.generation,
      tasks: this.options.manager.list(context.message.target.key),
      now: this.options.clock?.now() ?? Date.now(),
      recentTaskWindowMs: settings.recentTaskWindowMs,
    });
    return {
      followUpOf: followUp.followUpOf,
      progressOnly: settings.progressGuard ? followUp.progressOnly : undefined,
    };
  }
  private enqueuePendingJobs(): void {
    for (const job of this.options.manager.pendingJobs()) {
      const scheduler =
        job.kind === 'worker' ? this.options.schedulers.worker : this.options.schedulers.frontend;
      scheduler.enqueue({
        job,
        run: async (signal) => {
          const claimed = this.options.manager.claimJob(job.jobId);
          if (!claimed.ok) return { kind: job.kind, result: claimed };
          const task = claimed.value;
          const context = this.contexts.get(task.taskId) ?? this.options.context(task);
          if (job.kind === 'frontend')
            return {
              kind: 'frontend',
              result: await this.options.runner.runFrontend(task, job, context, signal),
            };
          if (job.kind === 'worker')
            return {
              kind: 'worker',
              result: await this.options.runner.runWorker(task, job, context, signal),
            };
          return {
            kind: 'summary',
            result: await this.options.runner.runSummary(task, job, context, signal),
          };
        },
        settle: (outcome) => this.saveJobOutcome(job, outcome),
      });
    }
  }
  private saveJobOutcome(job: DeepReadonly<TaskJobV3>, outcome: TaskJobOutcomeV3): Result<void> {
    const task = this.options.manager.get(job.taskId);
    if (!task || task.cancelAccepted || isTaskTerminal(task)) return { ok: true, value: undefined };
    // 领取落盘失败未开始执行；等维护重新入队，不将存储故障变成业务失败。
    if (jobClaimSaveFailed(task, job, outcome)) return { ok: true, value: undefined };
    if (outcome.kind === 'frontend') {
      return this.options.manager.finishFrontend(job.taskId, job.jobId, outcome.result);
    }
    if (outcome.kind === 'worker')
      return this.options.manager.saveWorkerResult(job.taskId, job.jobId, outcome.result);
    const saved = this.options.manager.saveFinalReply(job.taskId, job.jobId, outcome.result);
    if (saved.ok && !outcome.result.ok) this.summaryFailures++;
    return saved;
  }
  private enqueueReply(task: DeepReadonly<TaskSnapshotV3>): void {
    if (this.enqueuing.has(task.taskId) || !task.finalReply) return;
    const reply = task.finalReply;
    const completion = Promise.resolve()
      .then(async () => {
        const current = this.options.manager.get(task.taskId);
        if (!current || current.cancelAccepted || current.replyEnqueuedAt !== undefined) return;
        await this.options.output.accept(current, reply);
        const confirmed = this.options.manager.confirmEnqueued(task.taskId, reply.replyId);
        if (!confirmed.ok) throw actorFailure(confirmed.error);
      })
      .catch((error: unknown) => {
        this.contexts
          .get(task.taskId)
          ?.logger.error('最终回复入队或确认失败', { taskId: task.taskId, error: String(error) });
        // 固定回复保留在管理器；维护只重提相同 replyId。
      })
      .finally(() => {
        this.enqueuing.delete(task.taskId);
      });
    this.enqueuing.set(task.taskId, completion);
  }
  private saveGeneration(sessionKey: string, state: { generation: number; sinceTs: number }): void {
    const next = new Map(this.generations);
    next.set(sessionKey, state);
    try {
      this.options.sessions?.save([...next].map(([key, value]) => ({ sessionKey: key, ...value })));
    } catch (cause) {
      throw actorFailure(failure('PERSISTENCE_FAILED', cause));
    }
    this.generations.set(sessionKey, state);
  }
}
function actorFailure(error: ContractFailure): Error & ContractFailure {
  return Object.assign(new Error(`Task 操作失败：${error.code}`, { cause: error.cause }), error);
}
function validSessionState(value: unknown): value is SessionContextState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.sessionKey === 'string' &&
    state.sessionKey.length > 0 &&
    typeof state.generation === 'number' &&
    Number.isInteger(state.generation) &&
    state.generation >= 1 &&
    typeof state.sinceTs === 'number' &&
    Number.isFinite(state.sinceTs)
  );
}
function createAdmissionInput(
  context: MessageContext,
  request: {
    followUp: { followUpOf?: string; progressOnly?: boolean };
    generation: number;
    captured: TaskInput['context'];
    proactive?: TaskInput['proactive'];
    frozen?: { generation: number; context: TaskInput['context'] };
    mentionsChatRecord: boolean;
  }
): TaskInput {
  return {
    ...request.followUp,
    trace: context.trace,
    message: context.message,
    isAdmin: context.isAdmin,
    source: request.proactive ? 'proactive' : 'user',
    generation: request.frozen?.generation ?? request.generation,
    reference: {
      messageId: context.message.msgId || undefined,
      excerpt: context.message.content.slice(0, 500),
      senderId: context.message.senderId,
      senderName: context.message.username,
      ts: context.message.ts,
    },
    context: {
      ...(request.frozen?.context ?? request.captured),
      mentionsChatRecord: request.mentionsChatRecord,
    },
    proactive: request.proactive,
  };
}
function jobClaimSaveFailed(
  task: DeepReadonly<TaskSnapshotV3>,
  job: DeepReadonly<TaskJobV3>,
  outcome: TaskJobOutcomeV3
): boolean {
  if (outcome.result.ok || outcome.result.error.code !== 'PERSISTENCE_FAILED') return false;
  return job.kind === 'worker'
    ? task.worker?.receipt.status === 'queued'
    : task.frontend.activeJob?.jobId !== job.jobId;
}
