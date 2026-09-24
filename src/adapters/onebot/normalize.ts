/**
 * OneBot v11 事件 → 归一化事件（纯函数，无 IO，便于单测）。
 *
 * 归一化规则：
 *   - 群消息（message.group，sub_type=normal）：只在 @机器人 时触发；
 *     正文 = 全部 text 段拼接（CQ 码形式则剥掉所有 [CQ:...] 码）；
 *   - 私聊（message.private，sub_type=friend）：直接触发；
 *   - notice.group_increase 且 user_id 是自己 → 进群欢迎；
 *   - notice.friend_add → 加好友欢迎；
 *   - request.friend / request.group(invite) → 返回审批描述，由连接器按配置放行；
 *   - meta_event：lifecycle → 记录 self_id，heartbeat → 保活信号。
 *
 * 会话键规则：`ob11:g<群号>` / `ob11:u<QQ号>`。
 * 加 `ob11:` 前缀是必须的：OneBot 的数字 QQ 号与官方 openid 是两套命名空间，
 * 且去重表、工作区、对话记录全平台共用，无前缀就会互相污染。
 */

import type { ConversationTarget, NormalizedEvent } from '../../core/connector.js';
import type { OneBotEvent, OneBotSegment } from './types.js';

export const ONEBOT_PLATFORM = 'onebot';

export function onebotGroupTarget(groupId: number | string): ConversationTarget {
  const id = String(groupId);
  return { platform: ONEBOT_PLATFORM, kind: 'group', id, key: `ob11:g${id}` };
}

export function onebotC2cTarget(userId: number | string): ConversationTarget {
  const id = String(userId);
  return { platform: ONEBOT_PLATFORM, kind: 'c2c', id, key: `ob11:u${id}` };
}

export type NormalizeResult =
  | { type: 'event'; event: NormalizedEvent }
  | { type: 'friend-request'; flag: string; userId: number }
  | { type: 'group-invite'; flag: string; groupId: number; userId: number }
  | { type: 'lifecycle'; selfId: number }
  | { type: 'heartbeat'; selfId: number }
  | { type: 'ignored'; reason: string };

/** 解析群消息正文：返回纯文本与"是否 @ 了机器人"。 */
export function extractGroupContent(
  message: OneBotSegment[] | string | undefined,
  selfId: number,
): { content: string; atSelf: boolean } {
  if (Array.isArray(message)) {
    let atSelf = false;
    const texts: string[] = [];
    for (const segment of message) {
      if (segment.type === 'at') {
        if (String(segment.data['qq']) === String(selfId)) atSelf = true;
        // at 段不进入正文（其他人的 @ 也没有可解析的昵称可用）
        continue;
      }
      if (segment.type === 'text' && typeof segment.data['text'] === 'string') {
        texts.push(segment.data['text']);
      }
      // 其余段（图片/表情/回复引用等）本 MVP 不进正文，排障可查 raw
    }
    return { content: texts.join('').trim(), atSelf };
  }

  // CQ 码字符串形式
  const raw = typeof message === 'string' ? message : '';
  const atSelf = new RegExp(`\\[CQ:at,qq=${selfId}(?:,[^\\]]*)?\\]`).test(raw);
  const content = raw
    .replace(/\[CQ:[^\]]*\]/g, '')
    .trim();
  return { content, atSelf };
}

/**
 * 归一化一条 OneBot 事件。
 * 返回值描述"该做什么"，副作用（审批、记录 self_id）由连接器执行。
 */
export function normalizeOneBotEvent(raw: OneBotEvent, now: () => number = Date.now): NormalizeResult {
  switch (raw.post_type) {
    case 'message':
      return normalizeMessage(raw, now);
    case 'notice':
      return normalizeNotice(raw, now);
    case 'request':
      return normalizeRequest(raw);
    case 'meta_event': {
      const selfId = typeof raw.self_id === 'number' ? raw.self_id : 0;
      if (raw.meta_event_type === 'lifecycle') return { type: 'lifecycle', selfId };
      return { type: 'heartbeat', selfId };
    }
    default:
      return { type: 'ignored', reason: `未知 post_type: ${String((raw as OneBotEvent).post_type)}` };
  }
}

function normalizeMessage(raw: OneBotEvent, now: () => number): NormalizeResult {
  if (raw.post_type !== 'message') return { type: 'ignored', reason: 'not-message' };
  const selfId = typeof raw.self_id === 'number' ? raw.self_id : 0;
  const userId = raw.user_id;
  const messageId = raw.message_id;
  if (userId === undefined || messageId === undefined) {
    return { type: 'ignored', reason: '消息缺少 user_id 或 message_id' };
  }
  // 自己发的消息（含其他端同步）不处理，避免自触发循环
  if (userId === selfId) return { type: 'ignored', reason: '自己发的消息' };

  const ts = typeof raw.time === 'number' ? raw.time * 1000 : now();
  const senderName =
    raw.sender?.card !== undefined && raw.sender.card !== ''
      ? raw.sender.card
      : raw.sender?.nickname;

  if (raw.message_type === 'group') {
    if (raw.sub_type !== undefined && raw.sub_type !== 'normal') {
      return { type: 'ignored', reason: `群消息子类型不处理: ${raw.sub_type}` };
    }
    if (raw.group_id === undefined) return { type: 'ignored', reason: '群消息缺少 group_id' };
    const { content, atSelf } = extractGroupContent(raw.message ?? raw.raw_message, selfId);
    if (!atSelf) return { type: 'ignored', reason: '群消息未 @ 机器人' };
    if (content === '') return { type: 'ignored', reason: '@ 之后没有正文' };
    return {
      type: 'event',
      event: {
        kind: 'group-at-message',
        target: onebotGroupTarget(raw.group_id),
        // 去重 id 自带平台命名空间（去重表全平台共用）
        eventId: `ob11:${selfId}:${messageId}`,
        msgId: String(messageId),
        senderId: String(userId),
        ...(senderName !== undefined ? { username: senderName } : {}),
        content,
        ts,
        raw: raw as unknown as Record<string, unknown>,
      },
    };
  }

  if (raw.message_type === 'private') {
    // 只接好友私聊；群临时会话（sub_type=group）隐私边界太模糊，不接
    if (raw.sub_type !== undefined && raw.sub_type !== 'friend') {
      return { type: 'ignored', reason: `私聊子类型不处理: ${raw.sub_type}` };
    }
    const content =
      typeof raw.message === 'string'
        ? raw.message.replace(/\[CQ:[^\]]*\]/g, '').trim()
        : (raw.message ?? [])
            .filter((s) => s.type === 'text' && typeof s.data['text'] === 'string')
            .map((s) => s.data['text'] as string)
            .join('')
            .trim();
    if (content === '') return { type: 'ignored', reason: '私聊正文为空' };
    return {
      type: 'event',
      event: {
        kind: 'c2c-message',
        target: onebotC2cTarget(userId),
        eventId: `ob11:${selfId}:${messageId}`,
        msgId: String(messageId),
        senderId: String(userId),
        ...(senderName !== undefined ? { username: senderName } : {}),
        content,
        ts,
        raw: raw as unknown as Record<string, unknown>,
      },
    };
  }

  return { type: 'ignored', reason: `未知 message_type: ${String(raw.message_type)}` };
}

function normalizeNotice(raw: OneBotEvent, now: () => number): NormalizeResult {
  if (raw.post_type !== 'notice') return { type: 'ignored', reason: 'not-notice' };
  const selfId = typeof raw.self_id === 'number' ? raw.self_id : 0;
  const ts = typeof raw.time === 'number' ? raw.time * 1000 : now();

  // 机器人被拉进群（群成员增加事件里 user_id 是自己）
  if (raw.notice_type === 'group_increase' && raw.user_id === selfId && raw.group_id !== undefined) {
    return {
      type: 'event',
      event: {
        kind: 'group-add-robot',
        at: ts,
        target: onebotGroupTarget(raw.group_id),
        raw: raw as unknown as Record<string, unknown>,
      },
    };
  }

  if (raw.notice_type === 'friend_add' && raw.user_id !== undefined) {
    return {
      type: 'event',
      event: {
        kind: 'c2c-friend-add',
        at: ts,
        target: onebotC2cTarget(raw.user_id),
        raw: raw as unknown as Record<string, unknown>,
      },
    };
  }

  return { type: 'ignored', reason: `notice 不处理: ${String(raw.notice_type)}` };
}

function normalizeRequest(raw: OneBotEvent): NormalizeResult {
  if (raw.post_type !== 'request') return { type: 'ignored', reason: 'not-request' };
  if (raw.request_type === 'friend' && raw.flag !== undefined && raw.user_id !== undefined) {
    return { type: 'friend-request', flag: raw.flag, userId: raw.user_id };
  }
  if (
    raw.request_type === 'group' &&
    raw.sub_type === 'invite' &&
    raw.flag !== undefined &&
    raw.group_id !== undefined &&
    raw.user_id !== undefined
  ) {
    return { type: 'group-invite', flag: raw.flag, groupId: raw.group_id, userId: raw.user_id };
  }
  return { type: 'ignored', reason: `request 不处理: ${String(raw.request_type)}/${String(raw.sub_type)}` };
}
