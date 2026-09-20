/**
 * QQ OpenAPI 调用（只实现本 MVP 用到的端点）。
 *
 * 端点（2026-08-10 起域名统一为 api.bot.qq.com）：
 *   - GET  /gateway                                    取 WebSocket 接入点
 *   - POST /v2/groups/{group_openid}/messages          发群消息
 *   - POST /v2/users/{user_openid}/messages            发单聊消息
 *   - POST /v2/users/{user_openid}/stream_messages     流式发单聊消息（本 MVP 未使用）
 *
 * 发消息关键约束（群聊与单聊一致）：
 *   - `Authorization: QQBot <access_token>`；
 *   - `msg_id` 与 `event_id` **互斥**：回复用户提问用 msg_id，回复进群/加好友/按钮交互用 event_id；
 *   - `msg_seq` 与 msg_id 联合去重，同一组合不能重复发（否则 40054005）；
 *   - 被动回复窗口：群聊 5 分钟 / 单聊 60 分钟；每条消息最多回复 群聊 5 次 / 单聊 4 次。
 */

import type { Logger } from '../logger.js';
import { TokenManager } from './token.js';
import {
  SendErrorCode,
  type GatewayResponse,
  type QqApiError,
  type SendGroupMessageRequest,
  type SendUserMessageRequest,
  type SendUserStreamMessageRequest,
  type SendMessageResponse,
} from './types.js';

export interface QqApiOptions {
  apiBase: string;
  tokenManager: TokenManager;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** 单次 HTTP 请求超时（毫秒） */
  timeoutMs?: number;
}

/** 业务错误：平台用 code 表达，HTTP 状态可能是 200。 */
export class QqApiError_ extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly httpStatus: number | undefined,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'QqApiError';
  }

  /** 消息被去重（(msg_id, msg_seq) 重复） */
  get isDuplicate(): boolean {
    return this.code === SendErrorCode.DUPLICATE;
  }

  /** 消息过长，调用方应折半重试 */
  get isTooLong(): boolean {
    return this.code === SendErrorCode.TOO_LONG || this.code === SendErrorCode.TOO_LONG_OR_INVALID;
  }
}

function describeApiError(code: number | undefined, message: string | undefined): string {
  switch (code) {
    case SendErrorCode.DUPLICATE:
      return '消息被去重：(msg_id, msg_seq) 组合重复发送';
    case SendErrorCode.TOO_LONG:
      return '消息长度超限';
    case SendErrorCode.TOO_LONG_OR_INVALID:
      return '消息过长或内容异常';
    case SendErrorCode.PROACTIVE_RATE_LIMITED:
      return '主动消息超过频控限制（被动回复不受此限，请检查是否漏传 msg_id）';
    case SendErrorCode.PROACTIVE_FORBIDDEN:
      return '主动消息发送失败：无权限（被动回复不受此限）';
    default:
      return message !== undefined && message !== '' ? message : 'QQ OpenAPI 调用失败';
  }
}

export class QqApi {
  constructor(private readonly options: QqApiOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { retryOn401?: boolean } = {},
  ): Promise<T> {
    const token = await this.options.tokenManager.get();
    const url = `${this.options.apiBase.replace(/\/+$/, '')}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    timeout.unref?.();

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `QQBot ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new QqApiError_(
        `请求 ${method} ${path} 失败：${error instanceof Error ? error.message : String(error)}`,
        undefined,
        undefined,
        undefined,
      );
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = text;
    }

    // token 失效：刷新一次再试。QQ 侧对过期 token 的习惯是 401 或特定 code。
    if ((options.retryOn401 ?? true) && response.status === 401) {
      this.options.logger.warn('OpenAPI 返回 401，刷新 token 后重试一次', { path });
      await this.options.tokenManager.forceRefresh();
      return this.request<T>(method, path, body, { retryOn401: false });
    }

    const errorBody = (parsed ?? {}) as QqApiError;
    const code = typeof errorBody.code === 'number' ? errorBody.code : undefined;
    // 成功判定：HTTP 2xx 且没有非零 code
    const hasErrorCode = code !== undefined && code !== 0;
    if (!response.ok || hasErrorCode) {
      throw new QqApiError_(
        describeApiError(code, errorBody.message),
        code,
        response.status,
        parsed,
      );
    }

    return parsed as T;
  }

  /** 取 WebSocket 接入点。 */
  async getGateway(): Promise<GatewayResponse> {
    return this.request<GatewayResponse>('GET', '/gateway');
  }

  /**
   * 发一条群消息（被动回复）。
   *
   * 调用方负责分配 `msg_seq`（见 pipeline 的配额账本），因为去重是按
   * (msg_id, msg_seq) 组合判定的。
   */
  async sendGroupMessage(
    groupOpenid: string,
    message: SendGroupMessageRequest,
  ): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      'POST',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`,
      message,
    );
  }

  /**
   * 发一条私聊消息（被动回复）。
   *
   * 调用方负责分配 `msg_seq`（见 pipeline 的配额账本），因为去重是按
   * (msg_id, msg_seq) 组合判定的。
   *
   * # Note
   * 100 QPS，包括主动、被动等所有消息类型
   *
   * # Doc
   * https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
   */
  async sendUserMessage(
    userOpenId: string,
    message: SendUserMessageRequest,
  ): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      'POST',
      `/v2/users/${encodeURIComponent(userOpenId)}/messages`,
      message,
    );
  }

  /**
   * 流式发送私聊消息。
   *
   * 本 MVP 不使用：`session/prompt` 的结果在 turn 结束后才整体取回，
   * 没有增量文本可推。保留实现以便将来接流式输出。
   *
   * # Note
   * 50 QPS (单独)
   *
   * # Doc
   * https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html
   */
  async sendUserStreamMessage(
    userOpenId: string,
    message: SendUserStreamMessageRequest,
  ): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      'POST',
      `/v2/users/${encodeURIComponent(userOpenId)}/stream_messages`,
      message,
    );
  }
}
