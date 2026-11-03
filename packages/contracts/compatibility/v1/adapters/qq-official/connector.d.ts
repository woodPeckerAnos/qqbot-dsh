import type { DeepReadonly } from '../../readonly.js';
/**
 * 官方开放平台连接器：把 TokenManager + QqApi + QqGateway 包装成 BotConnector。
 *
 * 所有官方平台专有的行为都收在这个适配器里：
 *   - 回复时把编排层的 seq 映射为 msg_seq、按互斥规则选 msg_id / event_id；
 *   - 按 QQ_MSG_TYPE 渲染纯文本或 markdown 请求体；
 *   - 回复策略声明被动窗口约束（群 5 次/5 分钟、单聊 4 次/60 分钟）。
 *
 * 编排层只看到 BotConnector 接口，不感知以上任何细节。
 */
/**
 * 官方开放平台连接器：把 TokenManager + QqApi + QqGateway 包装成 BotConnector。
 *
 * 所有官方平台专有的行为都收在这个适配器里：
 *   - 回复时把编排层的 seq 映射为 msg_seq、按互斥规则选 msg_id / event_id；
 *   - 按 QQ_MSG_TYPE 渲染纯文本或 markdown 请求体；
 *   - 回复策略声明被动窗口约束（群 5 次/5 分钟、单聊 4 次/60 分钟）。
 *
 * 编排层只看到 BotConnector 接口，不感知以上任何细节。
 */
import type { ConnectorHealth, ConversationKind, MediaBytes, MediaFetchOptions, ConversationTarget, NormalizedEvent, OutgoingMessage, ProactiveResult, RemoteMedia, ReplyContext, ReplyPolicy } from '../../core/connector.js';
import type { ForwardConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import type { QqApi } from './api.js';
import type { QqGateway, WebSocketFactory } from './gateway.js';
import type { TokenManager } from './token.js';
/** access_token 状态快照（health 展示用） */
interface TokenSnapshotValue {
    hasToken: boolean;
    expiresInMs: number;
}
export type TokenSnapshot = DeepReadonly<TokenSnapshotValue>;
/** 官方连接器的配置（由 config.ts 的 config.qq 映射而来） */
export interface QqOfficialConnectorOptions {
    appId: string;
    appSecret: string;
    apiBase: string;
    intents: number;
    msgType: 0 | 2;
    /** 是否响应单聊消息（intent 层无法只订群聊，所以在业务层拦） */
    acceptsC2C: boolean;
    /** 回复策略：群聊与单聊分开（官方单聊上限低于群聊） */
    groupPolicy: ReplyPolicy;
    c2cPolicy: ReplyPolicy;
    /**
     * 转发块（聊天记录形态的 msg_elements）展开配额（config.attachments.forward）。
     * 官方接收侧只定义了 0/3/103 三种 message_type，转发能力按"尽力而为 + 实测"
     * 定位，见 docs/FORWARD-FILE-INGRESS-PLAN.md §3.2。
     */
    forward?: ForwardConfig;
    /** 转发块展开结果上报（/metrics 计数） */
    onForward?: (info: {
        ok: boolean;
        nodes: number;
    }) => void;
    logger: Logger;
    /** 测试注入 */
    webSocketFactory?: WebSocketFactory;
    fetchImpl?: typeof fetch;
}
export interface QqOfficialConnector {
    readonly platform: 'qq-official';
    readonly tokenManager: TokenManager;
    readonly api: QqApi;
    readonly gateway: QqGateway;
    on(handler: (event: NormalizedEvent) => void): () => void;
    get acceptsC2C(): boolean;
    /**
     * 启动：先验证一次鉴权，把配置错误挡在"连着但没权限"之前，再启动网关。
     * 鉴权失败时抛错，由 main.ts 决定是降级运行还是整体退出。
     */
    start(): Promise<void>;
    stop(): Promise<void>;
    policy(kind: ConversationKind): ReplyPolicy;
    reply(ctx: ReplyContext, out: OutgoingMessage): Promise<void>;
    /**
     * 【主动发言能力】官方通道的主动推送**不是我们能选的**：
     *   - 官方文档载明「主动推送能力于 2025-04-21 起不再提供」；
     *   - 群聊主动消息每月 4 条，单聊同；子频道另有每天 20 条/每秒 5 条；
     *   - 用户还可以在客户端关闭「接收主动消息」，关闭后主动消息一律发送失败。
     *
     * 因此这个方法的实现就是**什么都不做**（do nothing），用返回值如实告诉外层
     * 「这个平台没有主动发言能力」。这不是占位符，而是**定稿的保守行为**：
     * 一旦官方开放能力，只需要在这里补一次 api.sendGroupMessage/sendUserMessage
     * 调用（不带 msg_id / event_id），外层逻辑一行都不用改。
     *
     * 刻意不抛错、不 warn 刷日志：外层已经按 unsupported 记降级计数，
     * 这里再打日志只会让"官方通道每次介入都刷一条告警"。
     */
    proactive(_target: ConversationTarget, _out: OutgoingMessage): Promise<ProactiveResult>;
    /**
     * 取官方多媒体 CDN 的字节（图片内联进多模态 prompt 用）。
     *
     * 鉴权策略：先带 `Authorization: QQBot <access_token>` 请求；只有在收到
     * 401/403 时才裸请求一次兜底。这样"需要鉴权"的形态能过，"公开 CDN"的形态
     * 也不会因为多带一个头而被拒。网络错误不重试，避免把一次超时变成两次。
     */
    fetchMedia(media: RemoteMedia, options: MediaFetchOptions): Promise<MediaBytes | undefined>;
    health(): ConnectorHealth;
}
export type createQqOfficialConnectorFactory = (options: QqOfficialConnectorOptions) => QqOfficialConnector;
export {};
