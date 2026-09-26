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
 * 关键协议点（依据实况文档，见 docs/DESIGN.md 第 9 节）：
 *   - op10 Hello 给 `heartbeat_interval`（毫秒），客户端按它发 op1 心跳；
 *   - op1 心跳的 `d` 是**最后收到的 seq**，首次为 null；服务端回 op11 ack；
 *   - op2 Identify 的 token 是 `QQBot <access_token>`，shard 不分区时用 [0,1]；
 *   - op6 Resume 带 session_id 与 seq，成功后收到 RESUMED，**不要重新 Identify**；
 *   - 关闭码 4009/49xx 可以 Resume；4006 必须重新 Identify；4014 说明 intent 无权限。
 *
 * 重连退避：指数增长 + 抖动，上限 60 秒。心跳 ack 超时（约 2 个周期）也触发重连，
 * 因为"连着但收不到事件"比断开更危险（机器人看着在线但没人应答）。
 */

import { EventEmitter } from 'node:events';

import type { ConversationTarget, NormalizedEvent } from '../../core/connector.js';
import { flattenParts } from '../../core/content.js';
import type { Logger } from '../../logger.js';
import type { QqApi } from './api.js';
import { buildMessageParts, type MessageBodyLike } from './content.js';
import { TokenManager } from './token.js';
import {
  OpCode,
  WS_CLOSE_CODES,
  canResumeAfterClose,
  type GatewayPayload,
  type HelloPayload,
  type IdentifyPayload,
  type ReadyPayload,
  type ResumePayload,
} from './types.js';

// ---------------------------------------------------------------------------
// 会话目标（官方平台专有的 key 构造规则）
// ---------------------------------------------------------------------------

/** 官方平台的 connector.platform 值 */
export const QQ_OFFICIAL_PLATFORM = 'qq-official';

/** 单聊会话键前缀（官方 openid 字符集不含 `:`，前缀不会与真实群 openid 冲突） */
export const C2C_KEY_PREFIX = 'c2c:';

/**
 * 群聊会话：key 沿用原始 `group_openid`。
 * 保持裸 openid 是有意的——既有部署的工作区目录/对话记录都以此命名，不做迁移。
 * 跨平台碰撞由平台侧保证：其他平台的适配器必须给自己的 key 加前缀。
 */
export function groupTarget(groupOpenid: string): ConversationTarget {
  return { platform: QQ_OFFICIAL_PLATFORM, kind: 'group', id: groupOpenid, key: groupOpenid };
}

/**
 * 单聊会话：key 用 `c2c:<user_openid>`。
 * 用户 openid 与群 openid 是两套命名空间，"字面相同"完全可能，不加前缀就会把
 * 两个无关的人/群混进同一个工作区与同一份记忆。
 */
export function c2cTarget(userOpenid: string): ConversationTarget {
  return {
    platform: QQ_OFFICIAL_PLATFORM,
    kind: 'c2c',
    id: userOpenid,
    key: `${C2C_KEY_PREFIX}${userOpenid}`,
  };
}

// ---------------------------------------------------------------------------
// WebSocket 抽象（便于测试注入假实现）
// ---------------------------------------------------------------------------

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number; reason?: string }) => void): void;
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
  | 'stopped'
  | 'connecting'
  | 'identifying'
  | 'ready'
  | 'reconnecting'
  | 'resuming';

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

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
  backoff?: { baseMs: number; maxMs: number };
  now?: () => number;
  random?: () => number;
  /** 心跳抖动比例，默认 0.1（官方建议加抖动） */
  heartbeatJitterRatio?: number;
}

export class QqGateway implements QqEventSource {
  private readonly emitter = new EventEmitter();
  private ws: WebSocketLike | undefined;
  private state: GatewayState = 'stopped';
  private sessionId: string | undefined;
  private lastSeq: number | undefined;
  /** Hello 下发的真实心跳周期（毫秒），ack 超时按它计算 */
  private heartbeatIntervalMs: number | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatAckTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private lastEventAt: number | undefined;
  private stopping = false;
  private startPromise: Promise<void> | undefined;
  /** stop() 用来中断在途 connect() 的信号 */
  private stopSignal: Promise<void> | undefined;
  private signalStop: (() => void) | undefined;

  constructor(private readonly options: QqGatewayOptions) {}

  on(handler: (event: NormalizedEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }

  health(): EventSourceHealth {
    return {
      connected: this.state === 'ready',
      state: this.state,
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(this.lastSeq !== undefined ? { lastSeq: this.lastSeq } : {}),
      ...(this.lastEventAt !== undefined ? { lastEventAt: this.lastEventAt } : {}),
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped') return;
    this.stopping = false;
    // stop() 通过这个 promise 中断尚未完成的连接过程。
    // 必须做：否则在"已安排重连"（退避计时中）或 TCP 连接卡住时调用 stop()，
    // start() 的 promise 永远不 resolve，优雅退出会被拖死。实测出现过。
    this.stopSignal = new Promise<void>((resolve) => {
      this.signalStop = resolve;
    });
    this.startPromise = Promise.race([
      this.connect({ resume: false }),
      this.stopSignal.then(() => {
        this.state = 'stopped';
      }),
    ]);
    await this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    this.state = 'stopped';
    const ws = this.ws;
    this.ws = undefined;
    if (ws !== undefined) {
      try {
        ws.close(1000, 'client shutdown');
      } catch {
        /* 已断开 */
      }
    }
    // 放行可能仍在等待的 start()
    this.signalStop?.();
    await this.startPromise?.catch(() => {});
    this.startPromise = undefined;
  }

  // -------------------------------------------------------------------------
  // 连接与鉴权
  // -------------------------------------------------------------------------

  private async connect(mode: { resume: boolean }): Promise<void> {
    if (this.stopping) return;
    this.state = mode.resume && this.sessionId !== undefined ? 'resuming' : 'connecting';

    const gateway = await this.options.api.getGateway();
    const url = gateway.url;
    this.options.logger.info('连接 QQ 网关', { url, mode: mode.resume ? 'resume' : 'identify' });

    const factory = this.options.webSocketFactory ?? defaultWebSocketFactory;
    const ws = factory(url);
    this.ws = ws;

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      ws.addEventListener('open', () => {
        this.options.logger.debug('网关 WebSocket 已打开，等待 Hello');
        // 具体鉴权在收到 op10 Hello 之后进行
      });

      ws.addEventListener('message', (event) => {
        this.handleRawMessage(event.data);
        if (this.state === 'ready' || this.state === 'resuming') finish();
      });

      ws.addEventListener('error', (event) => {
        this.options.logger.warn('网关 WebSocket 错误', { message: event.message });
        finish();
      });

      ws.addEventListener('close', (event) => {
        this.handleClose(event.code, event.reason);
        finish();
      });
    });
  }

  private handleRawMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data);
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(text) as GatewayPayload;
    } catch {
      this.options.logger.warn('网关下发内容不是合法 JSON', { preview: text.slice(0, 200) });
      return;
    }
    if (typeof payload.s === 'number') this.lastSeq = payload.s;

    switch (payload.op) {
      case OpCode.HELLO:
        void this.onHello(payload.d as HelloPayload);
        return;
      case OpCode.DISPATCH:
        this.onDispatch(payload);
        return;
      case OpCode.HEARTBEAT_ACK:
        this.clearHeartbeatAckTimer();
        return;
      case OpCode.RECONNECT:
        // 服务端主动要求重连：不带 resume，按官方语义重新 Identify
        this.options.logger.info('网关要求重连（op7）');
        this.reconnect({ resume: false, reason: 'op7' });
        return;
      case OpCode.INVALID_SESSION:
        this.options.logger.warn('网关返回 Invalid Session（op9），将重新 Identify', {
          d: payload.d,
        });
        this.sessionId = undefined;
        this.lastSeq = undefined;
        this.reconnect({ resume: false, reason: 'op9' });
        return;
      default:
        this.options.logger.debug('收到未处理的 opcode', { op: payload.op });
    }
  }

  private async onHello(hello: HelloPayload): Promise<void> {
    const interval = hello?.heartbeat_interval;
    if (typeof interval !== 'number' || interval <= 0) {
      this.options.logger.error('Hello 未携带合法 heartbeat_interval，无法维持心跳', { hello });
      this.reconnect({ resume: false, reason: 'bad-hello' });
      return;
    }

    const shouldResume = this.state === 'resuming' && this.sessionId !== undefined && this.lastSeq !== undefined;
    this.state = shouldResume ? 'resuming' : 'identifying';

    try {
      const token = await this.options.tokenManager.get();
      if (shouldResume) {
        const payload: ResumePayload = {
          token: `QQBot ${token}`,
          session_id: this.sessionId as string,
          seq: this.lastSeq as number,
        };
        this.send({ op: OpCode.RESUME, d: payload });
      } else {
        const payload: IdentifyPayload = {
          token: `QQBot ${token}`,
          intents: this.options.intents,
          shard: [0, 1],
          properties: { $os: process.platform, $browser: 'qqbot-dsh', $device: 'qqbot-dsh' },
        };
        this.send({ op: OpCode.IDENTIFY, d: payload });
      }
      this.startHeartbeat(interval);
    } catch (error) {
      this.options.logger.error('鉴权失败，稍后重试', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.reconnect({ resume: false, reason: 'auth-failed' });
    }
  }

  private onDispatch(payload: GatewayPayload): void {
    this.lastEventAt = this.now();
    const type = payload.t ?? '';
    switch (type) {
      case 'READY': {
        this.state = 'ready';
        this.reconnectAttempts = 0;
        const d = (payload.d ?? {}) as ReadyPayload;
        this.sessionId = d.session_id;
        this.options.logger.info('网关就绪（READY）', {
          sessionId: this.sessionId,
          bot: d.user?.username,
          shard: d.shard,
        });
        this.emit({ kind: 'ready', at: this.now(), raw: payload as unknown as Record<string, unknown> });
        return;
      }
      case 'RESUMED': {
        this.state = 'ready';
        this.reconnectAttempts = 0;
        this.options.logger.info('会话已恢复（RESUMED）');
        this.emit({ kind: 'resumed', at: this.now(), raw: payload as unknown as Record<string, unknown> });
        return;
      }
      default:
        this.emitMessageEvents(payload, type);
    }
  }

  private emitMessageEvents(payload: GatewayPayload, type: string): void {
    const d = (payload.d ?? {}) as Record<string, unknown>;

    if (type === 'GROUP_AT_MESSAGE_CREATE' || type === 'GROUP_MESSAGE_CREATE') {
      const groupOpenid = asString(d['group_openid']);
      const msgId = asString(d['id']);
      if (groupOpenid === undefined || msgId === undefined) {
        this.options.logger.warn('消息事件缺少 group_openid 或 id，已忽略', { type });
        return;
      }
      const author = (d['author'] ?? {}) as Record<string, unknown>;
      // 富媒体/引用/卡片统一翻译成片段：content 是它的可读扁平形态（进对话记录、
      // 进日志、也是命令匹配对象），parts 供 TurnRunner 组装多模态 prompt。
      const parts = buildMessageParts(d as MessageBodyLike);
      this.emit({
        kind: 'group-at-message',
        target: groupTarget(groupOpenid),
        eventId: payload.id ?? '',
        msgId,
        senderId: asString(author['member_openid']) ?? asString(author['id']) ?? 'unknown',
        ...(asString(author['username']) !== undefined
          ? { username: asString(author['username']) as string }
          : {}),
        content: flattenParts(parts),
        parts,
        ts: parseTimestamp(d['timestamp']) ?? this.now(),
        raw: d,
      });
      return;
    }

    if (type === 'C2C_MESSAGE_CREATE') {
      const author = (d['author'] ?? {}) as Record<string, unknown>;
      // 单聊的用户 openid 在 author.user_openid；对字段缺失保持防御性回退，
      // 否则整条私聊会因为一个字段名猜错而被静默丢弃。
      const userOpenid =
        asString(author['user_openid']) ??
        asString(d['user_openid']) ??
        asString(author['id']) ??
        asString(author['union_openid']);
      const msgId = asString(d['id']);
      if (userOpenid === undefined || msgId === undefined) {
        this.options.logger.warn('单聊消息事件缺少 user_openid 或 id，已忽略', { type });
        return;
      }
      const parts = buildMessageParts(d as MessageBodyLike);
      this.emit({
        kind: 'c2c-message',
        target: c2cTarget(userOpenid),
        eventId: payload.id ?? '',
        msgId,
        senderId: userOpenid,
        content: flattenParts(parts),
        parts,
        ts: parseTimestamp(d['timestamp']) ?? this.now(),
        raw: d,
      });
      return;
    }

    if (type === 'GROUP_ADD_ROBOT') {
      const groupOpenid = asString(d['group_openid']);
      this.options.logger.info('机器人被拉入群', { groupOpenid, raw: d });
      this.emit({
        kind: 'group-add-robot',
        at: this.now(),
        ...(groupOpenid !== undefined ? { target: groupTarget(groupOpenid) } : {}),
        ...(payload.id !== undefined ? { eventId: payload.id } : {}),
        raw: d,
      });
      return;
    }

    if (type === 'FRIEND_ADD') {
      // 单聊加好友。openid 字段是 `d.openid`，其余写法只作兼容回退。
      const userOpenid =
        asString(d['openid']) ?? asString(d['user_openid']) ?? asString(d['union_openid']);
      this.options.logger.info('用户添加机器人为好友', { userOpenid, raw: d });
      this.emit({
        kind: 'c2c-friend-add',
        at: this.now(),
        ...(userOpenid !== undefined ? { target: c2cTarget(userOpenid) } : {}),
        ...(payload.id !== undefined ? { eventId: payload.id } : {}),
        raw: d,
      });
      return;
    }

    // 其余事件（互动召回、审核、频道等）本 MVP 不处理，降级为 debug 日志。
    this.options.logger.debug('未处理的事件类型', { type });
  }

  // -------------------------------------------------------------------------
  // 心跳
  // -------------------------------------------------------------------------

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatIntervalMs = intervalMs;
    const jitterRatio = this.options.heartbeatJitterRatio ?? 0.1;
    const random = this.options.random ?? Math.random;
    // 首次心跳延迟一个带抖动的周期，避免所有客户端同时打网关
    const delay = Math.max(1_000, Math.round(intervalMs * (1 - jitterRatio * random())));
    this.heartbeatTimer = setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
      this.heartbeatTimer.unref?.();
    }, delay);
    this.heartbeatTimer.unref?.();
  }

  private sendHeartbeat(): void {
    if (this.state !== 'ready' && this.state !== 'identifying' && this.state !== 'resuming') return;
    this.send({ op: OpCode.HEARTBEAT, d: this.lastSeq ?? null });

    // 等 ack：迟到或缺失都说明连接已死（"连着但收不到事件"比断开更危险）。
    // 必须用 Hello 给的真实周期，不能猜。
    const interval = this.heartbeatIntervalMs;
    if (interval === undefined) return;

    // 关键：如果已有在途的 ack 计时器，就不要重新武装。
    // 否则每次心跳都会重置计时器，于是"一直没收到 ACK"永远触发不了——
    // 表现为 TCP 相连、心跳照发、事件全无，机器人静默卡死而无人察觉。
    // 这个 bug 是被 tests/gateway.test.ts 抓出来的。
    if (this.heartbeatAckTimer !== undefined) return;

    const factor = this.options.heartbeatAckTimeoutFactor ?? 2;
    const waitMs = Math.round(interval * factor);
    this.heartbeatAckTimer = setTimeout(() => {
      this.heartbeatAckTimer = undefined;
      this.options.logger.warn('心跳未收到 ACK，判定连接失效并重连', { waitedMs: waitMs });
      this.reconnect({ resume: true, reason: 'heartbeat-timeout' });
    }, waitMs);
    this.heartbeatAckTimer.unref?.();
  }

  private clearHeartbeatAckTimer(): void {
    if (this.heartbeatAckTimer !== undefined) {
      clearTimeout(this.heartbeatAckTimer);
      this.heartbeatAckTimer = undefined;
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearTimeout(this.heartbeatTimer);
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.clearHeartbeatAckTimer();
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // 重连
  // -------------------------------------------------------------------------

  private handleClose(code: number, reason?: string): void {
    this.clearHeartbeat();
    // stopping 检查必须在这里，而不是只在 stop() 里：stop() 会先 clearTimers
    // 再关闭 socket，而 socket 的 close 事件是异步到达的——它到达时会**重新**
    // 安排一次重连，于是进程无法退出。这个竞态实测出现过。
    if (this.stopping) {
      this.state = 'stopped';
      return;
    }
    const known = WS_CLOSE_CODES[code];
    this.options.logger.warn('网关连接关闭', {
      code,
      reason,
      meaning: known ?? '未知关闭码',
    });
    this.emit({
      kind: 'disconnected',
      at: this.now(),
      reason: `${code}${known !== undefined ? ` ${known}` : ''}`,
    });
    // 4006/4013/4014 等必须重新 Identify；4009/49xx 可尝试 Resume
    const resume = canResumeAfterClose(code) && this.sessionId !== undefined;
    this.reconnect({ resume, reason: `close:${code}` });
  }

  private reconnect(mode: { resume: boolean; reason: string }): void {
    if (this.stopping) return;
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = undefined;
    if (ws !== undefined) {
      try {
        ws.close(1000, 'reconnect');
      } catch {
        /* 忽略 */
      }
    }

    const { baseMs, maxMs } = this.options.backoff ?? { baseMs: 1_000, maxMs: 60_000 };
    const random = this.options.random ?? Math.random;
    this.reconnectAttempts += 1;
    const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(this.reconnectAttempts - 1, 10));
    // 抖动：0.5~1.5 倍，避免多实例同时重连
    const delay = Math.round(exponential * (0.5 + random()));

    this.state = 'reconnecting';
    this.options.logger.info('安排重连', {
      attempt: this.reconnectAttempts,
      delayMs: delay,
      resume: mode.resume,
      reason: mode.reason,
    });

    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopping) return;
      void this.connect(mode).catch((error: unknown) => {
        this.options.logger.error('重连失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.reconnect({ resume: false, reason: 'connect-error' });
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private send(payload: GatewayPayload): void {
    const ws = this.ws;
    if (ws === undefined) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      this.options.logger.warn('发送网关帧失败', {
        op: payload.op,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emit(event: NormalizedEvent): void {
    this.emitter.emit('event', event);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 解析 RFC3339 字符串或 unix 秒/毫秒数字，失败返回 undefined。 */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') {
    // 小于 1e12 视为秒
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber < 1e12 ? asNumber * 1000 : asNumber;
  }
  return undefined;
}

const defaultWebSocketFactory: WebSocketFactory = (url) => {
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (Ctor === undefined) {
    throw new Error(
      '当前 Node 运行时没有全局 WebSocket。需要 Node 22+；更早版本请传入 webSocketFactory。',
    );
  }
  return new Ctor(url);
};
