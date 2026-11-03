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
import type { TokenManager } from './token.js';
import type {
  GatewayResponse,
  SendGroupMessageRequest,
  SendUserMessageRequest,
  SendUserStreamMessageRequest,
  SendMessageResponse,
  UploadFileRequest,
  UploadFileResponse,
} from './types.js';
export interface QqApiOptions {
  apiBase: string;
  tokenManager: TokenManager;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** 单次 HTTP 请求超时（毫秒） */
  timeoutMs?: number;
}
export class QqApiError_ extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly httpStatus: number | undefined,
    readonly body: unknown
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
export type createQqApiError_Factory = (
  message: string,
  code: number | undefined,
  httpStatus: number | undefined,
  body: unknown
) => QqApiError_;
export interface QqApi {
  /** 取 WebSocket 接入点。 */
  getGateway(): Promise<GatewayResponse>;
  /**
   * 上传群富媒体文件，返回可用来发 msg_type=7 消息的 file_info。
   *
   * 注意（依据 docs/RICH-MEDIA-PLAN.md §6.1）：
   *   - `srv_send_msg` 必须 false：只上传不发送，发送走 /messages 端点，
   *     否则丢掉 msg_id/msg_seq 的被动回复语义；
   *   - file_info 有时效，调用方拿到后要立刻发送，不缓存；
   *   - 上传的是 base64 后的字节（体积 +33%），单次超时放宽到 60s。
   */
  uploadGroupFile(
    groupOpenid: string,
    file: UploadFileRequest,
    signal?: AbortSignal
  ): Promise<UploadFileResponse>;
  /** 上传单聊富媒体文件（语义同 uploadGroupFile）。 */
  uploadUserFile(
    userOpenId: string,
    file: UploadFileRequest,
    signal?: AbortSignal
  ): Promise<UploadFileResponse>;
  /**
   * 发一条群消息（被动回复）。
   *
   * 调用方负责分配 `msg_seq`（见 pipeline 的配额账本），因为去重是按
   * (msg_id, msg_seq) 组合判定的。
   */
  sendGroupMessage(
    groupOpenid: string,
    message: SendGroupMessageRequest,
    signal?: AbortSignal
  ): Promise<SendMessageResponse>;
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
  sendUserMessage(
    userOpenId: string,
    message: SendUserMessageRequest,
    signal?: AbortSignal
  ): Promise<SendMessageResponse>;
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
  sendUserStreamMessage(
    userOpenId: string,
    message: SendUserStreamMessageRequest
  ): Promise<SendMessageResponse>;
}
export type createQqApiFactory = (options: QqApiOptions) => QqApi;

import { SendErrorCode } from './types.js';
