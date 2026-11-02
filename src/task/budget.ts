/**
 * 主动业务预算的持久化账本，单位是 Task，范围固定为触发时的 scope。
 * reserved 与 committed 都占一个名额；多条产物送达只提交一次。
 * 被动 Task 不创建预算记录，平台消息条数由 MessageQueue 另行管理。
 */
import type { TaskStore } from '../store/tasks.js';
export interface BudgetRecord { taskId: string; scope: string; limit: number; status: 'reserved' | 'committed' | 'released'; executionFinished?: boolean }
export class TaskBudget {
  private readonly records = new Map<string, BudgetRecord>();
  constructor(private readonly store?: TaskStore<BudgetRecord>) { for (const r of store?.load() ?? []) this.records.set(r.taskId, r); }
  /** Task 创建前预留；同 Task 重复预留或范围已满时拒绝。 */
  reserve(taskId: string, scope: string, limit: number): boolean {
    if (this.records.has(taskId)) return false;
    const used = [...this.records.values()].filter(r => r.scope === scope && r.status !== 'released').length;
    if (used >= limit) return false;
    this.records.set(taskId, { taskId, scope, limit, status: 'reserved' });
    try { this.persist(); } catch (error) { this.records.delete(taskId); throw error; }
    return true;
  }
  /** finished 由出口传入，表示执行结束且无待发消息；终态预算不重复结算。 */
  settle(taskId: string, success: boolean, finished: boolean): 'committed' | 'released' | undefined {
    const record = this.records.get(taskId);
    if (!record || record.status !== 'reserved' || (!success && !finished)) return;
    record.status = success ? 'committed' : 'released'; this.persist(); return record.status;
  }
  get(taskId: string): Readonly<BudgetRecord> | undefined { const r = this.records.get(taskId); return r && { ...r }; }
  list(): Readonly<BudgetRecord>[] { return [...this.records.values()].map(r => ({ ...r })); }
  /** 仅标记执行结束；已有入队消息时仍保留预留，等待实际送达结果。 */
  finish(taskId: string): void {
    const record = this.records.get(taskId);
    if (record && !record.executionFinished) { record.executionFinished = true; this.persist(); }
  }
  private persist(): void { this.store?.save([...this.records.values()]); }
}
