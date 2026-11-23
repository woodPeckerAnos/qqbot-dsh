import type { DeepReadonly } from '../readonly.js';
import type { ReplyPolicy } from '../core/connector.js';
import type { TaskBudget } from './budget.js';
import type { TaskClock } from './clock.js';
import type { TaskLifeCycleManagerV3 } from './lifecycle-v3.js';
import type { MessageQueue } from './message-queue.js';
import type { FrontendReply, ReplyCandidate, TaskSnapshotV3, WorkerReceipt } from './types-v3.js';
export interface SessionOutputCoordinatorV3 {
  accept(task: DeepReadonly<TaskSnapshotV3>, reply: DeepReadonly<FrontendReply>): Promise<void>;
  acknowledge(task: DeepReadonly<TaskSnapshotV3>, receipt: DeepReadonly<WorkerReceipt>): void;
  reconcile(taskId: string): void;
  forget(taskId: string): void;
  close(): void;
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
