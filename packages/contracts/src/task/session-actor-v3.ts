import type { DeepReadonly } from '../readonly.js';
import type { SessionStateWriterV3 } from '../errors.js';
import type { TraceContext } from '../logger.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { TaskLifeCycleManagerV3 } from './lifecycle-v3.js';
import type { PromptPreparerV3 } from './prompt-preparer-v3.js';
import type { LaneSchedulerV3 } from './lane-scheduler-v3.js';
import type { LaneRunnerV3 } from './dsh-lane-runner-v3.js';
import type { SessionOutputCoordinatorV3 } from './output-coordinator-v3.js';
import type { TaskBudget } from './budget.js';
import type { TaskClock } from './clock.js';

import type { Lane, TaskHandleV3, TaskInputV3 as TaskInput } from './types-v3.js';
export interface SessionActorV3 {
  /** 主动请求在等待输入门闩之前固定触发上下文，避免换成后来话题。 */
  submit(
    context: MessageContext,
    proactive?: TaskInput['proactive'],
    budgetLimit?: number
  ): Promise<TaskHandleV3>;
  cancel(taskId: string, initiator?: TraceContext): boolean;
  /** 控制桥已完成权限检查和取消状态写入时，调用此方法终止剩余调度。 */
  cancelExecution(taskId: string): void;
  /** /stop 仅选择命令到达时有模型执行的 Task，保留其他排队 Task。 */
  stop(sessionKey: string, initiator?: TraceContext): number;
  /** /new 清空未完成执行并持久化新回放边界；已完成 Task 的消息继续投递。 */
  reset(sessionKey: string, initiator?: TraceContext): number;
  snapshot(): DeepReadonly<{
    fast: {
      running: number;
      queued: number;
    };
    slow: {
      running: number;
      queued: number;
    };
    unfinished: number;
  }>;
  flushSettlements(): void;
  close(): void;
  whenIdle(): Promise<void>;
}
export type createSessionActorFactoryV3 = (options: {
  manager: TaskLifeCycleManagerV3;
  preparer: PromptPreparerV3;
  schedulers: Record<Lane, LaneSchedulerV3>;
  runner: LaneRunnerV3;
  output: SessionOutputCoordinatorV3;
  budget: TaskBudget;
  clock?: TaskClock;
  sessions?: SessionStateWriterV3;
  resetLanes?: (sessionKey: string, sessionEpoch: number) => void;
  taskIdFactory?: () => string;
}) => SessionActorV3;
export interface SessionContextStateV3 {
  sessionKey: string;
  generation: number;
  sinceTs: number;
  sessionEpoch: number;
  resetSinceTs: number;
}
