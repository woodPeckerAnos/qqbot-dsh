import type { DeepReadonly } from '../readonly.js';
import type { TaskStateWriterV3 } from '../errors.js';
import type { Logger, TraceContext } from '../logger.js';

import type {
  Lane,
  LaneExecutionV3 as LaneExecution,
  LaneResultV3,
  TaskHandleV3,
  TaskInputV3 as TaskInput,
  TaskSnapshotV3,
} from './types-v3.js';

export interface TaskLifeCycleManagerV3 {
  onChange(listener: (task: DeepReadonly<TaskSnapshotV3>) => void): () => void;
  /** 按未完成 Task 计数，两个 lane 共用一次准入，不消耗两份名额。 */
  assertAdmission(sessionKey: string): void;
  /** 同步创建双 lane 初态；落盘失败时不留下可调度的半成品 Task。 */
  create(input: TaskInput, taskId?: string): TaskHandleV3;
  get(taskId: string): DeepReadonly<TaskSnapshotV3> | undefined;
  list(sessionKey?: string): DeepReadonly<TaskSnapshotV3[]>;
  handle(taskId: string): TaskHandleV3;
  start(taskId: string, lane: Lane, execution?: LaneExecution): boolean;
  bindExecution(taskId: string, lane: Lane, execution: LaneExecution): boolean;
  /** 拒绝已取消、旧 runtime 或旧执行的迟到事件。 */
  matches(taskId: string, lane: Lane, execution: LaneExecution): boolean;
  /** 区分执行结束与产物收尾；结束钩子等待保持 running，供 /stop 和存活提醒判断。 */
  endExecution(taskId: string, lane: Lane): void;
  /** lane 终态幂等；取消请求或任一 lane 取消优先，其次失败，再完成。 */
  finish(taskId: string, lane: Lane, result: LaneResultV3): void;
  /** 只记录接受取消；Actor / 调度器随后终止剩余执行并提交各 lane 的结果。 */
  cancel(
    taskId: string,
    initiator?: TraceContext
  ): {
    accepted: boolean;
    task?: DeepReadonly<TaskSnapshotV3>;
  };
  /** 冷启动不重跑执行；保留已终结 lane，仅将未完成 lane 标为中断失败。 */
  recover(): DeepReadonly<TaskSnapshotV3[]>;
  destroy(taskId: string): boolean;
  /** 返回到期快照供装配层清理工作区；不触碰独立的消息队列及附件副本。 */
  prune(): DeepReadonly<TaskSnapshotV3[]>;
}
export type createTaskLifeCycleManagerFactoryV3 = (options?: {
  store?: TaskStateWriterV3;
  now?: () => number;
  maxPerSession?: number;
  maxGlobal?: number;
  retentionMs?: number;
  logger?: Logger;
  idFactory?: () => string;
}) => TaskLifeCycleManagerV3;
