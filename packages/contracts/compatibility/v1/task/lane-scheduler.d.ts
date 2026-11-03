import type { DeepReadonly } from '../readonly.js';
/**
 * 单个 lane 的执行额度与 Session FIFO。快慢 lane 各自创建实例，互不等待。
 * 调度器拥有 AbortController 和运行名额，Task 状态通过 settle 交回管理器。
 * run 包含所属执行的产物收尾；finally 后才允许同 Session 的下一项开始。
 */
/**
 * 单个 lane 的执行额度与 Session FIFO。快慢 lane 各自创建实例，互不等待。
 * 调度器拥有 AbortController 和运行名额，Task 状态通过 settle 交回管理器。
 * run 包含所属执行的产物收尾；finally 后才允许同 Session 的下一项开始。
 */
import type { LaneResult, TaskSnapshot } from './types.js';
interface Job {
    task: DeepReadonly<TaskSnapshot>;
    run: (signal: AbortSignal) => Promise<LaneResult>;
    settle: (result: LaneResult) => void;
}
export interface LaneScheduler {
    enqueue(job: Job): void;
    /** 排队项直接结算取消；运行项发出信号，并等待 runner 释放具体 runtime。 */
    cancel(taskId: string): void;
    snapshot(): DeepReadonly<{
        running: number;
        queued: number;
    }>;
    close(): void;
    /** 只重试保存已完成结果，绝不重新执行 run；可由维护循环在存储恢复后唤醒。 */
    flushSettlements(): void;
}
export type createLaneSchedulerFactory = (capacity?: number, onSettlementError?: (error: unknown, taskId: string) => void) => LaneScheduler;
export {};
