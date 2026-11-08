import type { DeepReadonly } from '../readonly.js';
import type { SessionStateWriter } from '../errors.js';
import type { TraceContext } from '../logger.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { TaskLifeCycleManagerV2 } from './lifecycle-v2.js';
import type { PromptPreparerV2 } from './prompt-preparer-v2.js';
import type { LaneSchedulerV2 } from './lane-scheduler-v2.js';
import type { LaneRunnerV2 } from './dsh-lane-runner-v2.js';
import type { SessionOutputCoordinatorV2 } from './output-coordinator-v2.js';
import type { TaskBudget } from './budget.js';
import type { TaskClock } from './clock.js';

import type { Lane, TaskHandleV2, TaskInput } from './types-v2.js';
export interface SessionActorV2 {
  generation(sessionKey: string): number;
  sinceTs(sessionKey: string): number;
  /** 主动请求在等待输入门闩之前固定触发上下文，避免换成后来话题。 */
  submit(
    context: MessageContext,
    proactive?: TaskInput['proactive'],
    budgetLimit?: number
  ): Promise<TaskHandleV2>;
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
}
export type createSessionActorFactoryV2 = (options: {
  manager: TaskLifeCycleManagerV2;
  preparer: PromptPreparerV2;
  schedulers: Record<Lane, LaneSchedulerV2>;
  runner: LaneRunnerV2;
  output: SessionOutputCoordinatorV2;
  budget: TaskBudget;
  clock?: TaskClock;
  sessions?: SessionStateWriter;
  taskIdFactory?: () => string;
  sessionContext?: Partial<import('../session/context.js').SessionContextSettings>;
}) => SessionActorV2;
export type { SessionContextState } from './session-actor.js';
