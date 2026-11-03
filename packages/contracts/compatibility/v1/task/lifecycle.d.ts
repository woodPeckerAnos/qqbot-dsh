import type { DeepReadonly } from '../readonly.js';
import type { TaskStateWriter } from '../errors.js';
import type { Logger, TraceContext } from '../logger.js';
import type { Lane, LaneExecution, LaneResult, TaskHandle, TaskInput, TaskSnapshot } from './types.js';
export declare class TaskAdmissionError extends Error {
}
export interface TaskLifeCycleManager {
    onChange(listener: (task: DeepReadonly<TaskSnapshot>) => void): () => void;
    /** 按未完成 Task 计数，两个 lane 共用一次准入，不消耗两份名额。 */
    assertAdmission(sessionKey: string): void;
    /** 同步创建双 lane 初态；落盘失败时不留下可调度的半成品 Task。 */
    create(input: TaskInput, taskId?: string): TaskHandle;
    get(taskId: string): DeepReadonly<TaskSnapshot> | undefined;
    list(sessionKey?: string): DeepReadonly<TaskSnapshot[]>;
    handle(taskId: string): TaskHandle;
    start(taskId: string, lane: Lane, execution?: LaneExecution): boolean;
    bindExecution(taskId: string, lane: Lane, execution: LaneExecution): boolean;
    /** 拒绝已取消、旧 runtime 或旧执行的迟到事件。 */
    matches(taskId: string, lane: Lane, execution: LaneExecution): boolean;
    /** 区分执行结束与产物收尾，供 /stop 和存活提醒判断实际执行是否仍在继续。 */
    endExecution(taskId: string, lane: Lane): void;
    /** lane 终态幂等；双终结后按取消、失败、完成的优先级结算整体状态。 */
    finish(taskId: string, lane: Lane, result: LaneResult): void;
    /** 只记录接受取消；Actor / 调度器随后终止剩余执行并提交各 lane 的结果。 */
    cancel(taskId: string, initiator?: TraceContext): {
        accepted: boolean;
        task?: DeepReadonly<TaskSnapshot>;
    };
    /** 冷启动不重跑执行；保留已终结 lane，仅将未完成 lane 标为中断失败。 */
    recover(): DeepReadonly<TaskSnapshot[]>;
    destroy(taskId: string): boolean;
    /** 返回到期快照供装配层清理工作区；不触碰独立的消息队列及附件副本。 */
    prune(): DeepReadonly<TaskSnapshot[]>;
}
export type createTaskLifeCycleManagerFactory = (options?: {
    store?: TaskStateWriter;
    now?: () => number;
    maxPerSession?: number;
    maxGlobal?: number;
    retentionMs?: number;
    logger?: Logger;
    idFactory?: () => string;
}) => TaskLifeCycleManager;
