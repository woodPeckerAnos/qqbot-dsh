import type { DeepReadonly } from '../readonly.js';
/**
 * Task 的公共值类型。执行快照由 TaskLifeCycleManager 写入，投递结果由
 * MessageQueue 写入；两个状态域通过 ReplyCandidate / DeliveryResult 连接。
 */
/**
 * Task 的公共值类型。执行快照由 TaskLifeCycleManager 写入，投递结果由
 * MessageQueue 写入；两个状态域通过 ReplyCandidate / DeliveryResult 连接。
 */
import type { NormalizedMessage, OriginalMessageReference, OutgoingAttachment } from '../core/connector.js';
import type { TraceContext } from '../logger.js';
import type { ObservationEntry } from '../store/window.js';
export type Lane = 'fast' | 'slow';
export declare const LANES: readonly Lane[];
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type LaneStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
/** silent 仅表达正常的无需长技能；执行失败和取消必须保留各自结果类型。 */
export type LaneResult = ({
    kind: 'reply';
    text: string;
    attachments?: readonly OutgoingAttachment[];
} | {
    kind: 'silent';
    reason: 'no-long-skill';
} | {
    kind: 'failed';
    text: string;
    error: string;
    errorId?: string;
    failure?: import('../errors.js').ContractFailure;
    attachments?: readonly OutgoingAttachment[];
} | {
    kind: 'cancelled';
    attachments?: readonly OutgoingAttachment[];
}) & {
    trace?: TraceContext;
};
/** 准入时固定的输入；后续话题变化不改写旧 Task 的身份、上下文或授权。 */
export interface TaskInput {
    trace?: TraceContext;
    message: NormalizedMessage;
    /** 由 Ingress 身份白名单绑定，不能由模型提供。 */
    isAdmin: boolean;
    source: 'user' | 'proactive';
    /** 上下文代次，只影响输入回放范围，不是旧 Task 的取消信号。 */
    generation: number;
    /** 原消息引用，与投递时可替换的 QQ msg_id 发送锚点分开。 */
    reference: OriginalMessageReference;
    context: {
        window: readonly ObservationEntry[];
        replay: string;
        mentionsChatRecord?: boolean;
    };
    proactive?: {
        directive: string;
        evidence?: string;
        scene: string;
        budgetScope: string;
    };
}
/** 三项身份必须同时匹配，才能把 runtime 通知归入当前执行。 */
export interface LaneExecution {
    executionId: string;
    runtimeGeneration: string;
    sessionId: string;
}
export interface LaneEvent extends LaneExecution {
    taskId: string;
    sessionKey: string;
    lane: Lane;
    type: string;
}
export interface LaneSnapshot {
    trace?: TraceContext;
    status: LaneStatus;
    /** 模型执行开始；排队、媒体摄取和 runtime 初始化不计入执行时限。 */
    startedAt?: number;
    endedAt?: number;
    /** 模型与子代理已结束，但产物整理可能尚未结束；此后不再发存活提醒。 */
    executionEndedAt?: number;
    execution?: LaneExecution;
    result?: LaneResult;
}
export interface TaskSnapshot {
    taskId: string;
    input: TaskInput;
    createdAt: number;
    /** 持久化准入顺序；同毫秒创建的 Task 也能准确判断先后。 */
    creationSequence: number;
    endedAt?: number;
    status: TaskStatus;
    /** 已接受取消时，双 lane 收尾后的整体终态优先为 cancelled。 */
    cancelAccepted: boolean;
    lanes: Record<Lane, LaneSnapshot>;
}
/** done 在两个 lane 都终结后完成，不等待消息送达。 */
export interface TaskHandle {
    taskId: string;
    done: Promise<DeepReadonly<TaskSnapshot>>;
}
/** 可交付产物；一旦入队，后续 Task 取消或终结均不撤回它。 */
export interface ReplyCandidate {
    trace?: TraceContext;
    taskId: string;
    lane: Lane;
    /** 触发输入；队列可以另选合法发送锚点，不能替换 reference。 */
    message: NormalizedMessage;
    reference?: OriginalMessageReference;
    quote?: boolean;
    text: string;
    attachment?: OutgoingAttachment;
    kind: 'final' | 'error' | 'progress';
    /** 发送失败通知标记，阻止通知失败时递归创建新通知。 */
    notification?: boolean;
    /** 仅允许当前立即尝试；无出口或通道忙时丢弃，不等待下一条输入。 */
    immediateOnly?: boolean;
}
/** 单次投递终态；发送失败不改写 Task 执行状态。 */
export interface DeliveryResult {
    messageId: string;
    taskId: string;
    lane: Lane;
    status: 'sent' | 'failed' | 'discarded';
    deliveredAt?: number;
    error?: string;
    failure?: import('../errors.js').ContractFailure;
}
export declare function isTaskTerminal(task: Pick<TaskSnapshot, 'status'>): boolean;
export declare function isLaneTerminal(lane: Pick<LaneSnapshot, 'status'>): boolean;
export { readonlySnapshot } from '../readonly.js';
