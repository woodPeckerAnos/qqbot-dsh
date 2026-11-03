import type { DeepReadonly } from '../readonly.js';
import type { BudgetStateWriter } from '../errors.js';
/**
 * 主动业务预算的持久化账本，单位是 Task，范围固定为触发时的 scope。
 * reserved 与 committed 都占一个名额；多条产物送达只提交一次。
 * 被动 Task 不创建预算记录，平台消息条数由 MessageQueue 另行管理。
 */
export interface BudgetRecord {
    taskId: string;
    scope: string;
    limit: number;
    status: 'reserved' | 'committed' | 'released';
    executionFinished?: boolean;
}
export interface TaskBudget {
    /** Task 创建前预留；同 Task 重复预留或范围已满时拒绝。 */
    reserve(taskId: string, scope: string, limit: number): boolean;
    /** finished 由出口传入，表示执行结束且无待发消息；终态预算不重复结算。 */
    settle(taskId: string, success: boolean, finished: boolean): 'committed' | 'released' | undefined;
    get(taskId: string): DeepReadonly<BudgetRecord> | undefined;
    list(): DeepReadonly<BudgetRecord[]>;
    /** 仅标记执行结束；已有入队消息时仍保留预留，等待实际送达结果。 */
    finish(taskId: string): void;
}
export type createTaskBudgetFactory = (store?: BudgetStateWriter) => TaskBudget;
