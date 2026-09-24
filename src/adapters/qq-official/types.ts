/**
 * QQ 官方开放平台 wire 类型（api-v2）。
 *
 * 只声明本 MVP 真正用到的部分：鉴权、网关生命周期、群 @ 消息 / 单聊消息事件、发消息。
 * 未核实的字段一律标 `unknown` 而不是猜类型——猜错类型比没有类型更危险。
 *
 * 依据：docs/DESIGN.md 第 9 节列出的实况文档；旧仓库
 * (github.com/tencent-connect/bot-docs) 已废弃，不作为依据。
 */

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

/** POST /app/getAppAccessToken 请求体 */
export interface AppAccessTokenRequest {
  appId: string;
  clientSecret: string;
}

/**
 * 鉴权响应。
 *
 * ⚠ 两个坑：
 *   1. `expires_in` 是**字符串**（例如 "7200"），不是数字；
 *   2. 失败时 HTTP 状态码仍是 200，必须靠 `code` 判断，
 *      典型错误码 100007（appid 无效）、100016（secret 错误）、100001（限频）。
 */
export interface AppAccessTokenResponse {
  access_token?: string;
  expires_in?: string;
  code?: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// 网关
// ---------------------------------------------------------------------------

/** GET /gateway 响应 */
export interface GatewayResponse {
  url: string;
}

/** GET /gateway/bot 响应（本 MVP 只用 url，其余留作诊断） */
export interface GatewayBotResponse {
  url: string;
  shards?: number;
  session_start_limit?: {
    total: number;
    remaining: number;
    reset_after: number;
    max_concurrency: number;
  };
}

/** 网关下行的通用信封 */
export interface GatewayPayload<T = unknown> {
  /** 事件 id；回调回复时作为 event_id 使用 */
  id?: string;
  op: number;
  d?: T;
  /** 序列号，心跳与 resume 都要带 */
  s?: number;
  /** 事件类型，仅 op=0 (Dispatch) 时有意义 */
  t?: string;
}

/** opcode 全集（见实况文档 OpCode 表） */
export const OpCode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
  HTTP_CALLBACK_ACK: 12,
  CALLBACK_VALIDATION: 13,
} as const;

export type OpCodeValue = (typeof OpCode)[keyof typeof OpCode];

/** op=10 Hello */
export interface HelloPayload {
  heartbeat_interval: number; // 毫秒
}

/** op=2 Identify */
export interface IdentifyPayload {
  /** 形如 "QQBot <access_token>"；旧的 "Bot {appid}.{token}" 已废弃 */
  token: string;
  intents: number;
  shard: [number, number];
  properties: {
    $os: string;
    $browser: string;
    $device: string;
  };
}

/** op=6 Resume */
export interface ResumePayload {
  token: string;
  session_id: string;
  seq: number;
}

/** READY / RESUMED 的 d */
export interface ReadyPayload {
  version?: number;
  session_id?: string;
  user?: { id?: string; username?: string; bot?: boolean };
  shard?: [number, number];
}

/** WS 关闭码 → 应采取的动作 */
export const WS_CLOSE_CODES: Record<number, string> = {
  4001: 'opcode 非法',
  4002: 'payload 非法',
  4006: 'session id 无效：必须重新 Identify',
  4007: 'seq 错误',
  4008: '发送过快',
  4009: 'session 已过期：可以 Resume',
  4010: 'shard 非法',
  4011: 'guild 数量超限',
  4012: '版本非法',
  4013: 'intent 非法',
  4014: 'intent 无权限：检查控制台订阅与 QQ_INTENTS 配置',
  4914: '机器人已下架，只允许连接沙箱环境',
  4915: '机器人已封禁',
};

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
export const Intent = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_MEMBER_EVENT: 1 << 24,
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
} as const;

/**
 * 群 @消息 + 单聊消息 + 进群事件（默认订阅集合）。
 *
 * `GROUP_AND_C2C_EVENT (1<<25)` 同时承载 `GROUP_AT_MESSAGE_CREATE` 与
 * `C2C_MESSAGE_CREATE`——想只服务群聊也绕不开它（intent 粒度就是这样的）。
 * 关闭单聊请在业务层用 `QQ_C2C_ENABLED=false`，而不是改 intent。
 */
export const DEFAULT_INTENTS = Intent.GROUP_AND_C2C_EVENT | Intent.GROUP_MEMBER_EVENT;

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

/** GROUP_AT_MESSAGE_CREATE 等消息事件的 d */
export interface GroupMessageEvent {
  /** 消息 id，被动回复时作为 msg_id 使用 */
  id: string;
  content: string;
  group_openid: string;
  /** RFC3339 字符串，例如 "2026-07-21T10:00:00+08:00" */
  timestamp: string;
  /** 0 文本 / 3 ARK / 101 并行 / 102 聊天记录 / 103 引用 */
  message_type?: number;
  author: {
    id?: string;
    /** 群成员在该机器人下的 openid */
    member_openid?: string;
    member_role?: string;
    username?: string;
    bot?: boolean;
  };
  message_scene?: { source?: string; ext?: string[] };
  attachments?: Array<{
    url?: string;
    filename?: string;
    content_type?: string;
    size?: number;
    voice_wav_url?: string;
    asr_refer_text?: string;
  }>;
}

/** C2C_MESSAGE_CREATE（单聊消息）的 d */
export interface C2CMessageEvent {
  /** 消息 id，被动回复时作为 msg_id 使用 */
  id: string;
  content: string;
  /** RFC3339 字符串 */
  timestamp: string;
  message_type?: number;
  author: {
    id?: string;
    /** 单聊用户在机器人下的 openid（与群里的 member_openid 不是同一个） */
    user_openid?: string;
    union_openid?: string;
  };
  message_scene?: { source?: string; ext?: string[] };
  attachments?: Array<{
    url?: string;
    filename?: string;
    content_type?: string;
    size?: number;
    voice_wav_url?: string;
    asr_refer_text?: string;
  }>;
}

/** GROUP_ADD_ROBOT 的 d（时间戳是 unix 秒，不是 RFC3339） */
export interface GroupAddRobotEvent {
  group_openid: string;
  op_member_openid: string;
  timestamp: number;
}

/** FRIEND_ADD（用户添加机器人好友）的 d */
export interface FriendAddEvent {
  /** 添加机器人的用户 openid */
  openid: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// 发消息
// ---------------------------------------------------------------------------

/** 消息类型。群聊支持 0/2/7；单聊另有 6（input_notify） */
export const MsgType = {
  TEXT: 0,
  MARKDOWN: 2,
  MEDIA: 7,
} as const;

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
export interface SendMessageRequest {
  msg_type: number;
  content?: string;
  markdown?: { content: string };
  media?: { file_info: string };
  message_reference?: { message_id: string };
  msg_id?: string;
  event_id?: string;
  msg_seq?: number;
}

/** 群聊发消息请求体（字段与单聊完全一致，保留独立名字便于端点上做类型区分） */
export type SendGroupMessageRequest = SendMessageRequest;

/** 单聊发消息请求体（字段与群聊完全一致） */
export type SendUserMessageRequest = SendMessageRequest;

/**
 * POST /v2/users/{user_openid}/stream_messages 请求体（流式单聊）。
 *
 * 本 MVP 不使用流式发送（DSH 的一轮结果在 turn 结束后整体取回），
 * 这里保留类型定义以便将来接入"边生成边刷新"的输出方式。
 * `input_state`：1 生成中 / 2 生成结束 / 3 生成超时（以官方文档为准）。
 */
export interface SendUserStreamMessageRequest {
  input_mode?: 'append' | 'replace';
  input_state?: number;
  index?: number;
  content_type?: 'text' | 'markdown';
  content_raw?: string;
  event_id?: string;
  msg_id?: string;
  stream_msg_id?: string;
  msg_seq?: number;
  is_wakeup?: boolean;
}

export interface SendMessageResponse {
  id?: string;
  timestamp?: string;
  ext_info?: { ref_idx?: string };
  // 仅流式消息生效
  remain_msg_len?: number;
}

/**
 * 发送消息的已知错误码（用于决定"重试/降级/放弃"）。
 * 只列本 MVP 会真正处理的。
 */
export const SendErrorCode = {
  /** 消息被去重：(msg_id, msg_seq) 重复 */
  DUPLICATE: 40054005,
  /** 消息长度超限 → 触发折半重试 */
  TOO_LONG: 40054007,
  /** 消息过长或异常 */
  TOO_LONG_OR_INVALID: 40054018,
  /** 主动消息超频控 */
  PROACTIVE_RATE_LIMITED: 40034100,
  /** 主动消息无权限 */
  PROACTIVE_FORBIDDEN: 40034105,
} as const;

/** QQ OpenAPI 的通用错误响应体 */
export interface QqApiError {
  code?: number;
  message?: string;
  err_code?: number;
}
