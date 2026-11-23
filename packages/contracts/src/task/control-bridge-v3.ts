import type { DeepReadonly } from '../readonly.js';
import type { Result } from '../errors.js';
import type { TaskLifeCycleManagerV3 } from './lifecycle-v3.js';
import type {
  AttachmentReference,
  JobExecutionV3,
  TaskJobV3,
  TaskQueryV3,
  TaskSnapshotV3,
  WorkerAssignment,
  WorkerReceipt,
} from './types-v3.js';
export interface TaskControlBridgeV3 {
  bind(
    caller: DeepReadonly<TaskSnapshotV3>,
    job: DeepReadonly<TaskJobV3>,
    execution: JobExecutionV3,
    handoff?: { attachments: AttachmentReference[]; constraints: string[] }
  ): {
    query(taskId?: string): Result<DeepReadonly<TaskQueryV3[]>>;
    cancel(taskId: string): Result<boolean>;
    startWorker(assignment: WorkerAssignment): Result<WorkerReceipt>;
  };
}
export type createTaskControlBridgeFactoryV3 = (
  manager: TaskLifeCycleManagerV3,
  cancelTask: (taskId: string) => void,
  queue?: import('./message-queue.js').MessageQueue
) => TaskControlBridgeV3;
