import type { DeepReadonly } from '../readonly.js';
import type { SessionStateWriter } from '../errors.js';
import type { TraceContext } from '../logger.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { TaskLifeCycleManager } from './lifecycle.js';
import type { PromptPreparer } from './prompt-preparer.js';
import type { LaneScheduler } from './lane-scheduler.js';
import type { LaneRunner } from './dsh-lane-runner.js';
import type { SessionOutputCoordinator } from './output-coordinator.js';
import type { TaskBudget } from './budget.js';
import type { TaskClock } from './clock.js';
import type { Lane, TaskHandle, TaskInput } from './types.js';
export interface SessionActor {
    /** 主动请求在等待输入门闩之前固定触发上下文，避免换成后来话题。 */
    submit(context: MessageContext, proactive?: TaskInput['proactive'], budgetLimit?: number): Promise<TaskHandle>;
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
export type createSessionActorFactory = (options: {
    manager: TaskLifeCycleManager;
    preparer: PromptPreparer;
    schedulers: Record<Lane, LaneScheduler>;
    runner: LaneRunner;
    output: SessionOutputCoordinator;
    budget: TaskBudget;
    clock?: TaskClock;
    sessions?: SessionStateWriter;
    taskIdFactory?: () => string;
}) => SessionActor;
export interface SessionContextState {
    sessionKey: string;
    generation: number;
    sinceTs: number;
}
