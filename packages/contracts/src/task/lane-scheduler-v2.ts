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
import type { LaneResultV2, TaskSnapshotV2 } from './types-v2.js';
interface Job {
  /** Settle without queue capacity, runtime, run or artifact preparation. */
  precomputed?: LaneResultV2;
  task: DeepReadonly<TaskSnapshotV2>;
  run: (signal: AbortSignal) => Promise<LaneResultV2>;
  settle: (result: LaneResultV2) => void;
}
export interface LaneSchedulerV2 {
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
export type createLaneSchedulerFactoryV2 = (
  capacity?: number,
  onSettlementError?: (error: unknown, taskId: string) => void
) => LaneSchedulerV2;
export {};
