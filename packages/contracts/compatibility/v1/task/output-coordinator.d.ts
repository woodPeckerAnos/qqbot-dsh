import type { DeepReadonly } from '../readonly.js';
import type { TaskBudget } from './budget.js';
import type { TaskClock } from './clock.js';
import type { TaskLifeCycleManager } from './lifecycle.js';
import type { MessageQueue } from './message-queue.js';
import type { Lane, LaneResult, ReplyCandidate, TaskSnapshot } from './types.js';
export interface SessionOutputCoordinator {
    /** runner 已验证静默契约；不同 lane 的不同正文分别保留，附件不参与正文去重。 */
    accept(task: DeepReadonly<TaskSnapshot>, lane: Lane, result: LaneResult, resultId?: string): Promise<void>;
    /** 任一送达即可提交；释放则必须同时满足执行结束与所有消息均终结未成功。 */
    reconcile(taskId: string): void;
    close(): void;
    /** 只回收协调器缓存和提醒，保留队列拥有的消息及附件。 */
    forget(taskId: string): void;
}
export type createSessionOutputCoordinatorFactory = (options: {
    manager: TaskLifeCycleManager;
    queue: MessageQueue;
    budget: TaskBudget;
    filesDir: string;
    maxChars: (task: DeepReadonly<TaskSnapshot>) => number;
    clock?: TaskClock;
    reminderMs?: number;
    onDelivered?: (candidate: DeepReadonly<ReplyCandidate>, ts: number) => void;
    onBudgetSettled?: (taskId: string, outcome: 'committed' | 'released') => void;
}) => SessionOutputCoordinator;
