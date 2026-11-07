import type { DeepReadonly } from '../readonly.js';
import type { ReplyPolicy } from '../core/connector.js';
import type { TaskBudget } from './budget.js';
import type { TaskClock } from './clock.js';
import type { TaskLifeCycleManagerV2 } from './lifecycle-v2.js';
import type { MessageQueue } from './message-queue.js';
import type { Lane, LaneResultV2, ReplyCandidate, TaskSnapshotV2 } from './types-v2.js';
export interface SessionOutputCoordinatorV2 {
  /** runner 已完成协作闸门；跨 lane 仅按成功送达原始正文精确分段去重，入队 ID 区分 lane，附件独立幂等。 */
  accept(
    task: DeepReadonly<TaskSnapshotV2>,
    lane: Lane,
    result: LaneResultV2,
    resultId?: string
  ): Promise<void>;
  /** 任一送达即可提交；释放则必须同时满足执行结束与所有消息均终结未成功。 */
  reconcile(taskId: string): void;
  close(): void;
  /** 只回收协调器缓存和提醒，保留队列拥有的消息及附件。 */
  forget(taskId: string): void;
}
export type createSessionOutputCoordinatorFactoryV2 = (options: {
  manager: TaskLifeCycleManagerV2;
  queue: MessageQueue;
  budget: TaskBudget;
  filesDir: string;
  maxChars: (task: DeepReadonly<TaskSnapshotV2>) => number;
  policy?: (task: DeepReadonly<TaskSnapshotV2>) => ReplyPolicy;
  maxFileBytes?: number;
  clock?: TaskClock;
  reminderMs?: number;
  onDelivered?: (candidate: DeepReadonly<ReplyCandidate>, ts: number) => void;
  onBudgetSettled?: (taskId: string, outcome: 'committed' | 'released') => void;
}) => SessionOutputCoordinatorV2;
