import type { DeepReadonly } from '../readonly.js';
import type { Result } from '../errors.js';
import type { TaskClock } from './clock.js';
import type { TaskJobV3, TaskJobOutcomeV3 } from './types-v3.js';
export interface ScheduledTaskJobV3 {
  job: DeepReadonly<TaskJobV3>;
  run(signal: AbortSignal): Promise<TaskJobOutcomeV3>;
  settle(result: TaskJobOutcomeV3): Result<void>;
}
/** 独占 AbortController、Session 串行与执行名额，待保存结果按 jobId 独立保留。 */
export interface JobSchedulerV3 {
  enqueue(job: ScheduledTaskJobV3): Result<void>;
  cancel(taskId: string): void;
  snapshot(): DeepReadonly<{
    running: number;
    queued: number;
    longestWaitingMs: number;
    pendingSettlements: number;
  }>;
  flushSettlements(): void;
  close(): Promise<void>;
}
export type createJobSchedulerFactoryV3 = (options?: {
  capacity?: number;
  clock?: TaskClock;
  onSettlementError?: (error: unknown, jobId: string) => void;
}) => JobSchedulerV3;
