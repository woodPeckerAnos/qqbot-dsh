/**
 * Task 执行状态的唯一写入者：准入、lane 转移、整体终态、恢复和保留期清理。
 * 状态先持久化再通知观察者；观察者失败不阻止 done 结算。
 * runtime 终止、产物发送和文件清理由其他模块执行。
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';
import { TaskStore } from '../store/tasks.js';
import { LANES, isLaneTerminal, isTaskTerminal, readonlySnapshot, type Lane, type LaneExecution, type LaneResult, type TaskHandle, type TaskInput, type TaskSnapshot } from './types.js';

export class TaskAdmissionError extends Error {}
export class TaskLifeCycleManager {
  private readonly tasks = new Map<string, TaskSnapshot>();
  private readonly completions = new Map<string, { done: TaskHandle['done']; resolve: (t: Readonly<TaskSnapshot>) => void }>();
  private readonly listeners = new Set<(task: Readonly<TaskSnapshot>) => void>();
  private nextSequence = 0;
  constructor(private readonly options: {
    store?: TaskStore<TaskSnapshot>; now?: () => number;
    maxPerSession?: number; maxGlobal?: number; retentionMs?: number; logger?: Logger;
  } = {}) {
    for (const task of options.store?.load() ?? []) {
      task.creationSequence ??= this.nextSequence + 1;
      this.nextSequence = Math.max(this.nextSequence, task.creationSequence);
      this.tasks.set(task.taskId, task);
    }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  onChange(listener: (task: Readonly<TaskSnapshot>) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  /** 按未完成 Task 计数，两个 lane 共用一次准入，不消耗两份名额。 */
  assertAdmission(sessionKey: string): void {
    const pending = [...this.tasks.values()].filter(t => !isTaskTerminal(t));
    if (pending.length >= (this.options.maxGlobal ?? 128) || pending.filter(t => t.input.message.target.key === sessionKey).length >= (this.options.maxPerSession ?? 32)) {
      throw new TaskAdmissionError('未完成任务已达上限，请稍后再试。');
    }
  }
  /** 同步创建双 lane 初态；落盘失败时不留下可调度的半成品 Task。 */
  create(input: TaskInput, taskId = randomUUID()): TaskHandle {
    this.assertAdmission(input.message.target.key);
    if (this.tasks.has(taskId)) throw new Error('Task ID 已存在');
    const task: TaskSnapshot = { taskId, input: structuredClone(input), createdAt: this.now(), creationSequence: ++this.nextSequence, status: 'pending', cancelAccepted: false, lanes: { fast: { status: 'queued' }, slow: { status: 'queued' } } };
    const completion = this.completion(taskId);
    this.tasks.set(taskId, task);
    try { this.persist(); } catch (error) { this.tasks.delete(taskId); this.completions.delete(taskId); throw error; }
    this.publish(task);
    return { taskId, done: completion.done };
  }
  get(taskId: string): Readonly<TaskSnapshot> | undefined {
    const task = this.tasks.get(taskId); return task && readonlySnapshot(task);
  }
  list(sessionKey?: string): Readonly<TaskSnapshot>[] {
    return [...this.tasks.values()].filter(t => !sessionKey || t.input.message.target.key === sessionKey).map(readonlySnapshot);
  }
  handle(taskId: string): TaskHandle {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Task 不存在');
    return { taskId, done: isTaskTerminal(task) ? Promise.resolve(readonlySnapshot(task)) : this.completion(taskId).done };
  }
  start(taskId: string, lane: Lane, execution?: LaneExecution): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.cancelAccepted || task.lanes[lane].status !== 'queued') return false;
    task.lanes[lane] = { status: 'running', startedAt: this.now(), execution };
    task.status = 'running'; this.commit(task); return true;
  }
  bindExecution(taskId: string, lane: Lane, execution: LaneExecution): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.cancelAccepted || task.lanes[lane].status !== 'running') return false;
    task.lanes[lane].execution = { ...execution }; this.commit(task); return true;
  }
  /** 拒绝已取消、旧 runtime 或旧执行的迟到事件。 */
  matches(taskId: string, lane: Lane, execution: LaneExecution): boolean {
    if (this.tasks.get(taskId)?.cancelAccepted) return false;
    const state = this.tasks.get(taskId)?.lanes[lane];
    return state?.status === 'running' && state.execution?.executionId === execution.executionId && state.execution.runtimeGeneration === execution.runtimeGeneration && state.execution.sessionId === execution.sessionId;
  }
  /** 区分执行结束与产物收尾，供 /stop 和存活提醒判断实际执行是否仍在继续。 */
  endExecution(taskId: string, lane: Lane): void {
    const task = this.tasks.get(taskId);
    if (!task || task.lanes[lane].status !== 'running') return;
    task.lanes[lane].executionEndedAt = this.now(); this.commit(task);
  }
  /** lane 终态幂等；双终结后按取消、失败、完成的优先级结算整体状态。 */
  finish(taskId: string, lane: Lane, result: LaneResult): void {
    const task = this.tasks.get(taskId);
    if (!task || isLaneTerminal(task.lanes[lane])) return;
    const state = task.lanes[lane];
    state.result = structuredClone(result); state.endedAt = this.now();
    state.status = result.kind === 'failed' ? 'failed' : result.kind === 'cancelled' ? 'cancelled' : 'completed';
    if (LANES.every(l => isLaneTerminal(task.lanes[l]))) {
      task.status = task.cancelAccepted ? 'cancelled' : LANES.some(l => task.lanes[l].status === 'failed') ? 'failed' : 'completed';
      task.endedAt = this.now();
    }
    this.commit(task);
    if (isTaskTerminal(task)) { this.completions.get(taskId)?.resolve(readonlySnapshot(task)); this.completions.delete(taskId); }
  }
  /** 只记录接受取消；Actor / 调度器随后终止剩余执行并提交各 lane 的结果。 */
  cancel(taskId: string): { accepted: boolean; task?: Readonly<TaskSnapshot> } {
    const task = this.tasks.get(taskId);
    if (!task || isTaskTerminal(task)) return { accepted: false, task: task && readonlySnapshot(task) };
    task.cancelAccepted = true; this.commit(task);
    return { accepted: true, task: readonlySnapshot(task) };
  }
  /** 冷启动不重跑执行；保留已终结 lane，仅将未完成 lane 标为中断失败。 */
  recover(): Readonly<TaskSnapshot>[] {
    const interrupted = this.list().filter(t => !isTaskTerminal(t));
    for (const task of interrupted) for (const lane of LANES) if (!isLaneTerminal(task.lanes[lane])) {
      this.finish(task.taskId, lane, { kind: 'failed', text: '任务因服务重启而中断，请重新提交。', error: 'restart-interrupted' });
    }
    return interrupted.map(t => this.get(t.taskId)!);
  }
  destroy(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !isTaskTerminal(task)) return false;
    this.tasks.delete(taskId); this.persist(); return true;
  }
  /** 返回到期快照供装配层清理工作区；不触碰独立的消息队列及附件副本。 */
  prune(): Readonly<TaskSnapshot>[] {
    const cutoff = this.now() - (this.options.retentionMs ?? 7 * 86400_000);
    const expired = [...this.tasks.values()].filter(task => isTaskTerminal(task) && (task.endedAt ?? task.createdAt) < cutoff);
    for (const task of expired) this.tasks.delete(task.taskId);
    if (expired.length) this.persist();
    return expired.map(readonlySnapshot);
  }
  private completion(id: string) {
    let value = this.completions.get(id);
    if (!value) {
      let resolve!: (t: Readonly<TaskSnapshot>) => void;
      const done = new Promise<Readonly<TaskSnapshot>>(r => { resolve = r; });
      value = { done, resolve }; this.completions.set(id, value);
    }
    return value;
  }
  private commit(task: TaskSnapshot): void { this.persist(); this.publish(task); }
  private publish(task: TaskSnapshot): void {
    for (const fn of this.listeners) {
      try { fn(readonlySnapshot(task)); }
      catch (error) { this.options.logger?.error('Task 状态观察者失败', { taskId: task.taskId, error: String(error) }); }
    }
  }
  private persist(): void { this.options.store?.save([...this.tasks.values()]); }
}
