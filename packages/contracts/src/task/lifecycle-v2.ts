import type { DeepReadonly } from '../readonly.js';
import type { TaskStateWriterV2 } from '../errors.js';
import type { Logger, TraceContext } from '../logger.js';

import type {
  Lane,
  LaneExecution,
  LaneResultV2,
  TaskHandleV2,
  TaskInput,
  TaskSnapshotV2,
} from './types-v2.js';

export interface TaskLifeCycleManagerV2 {
  onChange(listener: (task: DeepReadonly<TaskSnapshotV2>) => void): () => void;
  /** 按未完成 Task 计数，两个 lane 共用一次准入，不消耗两份名额。 */
  assertAdmission(sessionKey: string): void;
  /** 同步创建双 lane 初态；落盘失败时不留下可调度的半成品 Task。 */
  create(input: TaskInput, taskId?: string): TaskHandleV2;
  get(taskId: string): DeepReadonly<TaskSnapshotV2> | undefined;
  list(sessionKey?: string): DeepReadonly<TaskSnapshotV2[]>;
  handle(taskId: string): TaskHandleV2;
  start(taskId: string, lane: Lane, execution?: LaneExecution): boolean;
  bindExecution(taskId: string, lane: Lane, execution: LaneExecution): boolean;
  /** 拒绝已取消、旧 runtime 或旧执行的迟到事件。 */
  matches(taskId: string, lane: Lane, execution: LaneExecution): boolean;
  /** 区分执行结束与产物收尾；结束钩子等待保持 running，供 /stop 和存活提醒判断。 */
  endExecution(taskId: string, lane: Lane): void;
  /** lane 终态幂等；双终结后按取消、失败、完成的优先级结算整体状态。 */
  finish(taskId: string, lane: Lane, result: LaneResultV2): void;
  /** 只记录接受取消；Actor / 调度器随后终止剩余执行并提交各 lane 的结果。 */
  cancel(
    taskId: string,
    initiator?: TraceContext
  ): {
    accepted: boolean;
    task?: DeepReadonly<TaskSnapshotV2>;
  };
  /** 冷启动不重跑执行；保留已终结 lane，仅将未完成 lane 标为中断失败。 */
  recover(): DeepReadonly<TaskSnapshotV2[]>;
  destroy(taskId: string): boolean;
  /** 返回到期快照供装配层清理工作区；不触碰独立的消息队列及附件副本。 */
  prune(): DeepReadonly<TaskSnapshotV2[]>;
}
export type createTaskLifeCycleManagerFactoryV2 = (options?: {
  store?: TaskStateWriterV2;
  now?: () => number;
  maxPerSession?: number;
  maxGlobal?: number;
  retentionMs?: number;
  logger?: Logger;
  idFactory?: () => string;
}) => TaskLifeCycleManagerV2;
