import type { DeepReadonly } from '../readonly.js';
import type { Result, StateWriter } from '../errors.js';
import type { Logger, TraceContext } from '../logger.js';
import type {
  AttachmentReference,
  FrontendReply,
  FrontendTurnResultV3,
  JobExecutionV3,
  SessionEvent,
  TaskHandleV3,
  TaskInput,
  TaskJobV3,
  TaskSnapshotV3,
  WorkerAssignment,
  WorkerReceipt,
  WorkerResult,
} from './types-v3.js';

/** 同一 tasks 文件保留 V1/V2 历史；输入、引用、附件、交接及阶段身份均校验，未知版本拒绝读取。 */
export interface TaskStateWriterV3 extends StateWriter<unknown> {
  readonly domain?: 'tasks';
}
export interface LegacyTaskInterruptionV3 {
  taskId: string;
  input: TaskInput;
}
export interface TaskLifeCycleManagerV3 {
  onChange(listener: (task: DeepReadonly<TaskSnapshotV3>) => void): () => void;
  onEvent(listener: (event: DeepReadonly<SessionEvent>) => void): () => void;
  assertAdmission(sessionKey: string): Result<void>;
  create(input: TaskInput, taskId?: string): Result<TaskHandleV3>;
  get(taskId: string): DeepReadonly<TaskSnapshotV3> | undefined;
  list(sessionKey?: string): DeepReadonly<TaskSnapshotV3[]>;
  /** 未完成 V1/V2 输入；装配入口须先保存固定 ID 中断通知，再调用 recover。 */
  pendingLegacyInterruptions(): DeepReadonly<LegacyTaskInterruptionV3[]>;
  handle(taskId: string): Result<TaskHandleV3>;
  pendingJobs(): DeepReadonly<TaskJobV3[]>;
  /** 已提交派发的失败次数；重复成功回执不计数，协议非法帧由 runtime 诊断。 */
  handoffFailureCount(): number;
  /** 先保存领取身份再运行；整理必须等首次前台彻底退出。 */
  claimJob(jobId: string): Result<DeepReadonly<TaskSnapshotV3>>;
  bindExecution(taskId: string, jobId: string, execution: JobExecutionV3): Result<void>;
  matches(taskId: string, jobId: string, execution: JobExecutionV3): boolean;
  acceptWorker(request: {
    taskId: string;
    jobId: string;
    execution: JobExecutionV3;
    assignment: WorkerAssignment;
    attachments?: AttachmentReference[];
    constraints?: string[];
    controlOperations?: string[];
  }): Result<WorkerReceipt>;
  finishFrontend(taskId: string, jobId: string, result: Result<FrontendTurnResultV3>): Result<void>;
  saveWorkerResult(taskId: string, jobId: string, result: Result<WorkerResult>): Result<void>;
  saveFinalReply(taskId: string, jobId: string, result: Result<FrontendReply>): Result<void>;
  confirmEnqueued(taskId: string, replyId: string): Result<void>;
  cancel(taskId: string, initiator?: TraceContext): Result<boolean>;
  recover(): Result<DeepReadonly<TaskSnapshotV3[]>>;
  expire(): Result<DeepReadonly<TaskSnapshotV3[]>>;
  destroy(taskId: string): Result<boolean>;
  prune(): Result<DeepReadonly<TaskSnapshotV3[]>>;
}
export type createTaskLifeCycleManagerFactoryV3 = (options?: {
  store?: TaskStateWriterV3;
  now?: () => number;
  maxPerSession?: number;
  maxGlobal?: number;
  retentionMs?: number;
  queueTimeoutMs?: number;
  logger?: Logger;
  idFactory?: () => string;
}) => TaskLifeCycleManagerV3;
