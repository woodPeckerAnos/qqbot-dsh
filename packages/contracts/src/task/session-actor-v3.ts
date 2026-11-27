import type { DeepReadonly } from '../readonly.js';
import type { Result, StateWriter } from '../errors.js';
import type { TraceContext } from '../logger.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { TaskLifeCycleManagerV3 } from './lifecycle-v3.js';
import type { PromptPreparerV3 } from './prompt-preparer-v3.js';
import type { JobSchedulerV3 } from './job-scheduler.js';
import type { TaskRunnerV3 } from './task-runner-v3.js';
import type { SessionOutputCoordinatorV3 } from './output-coordinator-v3.js';
import type { TaskBudget } from './budget.js';
import type { TaskClock } from './clock.js';
import type { SessionEvent, TaskHandleV3, TaskInput } from './types-v3.js';
/** 文件记录先按 unknown 读取，校验会话键、代次、时间和重复身份后才提交。 */
export interface SessionStateWriterV3 extends StateWriter<unknown> {
  readonly domain?: 'task-sessions';
}
export interface SessionActorV3 {
  generation(sessionKey: string): number;
  sinceTs(sessionKey: string): number;
  submit(
    context: MessageContext,
    proactive?: TaskInput['proactive'],
    budgetLimit?: number
  ): Promise<TaskHandleV3>;
  cancel(taskId: string, initiator?: TraceContext): boolean;
  cancelExecution(taskId: string): void;
  stop(sessionKey: string, initiator?: TraceContext, senderId?: string): number;
  reset(sessionKey: string, initiator?: TraceContext): number;
  notify(event: DeepReadonly<SessionEvent>): void;
  snapshot(): DeepReadonly<{
    frontend: ReturnType<JobSchedulerV3['snapshot']>;
    worker: ReturnType<JobSchedulerV3['snapshot']>;
    fast: ReturnType<JobSchedulerV3['snapshot']>;
    slow: ReturnType<JobSchedulerV3['snapshot']>;
    unfinished: number;
    handoffFailures: number;
    summaryFailures: number;
  }>;
  /** 恢复和 30 秒维护仅补派发、保存、整理与固定回复入队。 */
  flushSettlements(): void;
  recover(): Result<void>;
  close(): Promise<void>;
}
export type createSessionActorFactoryV3 = (options: {
  manager: TaskLifeCycleManagerV3;
  preparer: PromptPreparerV3;
  schedulers: { frontend: JobSchedulerV3; worker: JobSchedulerV3 };
  runner: TaskRunnerV3;
  output: SessionOutputCoordinatorV3;
  budget: TaskBudget;
  clock?: TaskClock;
  sessions?: SessionStateWriterV3;
  taskIdFactory?: () => string;
  context: (task: DeepReadonly<import('./types-v3.js').TaskSnapshotV3>) => MessageContext;
  sessionContext?: Partial<import('../session/context.js').SessionContextSettings>;
}) => SessionActorV3;
