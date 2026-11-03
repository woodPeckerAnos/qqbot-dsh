import type { DeepReadonly } from '@qqbot/contracts';

import type { BudgetRecord } from '@qqbot/contracts';
/**
 * 主动业务预算的持久化账本，单位是 Task，范围固定为触发时的 scope。
 * reserved 与 committed 都占一个名额；多条产物送达只提交一次。
 * 被动 Task 不创建预算记录，平台消息条数由 MessageQueue 另行管理。
 */
import type { BudgetStateWriter } from '@qqbot/contracts';
import { readonlySnapshot } from '@qqbot/contracts';
export type { BudgetRecord } from '@qqbot/contracts';
export class TaskBudget {
  private readonly records = new Map<string, BudgetRecord>();
  constructor(private readonly store?: BudgetStateWriter) {
    for (const r of structuredClone(store?.load() ?? [])) this.records.set(r.taskId, r);
  }
  /** Task 创建前预留；同 Task 重复预留或范围已满时拒绝。 */
  reserve(taskId: string, scope: string, limit: number): boolean {
    if (this.records.has(taskId)) return false;
    const used = [...this.records.values()].filter(
      (r) => r.scope === scope && r.status !== 'released'
    ).length;
    if (used >= limit) return false;
    this.commit({ taskId, scope, limit, status: 'reserved' });
    return true;
  }
  /** finished 由出口传入，表示执行结束且无待发消息；终态预算不重复结算。 */
  settle(
    taskId: string,
    success: boolean,
    finished: boolean
  ): 'committed' | 'released' | undefined {
    const record = this.records.get(taskId);
    if (!record || record.status !== 'reserved' || (!success && !finished)) return;
    const status = success ? 'committed' : 'released';
    this.commit({ ...record, status });
    return status;
  }
  get(taskId: string): DeepReadonly<BudgetRecord> | undefined {
    const r = this.records.get(taskId);
    return r && readonlySnapshot(r);
  }
  list(): DeepReadonly<BudgetRecord[]> {
    return readonlySnapshot([...this.records.values()]);
  }
  /** 仅标记执行结束；已有入队消息时仍保留预留，等待实际送达结果。 */
  finish(taskId: string): void {
    const record = this.records.get(taskId);
    if (record && !record.executionFinished) {
      this.commit({ ...record, executionFinished: true });
    }
  }
  private commit(record: BudgetRecord): void {
    const next = new Map(this.records);
    next.set(record.taskId, record);
    this.store?.save(structuredClone([...next.values()]));
    this.records.set(record.taskId, record);
  }
}
