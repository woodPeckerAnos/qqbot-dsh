/**
 * QQ OpenAPI 调用（只实现本 MVP 用到的端点）。
 *
 * 端点（2026-08-10 起域名统一为 api.bot.qq.com）：
 *   - GET  /gateway                                    取 WebSocket 接入点
 *   - POST /v2/groups/{group_openid}/messages          发群消息
 *   - POST /v2/users/{user_openid}/messages            发单聊消息
 *   - POST /v2/users/{user_openid}/stream_messages     流式发单聊消息（本 MVP 未使用）
 *   - POST /v2/groups/{group_openid}/files             上传群富媒体（拿 file_info）
 *   - POST /v2/users/{user_openid}/files               上传单聊富媒体（拿 file_info）
 *
 * 发消息关键约束（群聊与单聊一致）：
 *   - `Authorization: QQBot <access_token>`；
 *   - `msg_id` 与 `event_id` **互斥**：回复用户提问用 msg_id，回复进群/加好友/按钮交互用 event_id；
 *   - `msg_seq` 与 msg_id 联合去重，同一组合不能重复发（否则 40054005）；
 *   - 被动回复窗口：群聊 5 分钟 / 单聊 60 分钟；每条消息最多回复 群聊 5 次 / 单聊 4 次。
 */

import type { Logger } from '../../logger.js';
import { TokenManager } from './token.js';
import {
  SendErrorCode,
  type GatewayResponse,
  type QqApiError,
  type SendGroupMessageRequest,
  type SendUserMessageRequest,
  type SendUserStreamMessageRequest,
  type SendMessageResponse,
  type UploadFileRequest,
  type UploadFileResponse,
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

  /** 消息过长：终态失败，禁止以新长度重发同一消息。 */
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
    options: { retryOn401?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const token = await this.options.tokenManager.get();
    const url = `${this.options.apiBase.replace(/\/+$/, '')}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.options.timeoutMs ?? 15_000,
    );
    timeout.unref?.();

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `QQBot ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      });
      text = await response.text();
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

    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = text;
    }

    // 401 后刷新凭证供后续消息使用；只有 GET 允许刷新后重读，消息 POST 不重发。
    if (response.status === 401 && method !== 'GET') {
      void this.options.tokenManager.forceRefresh().catch(() => {});
    }
    if ((options.retryOn401 ?? method === 'GET') && response.status === 401) {
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
   * 上传群富媒体文件，返回可用来发 msg_type=7 消息的 file_info。
   *
   * 注意（依据 docs/RICH-MEDIA-PLAN.md §6.1）：
   *   - `srv_send_msg` 必须 false：只上传不发送，发送走 /messages 端点，
   *     否则丢掉 msg_id/msg_seq 的被动回复语义；
   *   - file_info 有时效，调用方拿到后要立刻发送，不缓存；
   *   - 上传的是 base64 后的字节（体积 +33%），单次超时放宽到 60s。
   */
  async uploadGroupFile(
    groupOpenid: string,
    file: UploadFileRequest,
    signal?: AbortSignal,
  ): Promise<UploadFileResponse> {
    return this.request<UploadFileResponse>(
      'POST',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/files`,
      file,
      { timeoutMs: 60_000, retryOn401: false, signal },
    );
  }

  /** 上传单聊富媒体文件（语义同 uploadGroupFile）。 */
  async uploadUserFile(
    userOpenId: string,
    file: UploadFileRequest,
    signal?: AbortSignal,
  ): Promise<UploadFileResponse> {
    return this.request<UploadFileResponse>(
      'POST',
      `/v2/users/${encodeURIComponent(userOpenId)}/files`,
      file,
      { timeoutMs: 60_000, retryOn401: false, signal },
    );
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
    signal?: AbortSignal,
  ): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      'POST',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`,
      message,
      { retryOn401: false, signal },
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
    signal?: AbortSignal,
  ): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      'POST',
      `/v2/users/${encodeURIComponent(userOpenId)}/messages`,
      message,
      { retryOn401: false, signal },
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
