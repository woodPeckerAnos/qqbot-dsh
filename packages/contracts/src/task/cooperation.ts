import type { DeepReadonly } from '../readonly.js';
import type { LaneExecution, LaneStatus } from './types.js';

export interface TaskCooperationBinding extends LaneExecution {
  readonly taskId: string;
}
export interface TaskCooperationBody {
  readonly messageId: string;
  readonly text: string;
  readonly status: 'pending' | 'sending' | 'sent' | 'failed' | 'discarded';
  readonly error?: string;
}
/** revision changes only when fast execution or original body delivery changes. */
export interface TaskCooperationSnapshot {
  readonly taskId: string;
  readonly revision: number;
  readonly fastStatus: LaneStatus;
  readonly ready: boolean;
  readonly bodies: readonly TaskCooperationBody[];
  readonly delivered: readonly TaskCooperationBody[];
}
export interface TaskCooperation {
  read(taskId: string): DeepReadonly<TaskCooperationSnapshot>;
  subscribe(
    taskId: string,
    listener: (snapshot: DeepReadonly<TaskCooperationSnapshot>) => void
  ): () => void;
  /** Wait for fast execution and original body delivery, including pending routes. */
  wait(taskId: string, signal: AbortSignal): Promise<DeepReadonly<TaskCooperationSnapshot>>;
}
export type createTaskCooperationFactory = (
  manager: import('./lifecycle-v2.js').TaskLifeCycleManagerV2,
  queue: import('./message-queue.js').MessageQueue
) => TaskCooperationController;
export interface TaskCooperationController extends TaskCooperation {
  forget(taskId: string): void;
  close(): void;
}
export interface TaskCooperationRequest extends TaskCooperationBinding {
  readonly action: 'cooperation-read' | 'cooperation-wait';
}
export interface TaskCooperationUpdate {
  readonly type: 'cooperation';
  readonly binding: TaskCooperationBinding;
  readonly snapshot: DeepReadonly<TaskCooperationSnapshot>;
}
