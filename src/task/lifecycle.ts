import type { DeepReadonly } from '@qqbot/contracts';
import { TaskAdmissionError } from '@qqbot/contracts';
/**
 * Task 执行状态的唯一写入者：准入、lane 转移、整体终态、恢复和保留期清理。
 * 状态先持久化再通知观察者；观察者失败不阻止 done 结算。
 * runtime 终止、产物发送和文件清理由其他模块执行。
 */
import { randomUUID } from 'node:crypto';
import {
  createTrace,
  createNullLogger,
  traceSpan,
  legacyTrace,
  errorClass,
} from '../observability/index.js';
import type { Logger, TraceContext } from '@qqbot/contracts';
import type { TaskStateWriter } from '@qqbot/contracts';
import { LANES, isLaneTerminal, isTaskTerminal, readonlySnapshot } from '@qqbot/contracts';
import type {
  Lane,
  LaneExecution,
  LaneResult,
  TaskHandle,
  TaskInput,
  TaskSnapshot,
} from '@qqbot/contracts';

export { TaskAdmissionError } from '@qqbot/contracts';
export class TaskLifeCycleManager {
  private readonly tasks = new Map<string, TaskSnapshot>();
  private readonly completions = new Map<
    string,
    { done: TaskHandle['done']; resolve: (t: DeepReadonly<TaskSnapshot>) => void }
  >();
  private readonly listeners = new Set<(task: DeepReadonly<TaskSnapshot>) => void>();
  private nextSequence = 0;
  constructor(
    private readonly options: {
      store?: TaskStateWriter;
      now?: () => number;
      maxPerSession?: number;
      maxGlobal?: number;
      retentionMs?: number;
      logger?: Logger;
      idFactory?: () => string;
    } = {}
  ) {
    for (const task of structuredClone(options.store?.load() ?? [])) {
      task.input.trace ??= legacyTrace(task.taskId, task.input.message.target.key);
      for (const lane of LANES)
        task.lanes[lane].trace ??= traceSpan(
          task.input.trace,
          { lane },
          () => `${task.taskId}:${lane}:legacy`
        );
      task.creationSequence ??= this.nextSequence + 1;
      this.nextSequence = Math.max(this.nextSequence, task.creationSequence);
      this.tasks.set(task.taskId, task);
    }
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  onChange(listener: (task: DeepReadonly<TaskSnapshot>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** 按未完成 Task 计数，两个 lane 共用一次准入，不消耗两份名额。 */
  assertAdmission(sessionKey: string): void {
    const pending = [...this.tasks.values()].filter((t) => !isTaskTerminal(t));
    if (
      pending.length >= (this.options.maxGlobal ?? 128) ||
      pending.filter((t) => t.input.message.target.key === sessionKey).length >=
        (this.options.maxPerSession ?? 32)
    ) {
      throw new TaskAdmissionError('未完成任务已达上限，请稍后再试。');
    }
  }
  /** 同步创建双 lane 初态；落盘失败时不留下可调度的半成品 Task。 */
  create(
    input: TaskInput,
    taskId: string = this.options.idFactory?.() ?? randomUUID()
  ): TaskHandle {
    this.assertAdmission(input.message.target.key);
    if (this.tasks.has(taskId)) throw new Error('Task ID 已存在');
    const task: TaskSnapshot = {
      taskId,
      input: structuredClone({
        ...input,
        trace: traceSpan(
          input.trace ??
            createTrace(
              {
                sessionKey: input.message.target.key,
                inputMessageId: input.message.msgId,
                inputEventId: input.message.eventId,
              },
              this.options.idFactory
            ),
          { taskId },
          this.options.idFactory
        ),
      }),
      createdAt: this.now(),
      creationSequence: this.nextSequence + 1,
      status: 'pending',
      cancelAccepted: false,
      lanes: { fast: { status: 'queued' }, slow: { status: 'queued' } },
    };
    for (const lane of LANES)
      task.lanes[lane].trace = traceSpan(
        task.input.trace ?? legacyTrace(taskId),
        { lane },
        this.options.idFactory
      );
    this.persistTask(task);
    this.nextSequence = task.creationSequence;
    const completion = this.completion(taskId);
    this.logAdmission(task);
    this.publish(task);
    return { taskId, done: completion.done };
  }
  get(taskId: string): DeepReadonly<TaskSnapshot> | undefined {
    const task = this.tasks.get(taskId);
    return task && readonlySnapshot(task);
  }
  list(sessionKey?: string): DeepReadonly<TaskSnapshot[]> {
    return readonlySnapshot(
      [...this.tasks.values()].filter(
        (t) => !sessionKey || t.input.message.target.key === sessionKey
      )
    );
  }
  handle(taskId: string): TaskHandle {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Task 不存在');
    return {
      taskId,
      done: isTaskTerminal(task)
        ? Promise.resolve(readonlySnapshot(task))
        : this.completion(taskId).done,
    };
  }
  start(taskId: string, lane: Lane, execution?: LaneExecution): boolean {
    const task = this.candidate(taskId);
    if (!task || task.cancelAccepted || task.lanes[lane].status !== 'queued') return false;
    task.lanes[lane] = {
      ...task.lanes[lane],
      status: 'running',
      startedAt: this.now(),
      execution: execution && { ...execution },
    };
    if (execution) task.lanes[lane].trace = this.executionTrace(task, lane, execution);
    task.status = 'running';
    this.commit(task, () => {
      this.log(task, lane).event('task.lane', { status: 'running' });
    });
    return true;
  }
  bindExecution(taskId: string, lane: Lane, execution: LaneExecution): boolean {
    const task = this.candidate(taskId);
    if (!task || task.cancelAccepted || task.lanes[lane].status !== 'running') return false;
    task.lanes[lane].execution = { ...execution };
    task.lanes[lane].trace = this.executionTrace(task, lane, execution);
    this.commit(task);
    return true;
  }
  /** 拒绝已取消、旧 runtime 或旧执行的迟到事件。 */
  matches(taskId: string, lane: Lane, execution: LaneExecution): boolean {
    if (this.tasks.get(taskId)?.cancelAccepted) return false;
    const state = this.tasks.get(taskId)?.lanes[lane];
    return (
      state?.status === 'running' &&
      state.execution?.executionId === execution.executionId &&
      state.execution.runtimeGeneration === execution.runtimeGeneration &&
      state.execution.sessionId === execution.sessionId
    );
  }
  /** 区分执行结束与产物收尾，供 /stop 和存活提醒判断实际执行是否仍在继续。 */
  endExecution(taskId: string, lane: Lane): void {
    const task = this.candidate(taskId);
    if (
      !task ||
      task.lanes[lane].status !== 'running' ||
      task.lanes[lane].executionEndedAt !== undefined
    )
      return;
    task.lanes[lane].executionEndedAt = this.now();
    this.commit(task);
  }
  /** lane 终态幂等；双终结后按取消、失败、完成的优先级结算整体状态。 */
  finish(taskId: string, lane: Lane, result: LaneResult): void {
    const task = this.candidate(taskId);
    if (!task || isLaneTerminal(task.lanes[lane])) return;
    const state = task.lanes[lane];
    state.result = structuredClone(result);
    state.endedAt = this.now();
    state.status = 'completed';
    if (result.kind === 'failed') state.status = 'failed';
    else if (result.kind === 'cancelled') state.status = 'cancelled';
    if (LANES.every((l) => isLaneTerminal(task.lanes[l]))) {
      if (task.cancelAccepted) task.status = 'cancelled';
      else if (LANES.some((l) => task.lanes[l].status === 'failed')) task.status = 'failed';
      else task.status = 'completed';
      task.endedAt = this.now();
    }
    this.commit(task, () => {
      this.logLane(task, lane, result);
    });
    if (isTaskTerminal(task)) {
      this.completions.get(taskId)?.resolve(readonlySnapshot(task));
      this.completions.delete(taskId);
    }
  }
  /** 只记录接受取消；Actor / 调度器随后终止剩余执行并提交各 lane 的结果。 */
  cancel(
    taskId: string,
    initiator?: TraceContext
  ): { accepted: boolean; task?: DeepReadonly<TaskSnapshot> } {
    const task = this.candidate(taskId);
    if (!task || isTaskTerminal(task))
      return { accepted: false, task: task && readonlySnapshot(task) };
    if (task.cancelAccepted) return { accepted: true, task: readonlySnapshot(task) };
    task.cancelAccepted = true;
    this.commit(task);
    this.log(task).event('task.cancel', {
      initiatorTraceId: initiator?.traceId,
      initiatorSpanId: initiator?.spanId,
      initiatorTaskId: initiator?.taskId,
    });
    return { accepted: true, task: readonlySnapshot(task) };
  }
  /** 冷启动不重跑执行；保留已终结 lane，仅将未完成 lane 标为中断失败。 */
  recover(): DeepReadonly<TaskSnapshot[]> {
    const interrupted = this.list().filter((t) => !isTaskTerminal(t));
    for (const task of interrupted)
      for (const lane of LANES)
        if (!isLaneTerminal(task.lanes[lane])) {
          this.finish(task.taskId, lane, {
            kind: 'failed',
            text: '任务因服务重启而中断，请重新提交。',
            error: 'restart-interrupted',
          });
        }
    return readonlySnapshot(
      interrupted.flatMap((t) => {
        const current = this.get(t.taskId);
        return current === undefined ? [] : [current];
      })
    );
  }
  destroy(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !isTaskTerminal(task)) return false;
    const next = new Map(this.tasks);
    next.delete(taskId);
    this.options.store?.save(structuredClone([...next.values()]));
    this.tasks.delete(taskId);
    return true;
  }
  /** 返回到期快照供装配层清理工作区；不触碰独立的消息队列及附件副本。 */
  prune(): DeepReadonly<TaskSnapshot[]> {
    const cutoff = this.now() - (this.options.retentionMs ?? 7 * 86400_000);
    const expired = [...this.tasks.values()].filter(
      (task) => isTaskTerminal(task) && (task.endedAt ?? task.createdAt) < cutoff
    );
    if (expired.length) this.removeExpired(expired);
    return readonlySnapshot(expired);
  }
  private completion(id: string) {
    let value = this.completions.get(id);
    if (!value) {
      let resolve!: (t: DeepReadonly<TaskSnapshot>) => void;
      const done = new Promise<DeepReadonly<TaskSnapshot>>((r) => {
        resolve = r;
      });
      value = { done, resolve };
      this.completions.set(id, value);
    }
    return value;
  }
  private logAdmission(task: TaskSnapshot): void {
    this.log(task).event('task.created', {
      source: task.input.source,
      generation: task.input.generation,
    });
    for (const lane of LANES) this.log(task, lane).event('task.lane', { status: 'queued' });
  }
  private logLane(task: TaskSnapshot, lane: Lane, result: LaneResult): void {
    const fields =
      result.kind === 'failed'
        ? { errorId: result.errorId, errorClass: errorClass(result.error) }
        : {};
    this.log(task, lane).event('task.lane', {
      status: task.lanes[lane].status,
      resultKind: result.kind,
      ...fields,
    });
    if (isTaskTerminal(task))
      this.log(task).event('task.terminal', {
        status: task.status,
        durationMs: this.now() - task.createdAt,
      });
  }
  private commit(task: TaskSnapshot, record?: () => void): void {
    this.persistTask(task);
    record?.();
    this.publish(task);
  }
  private publish(task: TaskSnapshot): void {
    for (const fn of this.listeners) {
      try {
        fn(readonlySnapshot(task));
      } catch (error) {
        this.options.logger?.error('Task 状态观察者失败', {
          taskId: task.taskId,
          error: String(error),
        });
      }
    }
  }
  private executionTrace(task: TaskSnapshot, lane: Lane, execution: LaneExecution): TraceContext {
    return traceSpan(
      task.lanes[lane].trace ?? task.input.trace ?? legacyTrace(task.taskId),
      {
        executionId: execution.executionId,
        runtimeGeneration: execution.runtimeGeneration,
        dshSessionId: execution.sessionId,
      },
      this.options.idFactory
    );
  }
  private log(task: TaskSnapshot, lane?: Lane): Logger {
    return (this.options.logger ?? createNullLogger()).withTrace(
      (lane && task.lanes[lane].trace) || task.input.trace || legacyTrace(task.taskId)
    );
  }
  private candidate(taskId: string): TaskSnapshot | undefined {
    const task = this.tasks.get(taskId);
    return task === undefined ? undefined : structuredClone(task);
  }
  private persistTask(task: TaskSnapshot): void {
    const next = new Map(this.tasks);
    next.set(task.taskId, task);
    this.options.store?.save(structuredClone([...next.values()]));
    this.tasks.set(task.taskId, task);
  }
  private removeExpired(expired: TaskSnapshot[]): void {
    const next = new Map(this.tasks);
    for (const task of expired) next.delete(task.taskId);
    this.options.store?.save(structuredClone([...next.values()]));
    for (const task of expired) this.tasks.delete(task.taskId);
  }
}
