/**
 * QQ 网关 WebSocket 生命周期状态机。
 *
 * 实现的是官方 WebSocket 接入方式（本 MVP 唯一支持的事件通道，无需公网入口）。
 *
 * 状态流转：
 *
 *   stopped ──start()──► connecting ──ws open──► identifying ──READY──► ready
 *                             ▲                                            │
 *                             │                                    断线/op7/心跳超时
 *                             │                                            ▼
 *                          reconnecting ◄──── resume 失败/4006 ──── resuming
 *
 * 关键协议点（依据实况文档，见 docs/ARCHITECTURE.md 的「来源」）：
 *   - op10 Hello 给 `heartbeat_interval`（毫秒），客户端按它发 op1 心跳；
 *   - op1 心跳的 `d` 是**最后收到的 seq**，首次为 null；服务端回 op11 ack；
 *   - op2 Identify 的 token 是 `QQBot <access_token>`，shard 不分区时用 [0,1]；
 *   - op6 Resume 带 session_id 与 seq，成功后收到 RESUMED，**不要重新 Identify**；
 *   - 关闭码 4009/49xx 可以 Resume；4006 必须重新 Identify；4014 说明 intent 无权限。
 *
 * 重连退避：指数增长 + 抖动，上限 60 秒。心跳 ack 超时（约 2 个周期）也触发重连，
 * 因为"连着但收不到事件"比断开更危险（机器人看着在线但没人应答）。
 */
/**
 * QQ 网关 WebSocket 生命周期状态机。
 *
 * 实现的是官方 WebSocket 接入方式（本 MVP 唯一支持的事件通道，无需公网入口）。
 *
 * 状态流转：
 *
 *   stopped ──start()──► connecting ──ws open──► identifying ──READY──► ready
 *                             ▲                                            │
 *                             │                                    断线/op7/心跳超时
 *                             │                                            ▼
 *                          reconnecting ◄──── resume 失败/4006 ──── resuming
 *
 * 关键协议点（依据实况文档，见 docs/ARCHITECTURE.md 的「来源」）：
 *   - op10 Hello 给 `heartbeat_interval`（毫秒），客户端按它发 op1 心跳；
 *   - op1 心跳的 `d` 是**最后收到的 seq**，首次为 null；服务端回 op11 ack；
 *   - op2 Identify 的 token 是 `QQBot <access_token>`，shard 不分区时用 [0,1]；
 *   - op6 Resume 带 session_id 与 seq，成功后收到 RESUMED，**不要重新 Identify**；
 *   - 关闭码 4009/49xx 可以 Resume；4006 必须重新 Identify；4014 说明 intent 无权限。
 *
 * 重连退避：指数增长 + 抖动，上限 60 秒。心跳 ack 超时（约 2 个周期）也触发重连，
 * 因为"连着但收不到事件"比断开更危险（机器人看着在线但没人应答）。
 */
import type { ConversationTarget, NormalizedEvent } from '../../core/connector.js';
import type { ForwardConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import type { QqApi } from './api.js';
import type { TokenManager } from './token.js';
/** 官方平台的 connector.platform 值 */
export const QQ_OFFICIAL_PLATFORM = 'qq-official';
/** 单聊会话键前缀（官方 openid 字符集不含 `:`，前缀不会与真实群 openid 冲突） */
export const C2C_KEY_PREFIX = 'c2c:';
/**
 * 群聊会话：key 沿用原始 `group_openid`。
 * 保持裸 openid 是有意的——既有部署的工作区目录/对话记录都以此命名，不做迁移。
 * 跨平台碰撞由平台侧保证：其他平台的适配器必须给自己的 key 加前缀。
 */
export type groupTarget = (groupOpenid: string) => ConversationTarget;
/**
 * 单聊会话：key 用 `c2c:<user_openid>`。
 * 用户 openid 与群 openid 是两套命名空间，"字面相同"完全可能，不加前缀就会把
 * 两个无关的人/群混进同一个工作区与同一份记忆。
 */
export type c2cTarget = (userOpenid: string) => ConversationTarget;
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason?: string }) => void
  ): void;
  addEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;
export interface QqEventSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(handler: (event: NormalizedEvent) => void): () => void;
  health(): EventSourceHealth;
}
export interface EventSourceHealth {
  connected: boolean;
  state: GatewayState;
  sessionId?: string;
  lastSeq?: number;
  lastEventAt?: number;
  reconnectAttempts: number;
}
export type GatewayState =
  'stopped' | 'connecting' | 'identifying' | 'ready' | 'reconnecting' | 'resuming';
export interface QqGatewayOptions {
  api: Pick<QqApi, 'getGateway'>;
  tokenManager: TokenManager;
  intents: number;
  logger: Logger;
  /** WebSocket 工厂，默认用全局 WebSocket（Node 22+ 内置） */
  webSocketFactory?: WebSocketFactory;
  /** 心跳 ack 等待倍数：超过 interval × 该值没收到 ack 就重连 */
  heartbeatAckTimeoutFactor?: number;
  /** 退避参数（测试里调小） */
  backoff?: {
    baseMs: number;
    maxMs: number;
  };
  now?: () => number;
  random?: () => number;
  /** 心跳抖动比例，默认 0.1（官方建议加抖动） */
  heartbeatJitterRatio?: number;
  /**
   * 转发块（聊天记录形态的 msg_elements）展开配额
   * （config.attachments.forward）。缺省用官方适配器的保守内置值。
   */
  forward?: ForwardConfig;
  /** 转发块展开结果上报（/metrics 计数）；官方侧不需要回查，纯翻译 */
  onForward?: (info: { ok: boolean; nodes: number }) => void;
}
export interface QqGateway {
  on(handler: (event: NormalizedEvent) => void): () => void;
  health(): EventSourceHealth;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export type createQqGatewayFactory = (options: QqGatewayOptions) => QqGateway;
/** 解析 RFC3339 字符串或 unix 秒/毫秒数字，失败返回 undefined。 */
export type parseTimestamp = (value: unknown) => number | undefined;
