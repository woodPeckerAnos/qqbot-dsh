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
export type { OneBotSegment } from '@qqbot/contracts';

/** 消息体：数组形式（推荐）或 CQ 码字符串 */
export type { OneBotMessage } from '@qqbot/contracts';

export type { OneBotEventBase } from '@qqbot/contracts';

export type { OneBotMessageEvent } from '@qqbot/contracts';

export type { OneBotNoticeEvent } from '@qqbot/contracts';

export type { OneBotRequestEvent } from '@qqbot/contracts';

export type { OneBotMetaEvent } from '@qqbot/contracts';

export type { OneBotEvent } from '@qqbot/contracts';

/** 本服务 → 框架的动作请求 */
export type { OneBotActionRequest } from '@qqbot/contracts';

/** 框架 → 本服务的动作响应（用 echo 与请求对回） */
export type { OneBotActionResponse } from '@qqbot/contracts';
