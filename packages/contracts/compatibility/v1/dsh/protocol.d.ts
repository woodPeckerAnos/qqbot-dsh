/**
 * DSH SDK wire 协议客户端：stdio 上的 NDJSON JSON-RPC 2.0。
 *
 * 为什么自研而不是用官方 SDK 客户端：`@deepseek-ai/dsh-sdk-client` **未发布到
 * npm**。服务端协议本身很小（3 个方法 + 4 个通知），自研的收益是零内部包依赖，
 * 不会因为 DSH 内部包版本漂移而碎掉。
 *
 * 协议要点（依据 @deepseek-ai/dsh-sdk-protocol 的 lib/types/types.d.ts）：
 *   - 一行一个 JSON-RPC 消息；
 *   - 有 id 无 method = 响应；有 id 有 method = 请求；只有 method = 通知；
 *   - **stdout 只允许协议帧**，任何非 JSON 行都必须被当成错误而不是静默忽略，
 *     否则帧错位会导致后续请求永远等不到响应（这类 bug 极难排查）；
 *   - `session/prompt` 只返回入队回执 `{messageId}`，真正结果在 `session.event`。
 */
/** 服务端身份，用于校验协议漂移 */
export declare const SDK_SERVER_INFO_NAME = "deepseek-harness-sdk-runtime";
export interface InitializeParams {
    /** 会话的工作目录。**进程级**：同进程的所有会话共用这个 cwd。 */
    cwd: string;
    provider: string;
    model: string;
    reasoningEffort?: string;
    maxTokens?: number;
}
export interface InitializeResult {
    serverInfo: {
        name: string;
        version: string;
    };
}
/**
 * 内联图片允许的 MIME 集合。
 *
 * 这就是 runtime 准入时接受的四种（见 @deepseek-ai/dsh-sdk-protocol 的
 * SdkEncodedImageBlock）：超出这个集合（例如 bmp/heic）不能内联，只能降级成文字说明。
 */
export type PromptImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
/**
 * 提示内容块。
 *
 * image 块携带**原始栅格字节的 base64**，由 runtime 在准入时写入它自己的附件存储
 * （不需要我们先落盘）。这就是"多模态输入"的通道：文本块给出上下文与图片说明，
 * 图片块给出像素本身。
 */
export type PromptContentBlock = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    data: string;
    mimeType: PromptImageMimeType;
};
export interface SessionPromptParams {
    sessionId: string;
    contentBlocks: PromptContentBlock[];
}
export interface SessionPromptResult {
    /** 已入队用户消息的 id；**不是**助手消息 id，也不是本轮结束信号 */
    messageId: string;
}
/** 会话日志事件的最小结构（我们只关心 type/seq/data，其余透传） */
export interface SessionEventEnvelope {
    type: string;
    seq: number;
    time?: number;
    data: Record<string, unknown>;
}
export interface SessionEventNotification {
    sessionId: string;
    event: SessionEventEnvelope;
}
export type parseSessionEvent = (params: unknown) => SessionEventNotification | undefined;
export interface SessionStatusNotification {
    sessionId: string;
    status: 'idle' | 'running';
}
/**
 * `subagent.started` 载荷：runtime 内创建了一个子代理会话。
 *
 * 桥接层用它做两件事：
 *   1. runtime 池给对应 entry 记一个"活子代理"，豁免空闲回收/LRU 驱逐
 *      （子代理驻留在 runtime 进程内，所属执行必须等待它结束）；
 *   2. 统计与日志（health 可观测）。
 */
export interface SubagentStartedNotification {
    /** 发起委托的父会话（= 某会话的 currentSessionId） */
    parentSessionId: string;
    /** 新建的子会话 */
    childSessionId: string;
}
/**
 * `subagent.finished` 载荷：一个进程内子代理运行结束（远程运行不会上报）。
 *
 * `lastAssistantMessage` 是子代理最后一条非空 assistant 消息（dsh-llm 的
 * ContentBlock 数组）。DshLaneRunner 等待所属子代理结束并检查其状态，父代理
 * 把结果整理成面向用户的最终回复；这里的子代理正文只用于诊断，不独立投递。
 */
export interface SubagentFinishedNotification {
    provider: string;
    /** 子代理 id（本地运行 = childSessionId） */
    agentId: string;
    parentSessionId: string;
    childSessionId: string;
    /** 部署映射后的运行结果（completed → ok；其余按 maxTokensAsSuccess 归并） */
    status: 'ok' | 'error';
    /** provider 上报的停止原因（completed / aborted / max-tokens / …） */
    stopReason: string;
    lastAssistantMessage?: readonly Record<string, unknown>[];
}
/** 协议方法名 → 载荷形状 */
export interface HarnessSdkRequestMap {
    initialize: {
        params: InitializeParams;
        result: InitializeResult;
    };
    'session/prompt': {
        params: SessionPromptParams;
        result: SessionPromptResult;
    };
    shutdown: {
        params: undefined;
        result: Record<string, never>;
    };
}
export type HarnessSdkMethod = keyof HarnessSdkRequestMap;
export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}
export declare class JsonRpcResponseError extends Error {
    readonly code: number;
    readonly data?: unknown | undefined;
    constructor(code: number, message: string, data?: unknown | undefined);
}
export type createJsonRpcResponseErrorFactory = (code: number, message: string, data?: unknown) => JsonRpcResponseError;
export declare class ProtocolViolationError extends Error {
    readonly rawLine: string;
    constructor(message: string, rawLine: string);
}
export type createProtocolViolationErrorFactory = (message: string, rawLine: string) => ProtocolViolationError;
export interface HarnessSdkClientEvents {
    'session.event': (notification: SessionEventNotification) => void;
    'session.status': (notification: SessionStatusNotification) => void;
    'subagent.started': (payload: SubagentStartedNotification) => void;
    'subagent.finished': (payload: SubagentFinishedNotification) => void;
    /** stdout 污染 / 无法解析的帧 */
    violation: (error: ProtocolViolationError) => void;
    invalid: (reason: string) => void;
    /** 传输层收到无法归类的消息（未知通知），仅用于诊断 */
    unknown: (frame: unknown) => void;
    close: () => void;
}
export interface HarnessSdkClientOptions {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    /** 单次请求超时（毫秒）。默认 30s；initialize 可能更久，由调用方覆盖。 */
    requestTimeoutMs?: number;
    /** 非协议 stdout 的处理策略：throw 会让流报错，collect 只记录事件 */
    onViolation?: 'throw' | 'collect';
}
export interface HarnessSdkClient {
    on<E extends keyof HarnessSdkClientEvents>(event: E, listener: HarnessSdkClientEvents[E]): this;
    off<E extends keyof HarnessSdkClientEvents>(event: E, listener: HarnessSdkClientEvents[E]): this;
    get isClosed(): boolean;
    /** 是否有在途请求（用于判断进程是否卡住） */
    get pendingCount(): number;
    /** 发送一次请求。超时与错误响应都会 reject。 */
    request<M extends HarnessSdkMethod>(method: M, params: HarnessSdkRequestMap[M]['params'], options?: {
        timeoutMs?: number;
    }): Promise<HarnessSdkRequestMap[M]['result']>;
    initialize(params: InitializeParams, options?: {
        timeoutMs?: number;
    }): Promise<InitializeResult>;
    prompt(params: SessionPromptParams, options?: {
        timeoutMs?: number;
    }): Promise<SessionPromptResult>;
    shutdown(options?: {
        timeoutMs?: number;
    }): Promise<Record<string, never>>;
    /** 关闭传输层监听（不销毁底层流，流的所有权在调用方） */
    close(): void;
}
export type createHarnessSdkClientFactory = (options: HarnessSdkClientOptions) => HarnessSdkClient;
