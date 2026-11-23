import type { DeepReadonly } from '../readonly.js';
import type { OutgoingAttachment } from '../core/connector.js';
import type { ContractFailure, Result } from '../errors.js';
import type { LaneExecution, TaskInput, TaskStatus } from './types.js';

export type TaskPhaseV3 =
  | 'frontend-queued'
  | 'frontend-running'
  | 'worker-waiting'
  | 'summary-queued'
  | 'summary-running'
  | 'reply-pending'
  | 'terminal';
export type TaskJobKindV3 = 'frontend' | 'worker' | 'summary';
export interface TaskJobV3 {
  jobId: string;
  taskId: string;
  sessionKey: string;
  kind: TaskJobKindV3;
  createdAt: number;
  deadlineAt: number;
  resultVersion?: number;
}
export interface JobExecutionV3 extends LaneExecution {
  jobId: string;
}
export interface WorkerAssignment {
  instruction: string;
  deliverables: string[];
  acknowledgement?: string;
}
export interface AttachmentReference {
  id: string;
  name: string;
  path: string;
  mime?: string;
}
export interface WorkerHandoff {
  assignment: WorkerAssignment;
  originalInput: TaskInput;
  attachments: AttachmentReference[];
  constraints: string[];
  controlOperations: string[];
}
export interface WorkerReceipt {
  workerId: string;
  jobId: string;
  acceptedAt: number;
  deadlineAt: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
}
export interface WorkerResult {
  status: 'completed' | 'failed' | 'cancelled' | 'unknown';
  text: string;
  evidence: string[];
  attachments: OutgoingAttachment[];
  unfinished: string[];
  failure?: ContractFailure;
}
export interface FrontendReply {
  replyId: string;
  text: string;
  attention?: 'strong';
  attachments?: OutgoingAttachment[];
}
export type FrontendTurnResultV3 = { kind: 'reply'; reply: FrontendReply } | { kind: 'dispatched' };
export type TaskJobOutcomeV3 =
  | { kind: 'frontend'; result: Result<FrontendTurnResultV3> }
  | { kind: 'worker'; result: Result<WorkerResult> }
  | { kind: 'summary'; result: Result<FrontendReply> };
export interface WorkerSnapshotV3 {
  receipt: WorkerReceipt;
  handoff: WorkerHandoff;
  assignmentKey: string;
  execution?: JobExecutionV3;
  startedAt?: number;
  endedAt?: number;
  result?: WorkerResult;
  resultVersion: number;
}
export interface TaskSnapshotV3 {
  schemaVersion: 3;
  taskId: string;
  input: TaskInput;
  createdAt: number;
  creationSequence: number;
  endedAt?: number;
  status: TaskStatus;
  phase: TaskPhaseV3;
  cancelAccepted: boolean;
  frontend: {
    initialJob: TaskJobV3;
    initialStartedAt?: number;
    initialEndedAt?: number;
    activeJob?: TaskJobV3;
    execution?: JobExecutionV3;
    summaryJob?: TaskJobV3;
    summaryStartedAt?: number;
    summaryAttempts: number;
    failure?: ContractFailure;
  };
  worker?: WorkerSnapshotV3;
  finalReply?: FrontendReply;
  finalStatus?: 'completed' | 'failed';
  replyEnqueuedAt?: number;
}
/** 入队确认后结束；实际送达继续由 MessageQueue 管理。 */
export interface TaskHandleV3 {
  taskId: string;
  done: Promise<DeepReadonly<TaskSnapshotV3>>;
}
export interface SessionEvent {
  type: 'worker-accepted' | 'worker-finished' | 'frontend-finished' | 'reply-saved' | 'cancelled';
  taskId: string;
  jobId: string;
  workerId?: string;
  execution?: JobExecutionV3;
  resultVersion?: number;
}
/** 查询投影只读取投递状态，管理器不写入这些字段。 */
export interface TaskQueryV3 extends TaskSnapshotV3 {
  delivery: {
    success: boolean;
    pending: boolean;
    count: number;
    status: 'none' | 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';
    asOf: number;
  };
}

export type { TaskInput, TaskStatus, ReplyCandidate } from './types.js';
