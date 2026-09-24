/**
 * OneBot v11 协议 wire 类型（只声明用到的子集）。
 *
 * OneBot v11 是 NapCat / LLOneBot / Lagrange 等社区框架共同遵守的协议，
 * 对接这一个协议就覆盖了整个生态。
 *
 * 连接方式（本服务的选择）：反向 WebSocket——本服务起 WS server，
 * 框架作为客户端连入。事件与动作响应都走这条连接：
 *   - 框架 → 本服务：事件（post_type: message / notice / request / meta_event）
 *   - 本服务 → 框架：动作（{action, params, echo}），响应用 echo 对回
 *
 * 未核实的字段一律标 unknown 而不是猜类型。
 */

/** 消息段（数组形式的消息体） */
export interface OneBotSegment {
  type: string; // 'text' | 'at' | 'image' | 'reply' | ...
  data: Record<string, unknown>;
}

/** 消息体：数组形式（推荐）或 CQ 码字符串 */
export type OneBotMessage = OneBotSegment[] | string;

export interface OneBotEventBase {
  /** unix 秒 */
  time?: number;
  /** 收到事件的机器人 QQ 号 */
  self_id?: number;
  post_type?: string;
}

export interface OneBotMessageEvent extends OneBotEventBase {
  post_type: 'message';
  message_type: 'private' | 'group';
  sub_type?: string;
  message_id?: number;
  user_id?: number;
  group_id?: number;
  message?: OneBotMessage;
  raw_message?: string;
  sender?: {
    user_id?: number;
    nickname?: string;
    /** 群名片（优先于 nickname 展示） */
    card?: string;
    role?: string;
  };
}

export interface OneBotNoticeEvent extends OneBotEventBase {
  post_type: 'notice';
  notice_type?: string;
  user_id?: number;
  group_id?: number;
  operator_id?: number;
}

export interface OneBotRequestEvent extends OneBotEventBase {
  post_type: 'request';
  request_type?: 'friend' | 'group';
  /** group 请求的子类型：'add'（加群）| 'invite'（邀请机器人进群） */
  sub_type?: string;
  user_id?: number;
  group_id?: number;
  /** 审批请求时回传的标识 */
  flag?: string;
  comment?: string;
}

export interface OneBotMetaEvent extends OneBotEventBase {
  post_type: 'meta_event';
  meta_event_type?: 'lifecycle' | 'heartbeat';
  /** lifecycle 的子类型：connect / enable / disable */
  sub_type?: string;
  interval?: number;
}

export type OneBotEvent = OneBotMessageEvent | OneBotNoticeEvent | OneBotRequestEvent | OneBotMetaEvent;

/** 本服务 → 框架的动作请求 */
export interface OneBotActionRequest {
  action: string;
  params: Record<string, unknown>;
  echo?: string;
}

/** 框架 → 本服务的动作响应（用 echo 与请求对回） */
export interface OneBotActionResponse {
  /** 'ok' | 'async' | 'failed' */
  status?: string;
  /** 0 表示成功；非 0 为错误码 */
  retcode?: number;
  data?: unknown;
  echo?: string;
  message?: string;
  wording?: string;
}
