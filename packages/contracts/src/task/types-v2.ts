import type { DeepReadonly } from '../readonly.js';
import type { OutgoingAttachment } from '../core/connector.js';
import type { TraceContext } from '../logger.js';
import type { Lane, LaneStatus, LaneExecution, TaskInput, TaskStatus } from './types.js';
/** v2 permits successful execution with no user-visible increment. v1 is retained. */
export type LaneResultV2 = (
  | { kind: 'reply'; text: string; attachments?: readonly OutgoingAttachment[] }
  | { kind: 'silent'; reason: 'no-long-skill' | 'no-increment' }
  | {
      kind: 'failed';
      text: string;
      error: string;
      errorId?: string;
      failure?: import('../errors.js').ContractFailure;
      attachments?: readonly OutgoingAttachment[];
      /** Required deliverable explanation survives proactive error-body suppression. */
      requiredExplanation?: string;
    }
  | { kind: 'cancelled'; attachments?: readonly OutgoingAttachment[] }
) & { trace?: TraceContext; attention?: 'strong' };

export interface LaneSnapshotV2 {
  trace?: TraceContext;
  status: LaneStatus;
  /** 模型执行开始；排队、媒体摄取和 runtime 初始化不计入执行时限。 */
  startedAt?: number;
  endedAt?: number;
  /** 模型、结束钩子等待与子代理均已结束；产物整理可能尚未结束，此后不再发存活提醒。 */
  executionEndedAt?: number;
  execution?: LaneExecution;
  result?: LaneResultV2;
}
export interface TaskSnapshotV2 {
  taskId: string;
  input: TaskInput;
  createdAt: number;
  /** 持久化准入顺序；同毫秒创建的 Task 也能准确判断先后。 */
  creationSequence: number;
  endedAt?: number;
  status: TaskStatus;
  /** 已接受取消时，双 lane 收尾后的整体终态优先为 cancelled。 */
  cancelAccepted: boolean;
  lanes: Record<Lane, LaneSnapshotV2>;
}
/** done 在两个 lane 都终结后完成，不等待消息送达。 */
export interface TaskHandleV2 {
  taskId: string;
  done: Promise<DeepReadonly<TaskSnapshotV2>>;
}

export type {
  Lane,
  LaneEvent,
  TaskInput,
  LaneExecution,
  TaskStatus,
  ReplyCandidate,
} from './types.js';
