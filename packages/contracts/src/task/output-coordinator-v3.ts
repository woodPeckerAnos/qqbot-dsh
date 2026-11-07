import type { DeepReadonly } from '../readonly.js';
import type { ReplyPolicy } from '../core/connector.js';
import type { TaskBudget } from './budget.js';
import type { TaskClock } from './clock.js';
import type { TaskLifeCycleManagerV3 } from './lifecycle-v3.js';
import type { MessageQueue } from './message-queue.js';
import type { Lane, LaneResultV3, ReplyCandidate, TaskSnapshotV3 } from './types-v3.js';
export interface SessionOutputCoordinatorV3 {
  /** runner 已完成协作闸门；跨 lane 仅按成功送达原始正文精确分段去重，入队 ID 区分 lane，附件独立幂等。 */
  accept(
    task: DeepReadonly<TaskSnapshotV3>,
    lane: Lane,
    result: LaneResultV3,
    resultId?: string
  ): Promise<void>;
  /** 任一送达即可提交；释放则必须同时满足执行结束与所有消息均终结未成功。 */
  reconcile(taskId: string): void;
  close(): void;
  /** 只回收协调器缓存和提醒，保留队列拥有的消息及附件。 */
  forget(taskId: string): void;
}
export type createSessionOutputCoordinatorFactoryV3 = (options: {
  manager: TaskLifeCycleManagerV3;
  queue: MessageQueue;
  budget: TaskBudget;
  filesDir: string;
  maxChars: (task: DeepReadonly<TaskSnapshotV3>) => number;
  policy?: (task: DeepReadonly<TaskSnapshotV3>) => ReplyPolicy;
  maxFileBytes?: number;
  clock?: TaskClock;
  reminderMs?: number;
  onDelivered?: (candidate: DeepReadonly<ReplyCandidate>, ts: number) => void;
  onBudgetSettled?: (taskId: string, outcome: 'committed' | 'released') => void;
}) => SessionOutputCoordinatorV3;
