import { Intent } from '@qqbot/contracts';

/**
 * QQ 官方开放平台 wire 类型（api-v2）。
 *
 * 只声明本 MVP 真正用到的部分：鉴权、网关生命周期、群 @ 消息 / 单聊消息事件、发消息。
 * 未核实的字段一律标 `unknown` 而不是猜类型——猜错类型比没有类型更危险。
 *
 * 依据：docs/ARCHITECTURE.md 的「来源」列出的实况文档；旧仓库
 * (github.com/tencent-connect/bot-docs) 已废弃，不作为依据。
 */

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

/** POST /app/getAppAccessToken 请求体 */
export type { AppAccessTokenRequest } from '@qqbot/contracts';

/**
 * 鉴权响应。
 *
 * ⚠ 两个坑：
 *   1. `expires_in` 是**字符串**（例如 "7200"），不是数字；
 *   2. 失败时 HTTP 状态码仍是 200，必须靠 `code` 判断，
 *      典型错误码 100007（appid 无效）、100016（secret 错误）、100001（限频）。
 */
export type { AppAccessTokenResponse } from '@qqbot/contracts';

// ---------------------------------------------------------------------------
// 网关
// ---------------------------------------------------------------------------

/** GET /gateway 响应 */
export type { GatewayResponse } from '@qqbot/contracts';

/** GET /gateway/bot 响应（本 MVP 只用 url，其余留作诊断） */
export type { GatewayBotResponse } from '@qqbot/contracts';

/** 网关下行的通用信封 */
export type { GatewayPayload } from '@qqbot/contracts';

/** opcode 全集（见实况文档 OpCode 表） */
export { OpCode } from '@qqbot/contracts';

export type { OpCodeValue } from '@qqbot/contracts';

/** op=10 Hello */
export type { HelloPayload } from '@qqbot/contracts';

/** op=2 Identify */
export type { IdentifyPayload } from '@qqbot/contracts';

/** op=6 Resume */
export type { ResumePayload } from '@qqbot/contracts';

/** READY / RESUMED 的 d */
export type { ReadyPayload } from '@qqbot/contracts';

/** WS 关闭码 → 应采取的动作 */
export { WS_CLOSE_CODES } from '@qqbot/contracts';

/** 该关闭码是否可以用 Resume 恢复（否则必须重新 Identify） */
export function canResumeAfterClose(code: number): boolean {
  return code === 4009 || code === 4900 || (code >= 4901 && code <= 4913);
}

// ---------------------------------------------------------------------------
// intents
// ---------------------------------------------------------------------------

/**
 * intents 位掩码。
 *
 * 注意：`GROUP_MEMBER_EVENT (1<<24)` **不在官方 intents 表里**，但官方自己的
 * 事件页与多家 SDK 都在用它来订阅 GROUP_ADD_ROBOT 等事件。因此保留为可配置项，
 * 若连接被 4014 拒绝，退回 1<<25。
 */
export { Intent } from '@qqbot/contracts';

/**
 * 群 @消息 + 单聊消息 + 进群事件（默认订阅集合）。
 *
 * `GROUP_AND_C2C_EVENT (1<<25)` 同时承载 `GROUP_AT_MESSAGE_CREATE` 与
 * `C2C_MESSAGE_CREATE`——想只服务群聊也绕不开它（intent 粒度就是这样的）。
 * 关闭单聊请在业务层用 `QQ_C2C_ENABLED=false`，而不是改 intent。
 */
export { DEFAULT_INTENTS } from '@qqbot/contracts';

/** 把掩码还原成可读的 intent 名列表，用于日志与排障 */
export function describeIntents(mask: number): string[] {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(Intent)) {
    if ((mask & bit) !== 0) names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// 事件（op=0 Dispatch）
// ---------------------------------------------------------------------------

/**
 * 接收侧的消息内容类型（`message_type`）。
 *
 * 依据官方「消息类型」页与 group_message_create / c2c_message_create 事件页：
 *   0=普通文本(content) / 3=结构化卡片(ark_data) / 101=并行消息 /
 *   102=聊天记录 / 103=引用消息(msg_elements)。
 * ⚠ 图片、视频、语音、文件**不**由 message_type 表达，而是走 `attachments`。
 */
export { MessageType } from '@qqbot/contracts';

/**
 * 消息场景上下文。
 *
 * `ext` 是 `key=value` 字符串数组，已核实会出现：
 *   - `msg_idx=...`       本条消息索引（官方建议用它做去重）
 *   - `ref_msg_idx=...`   被引用的消息索引
 *   - `auth_token=...`    鉴权令牌
 */
export type { MessageScene } from '@qqbot/contracts';

/**
 * 消息附件。
 *
 * `content_type` 是判定附件种类的唯一依据，已核实取值：
 * `voice`（语音）、`image/jpeg`、`image/png`、`image/gif`、`video/mp4`、`file`（群文件）。
 * 图片附件会额外带 `width` / `height`。
 */
export type { MessageAttachment } from '@qqbot/contracts';

/** 结构化卡片（message_type=3）的数据 */
export type { ArkData } from '@qqbot/contracts';

/**
 * 消息元素（message_type=103 引用消息时，被引用的内容在这里）。
 *
 * 结构是**递归**的：元素自己也可能带 `msg_elements`（引用里再引用）。
 * `message_type` 取值与事件主体一致（0/3/101/102/103）。
 */
export type { MsgElement } from '@qqbot/contracts';

/** 群 @机器人 / 群全量消息事件的 d（两个事件字段完全一致） */
export type { GroupMessageEvent } from '@qqbot/contracts';

/** C2C_MESSAGE_CREATE（单聊消息）的 d */
export type { C2CMessageEvent } from '@qqbot/contracts';

/** GROUP_ADD_ROBOT 的 d（时间戳是 unix 秒，不是 RFC3339） */
export type { GroupAddRobotEvent } from '@qqbot/contracts';

/** FRIEND_ADD（用户添加机器人好友）的 d */
export type { FriendAddEvent } from '@qqbot/contracts';

// ---------------------------------------------------------------------------
// 发消息
// ---------------------------------------------------------------------------

/** 消息类型。群聊支持 0/2/7；单聊另有 6（input_notify） */
export { MsgType } from '@qqbot/contracts';

// ---------------------------------------------------------------------------
// 富媒体上传（/files）
// ---------------------------------------------------------------------------

/**
 * 上传文件的类型（file_type）。本期只用 1 与 4；2/3 留作扩展。
 *
 * ⚠ 待实测：file_type=4（文件）是否对机器人开放、各类型的大小上限，
 * 见 docs/RICH-MEDIA-PLAN.md §10。
 */
export { MediaFileType } from '@qqbot/contracts';

/**
 * POST /v2/groups/{group_openid}/files 与 /v2/users/{openid}/files 请求体。
 *
 * `srv_send_msg=false`：只上传拿 file_info，发送仍走 /messages 端点——
 * 这样才能保持 msg_id / msg_seq 的被动回复语义（上传与发送分离）。
 * 本服务没有公网可下载地址，所以只用 file_data（base64），不用 url。
 */
export type { UploadFileRequest } from '@qqbot/contracts';

/** 上传响应。file_info 有时效（ttl 秒），拿到就要立刻用，不缓存。 */
export type { UploadFileResponse } from '@qqbot/contracts';

/**
 * 发送消息请求体。**群聊与单聊共用同一套字段**，只是端点不同：
 *   - 群聊：POST /v2/groups/{group_openid}/messages
 *   - 单聊：POST /v2/users/{user_openid}/messages
 *
 * ⚠ `msg_id` 与 `event_id` **互斥**：
 *   - 回复用户提问 → 用 `msg_id`（来自事件 d.id）
 *   - 回复进群/加好友、按钮交互 → 用 `event_id`（来自信封 id）
 * `msg_seq` 默认 1；同一 (msg_id, msg_seq) 组合不能重复发送，否则 40054005。
 */
export type { SendMessageRequest } from '@qqbot/contracts';

/** 群聊发消息请求体（字段与单聊完全一致，保留独立名字便于端点上做类型区分） */
export type { SendGroupMessageRequest } from '@qqbot/contracts';

/** 单聊发消息请求体（字段与群聊完全一致） */
export type { SendUserMessageRequest } from '@qqbot/contracts';

/**
 * POST /v2/users/{user_openid}/stream_messages 请求体（流式单聊）。
 *
 * 本 MVP 不使用流式发送（DSH 的一轮结果在 turn 结束后整体取回），
 * 这里保留类型定义以便将来接入"边生成边刷新"的输出方式。
 * `input_state`：1 生成中 / 2 生成结束 / 3 生成超时（以官方文档为准）。
 */
export type { SendUserStreamMessageRequest } from '@qqbot/contracts';

export type { SendMessageResponse } from '@qqbot/contracts';

/**
 * 发送消息的已知错误码（用于决定"重试/降级/放弃"）。
 * 只列本 MVP 会真正处理的。
 */
export { SendErrorCode } from '@qqbot/contracts';

/** QQ OpenAPI 的通用错误响应体 */
export type { QqApiError } from '@qqbot/contracts';
