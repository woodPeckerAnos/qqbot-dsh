/**
 * OneBot v11 事件 → 归一化事件（纯函数，无 IO，便于单测）。
 *
 * 归一化规则：
 *   - 群消息（message.group，sub_type=normal）：只在 @机器人 时触发；
 *     正文 = 全部片段的扁平化结果（文本 + 图片/语音/视频/文件的文字标记）；
 *   - 私聊（message.private，sub_type=friend）：直接触发；
 *   - notice.group_increase 且 user_id 是自己 → 进群欢迎；
 *   - notice.friend_add → 加好友欢迎；
 *   - request.friend / request.group(invite) → 返回审批描述，由连接器按配置放行；
 *   - meta_event：lifecycle → 记录 self_id，heartbeat → 保活信号。
 *
 * 富媒体与引用（这是本文件从"只认 text 段"升级出来的部分）：
 *   - `image` / `mface` / `record` / `video` / `file` 段各自映射成 core 的
 *     MessagePart，图片由 TurnRunner 在 turn 期下载后内联进多模态 prompt；
 *   - `reply` 段只带消息 id，被引用的内容要**额外回查**（get_msg），所以这里只把
 *     id 透出去（`quotedMessageId`），由 connector.ts 完成异步补全；
 *   - `at` 段里 @ 机器人自己是触发条件，@ 别人渲染成 `@昵称`。
 *
 * 会话键规则：`ob11:g<群号>` / `ob11:u<QQ号>`。
 * 加 `ob11:` 前缀是必须的：OneBot 的数字 QQ 号与官方 openid 是两套命名空间，
 * 且去重表、工作区、对话记录全平台共用，无前缀就会互相污染。
 */

import type {
  ConversationTarget,
  MessageImagePart,
  MessageMediaPart,
  MessagePart,
  MessageVoicePart,
  NormalizedEvent,
} from '../../core/connector.js';
import { flattenParts } from '../../core/content.js';
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
  | {
      type: 'event';
      event: NormalizedEvent;
      /** 群/私聊消息引用了某条消息时为该消息 id（连接器据此回查引用内容） */
      quotedMessageId?: string;
    }
  | { type: 'friend-request'; flag: string; userId: number }
  | { type: 'group-invite'; flag: string; groupId: number; userId: number }
  | { type: 'lifecycle'; selfId: number }
  | { type: 'heartbeat'; selfId: number }
  | { type: 'ignored'; reason: string };

/** 一条消息解析出来的全部内容 */
export interface ExtractedContent {
  parts: MessagePart[];
  /** parts 的扁平化文本（进对话记录、命令匹配、日志） */
  content: string;
  /** 是否 @ 了机器人自己 */
  atSelf: boolean;
  /** `reply` 段引用的消息 id */
  quotedMessageId?: string;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** 只接受可下载的 http(s) 地址；本地路径 / base64:// 一律不认（本服务在容器里）。 */
function httpUrl(value: unknown): string | undefined {
  const text = asString(value);
  if (text === undefined) return undefined;
  const lower = text.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) return text;
  return undefined;
}

/** 从图片段的 url/file 里挑一个能下载的地址。 */
function imageUrlOf(segment: OneBotSegment): string | undefined {
  return httpUrl(segment.data['url']) ?? httpUrl(segment.data['file']);
}

/** 把 CQ 码字符串拆成等价的段数组（老框架或 raw_message 只有 CQ 码时用）。 */
export function parseCqCodes(raw: string): OneBotSegment[] {
  const segments: OneBotSegment[] = [];
  const regex = /\[CQ:([A-Za-z0-9_]+)((?:,[^\]]*)?)\]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    if (match.index > cursor) {
      segments.push({ type: 'text', data: { text: raw.slice(cursor, match.index) } });
    }
    const data: Record<string, unknown> = {};
    for (const pair of (match[2] ?? '').replace(/^,/, '').split(',')) {
      if (pair === '') continue;
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      data[pair.slice(0, index)] = pair.slice(index + 1);
    }
    segments.push({ type: match[1] as string, data });
    cursor = regex.lastIndex;
  }
  if (cursor < raw.length) {
    segments.push({ type: 'text', data: { text: raw.slice(cursor) } });
  }
  return segments;
}

/**
 * 解析一条 OneBot 消息的全部内容（数组段或 CQ 码字符串）。
 *
 * 纯函数：不做任何网络请求，引用消息的内容也不在这里回查。
 */
export function extractMessageContent(
  message: OneBotSegment[] | string | undefined,
  selfId: number,
): ExtractedContent {
  const segments: OneBotSegment[] = Array.isArray(message)
    ? message
    : typeof message === 'string'
      ? parseCqCodes(message)
      : [];

  const parts: MessagePart[] = [];
  let atSelf = false;
  let quotedMessageId: string | undefined;

  for (const segment of segments) {
    switch (segment.type) {
      case 'text': {
        const text = asString(segment.data['text']);
        if (text !== undefined) parts.push({ type: 'text', text });
        break;
      }
      case 'at': {
        const qq = asString(segment.data['qq']) ?? '';
        if (qq === String(selfId)) {
          atSelf = true;
          break;
        }
        const name = asString(segment.data['name']) ?? (qq !== '' ? qq : undefined);
        if (name !== undefined) parts.push({ type: 'text', text: `@${name}` });
        break;
      }
      case 'image':
      case 'mface': {
        const url = imageUrlOf(segment);
        // 文件标识（OneBot image 段的 file 原值）：可能是本地路径 / 内部 id /
        // base64://。base64 形式的图片字节已经在上报里，但可能极大（ws 帧），
        // 且 MIME 未知，不值得内联；其余形态留给 fetchMedia 回查。
        const rawFile = asString(segment.data['file']);
        const fileId =
          rawFile !== undefined && !rawFile.startsWith('base64://') && httpUrl(rawFile) === undefined
            ? rawFile
            : undefined;
        if (url === undefined && fileId === undefined) {
          // 既没有可下载地址也没有可回查标识（如 base64 内联），只留标记
          parts.push({ type: 'text', text: '[图片]' });
          break;
        }
        const image: MessageImagePart = { type: 'image' };
        if (url !== undefined) image.url = url;
        if (fileId !== undefined) image.fileId = fileId;
        // 文件名只用于渲染 [图片: xxx]：base64 内联与 file:// 本地路径都不是名字
        const filename = asString(segment.data['file']);
        if (
          filename !== undefined &&
          !filename.startsWith('base64://') &&
          !filename.startsWith('file://')
        ) {
          image.filename = filename;
        }
        parts.push(image);
        break;
      }
      case 'record': {
        const voice: MessageVoicePart = { type: 'voice' };
        const url = httpUrl(segment.data['url']) ?? httpUrl(segment.data['file']);
        if (url !== undefined) voice.url = url;
        const filename = asString(segment.data['file']);
        if (filename !== undefined && !filename.startsWith('base64://')) voice.filename = filename;
        parts.push(voice);
        break;
      }
      case 'video': {
        const media: MessageMediaPart = { type: 'media', mediaKind: 'video' };
        const url = httpUrl(segment.data['url']) ?? httpUrl(segment.data['file']);
        if (url !== undefined) media.url = url;
        const filename = asString(segment.data['file']);
        if (filename !== undefined && !filename.startsWith('base64://')) media.filename = filename;
        parts.push(media);
        break;
      }
      case 'file': {
        const media: MessageMediaPart = { type: 'media', mediaKind: 'file' };
        const url = httpUrl(segment.data['url']);
        if (url !== undefined) media.url = url;
        const filename = asString(segment.data['name']) ?? asString(segment.data['file']);
        if (filename !== undefined && !filename.startsWith('base64://')) media.filename = filename;
        parts.push(media);
        break;
      }
      case 'reply': {
        const id = asString(segment.data['id']);
        if (id !== undefined) quotedMessageId = id;
        break;
      }
      case 'face':
        parts.push({ type: 'text', text: '[表情]' });
        break;
      case 'forward':
        parts.push({ type: 'text', text: '[聊天记录]' });
        break;
      case 'json':
      case 'xml':
        parts.push({ type: 'text', text: '[卡片消息]' });
        break;
      default:
        // 其余段（poke / shake / markdown / 未知扩展）不进正文，排障可查 raw
        break;
    }
  }

  const content = flattenParts(parts);
  return {
    parts,
    content,
    atSelf,
    ...(quotedMessageId !== undefined ? { quotedMessageId } : {}),
  };
}

/**
 * 兼容旧入口：只关心文本与是否 @ 机器人。
 * @deprecated 新代码请用 extractMessageContent（它同时给出图片等片段）。
 */
export function extractGroupContent(
  message: OneBotSegment[] | string | undefined,
  selfId: number,
): { content: string; atSelf: boolean } {
  const extracted = extractMessageContent(message, selfId);
  return { content: extracted.content, atSelf: extracted.atSelf };
}

/**
 * 把 get_msg 回查到的被引用消息解析成片段（供连接器拼 `quote` 片段）。
 * 纯函数：`data` 是 get_msg 返回的 `data` 字段。
 */
export function quotedPartsFromGetMsg(data: unknown, selfId: number): MessagePart[] {
  if (typeof data !== 'object' || data === null) return [];
  const record = data as { message?: OneBotSegment[] | string };
  return extractMessageContent(record.message, selfId).parts;
}

/** 从 get_msg 返回体里取被引用消息的发送者显示名。 */
export function quotedAuthorFromGetMsg(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const sender = (data as { sender?: { card?: string; nickname?: string } }).sender;
  const card = asString(sender?.card);
  return card ?? asString(sender?.nickname);
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
    const extracted = extractMessageContent(raw.message ?? raw.raw_message, selfId);
    if (!extracted.atSelf) return { type: 'ignored', reason: '群消息未 @ 机器人' };
    if (extracted.parts.length === 0) return { type: 'ignored', reason: '@ 之后没有正文' };
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
        content: extracted.content,
        parts: extracted.parts,
        ts,
        raw: raw as unknown as Record<string, unknown>,
      },
      ...(extracted.quotedMessageId !== undefined
        ? { quotedMessageId: extracted.quotedMessageId }
        : {}),
    };
  }

  if (raw.message_type === 'private') {
    // 只接好友私聊；群临时会话（sub_type=group）隐私边界太模糊，不接
    if (raw.sub_type !== undefined && raw.sub_type !== 'friend') {
      return { type: 'ignored', reason: `私聊子类型不处理: ${raw.sub_type}` };
    }
    const extracted = extractMessageContent(raw.message ?? raw.raw_message, selfId);
    if (extracted.parts.length === 0) return { type: 'ignored', reason: '私聊正文为空' };
    return {
      type: 'event',
      event: {
        kind: 'c2c-message',
        target: onebotC2cTarget(userId),
        eventId: `ob11:${selfId}:${messageId}`,
        msgId: String(messageId),
        senderId: String(userId),
        ...(senderName !== undefined ? { username: senderName } : {}),
        content: extracted.content,
        parts: extracted.parts,
        ts,
        raw: raw as unknown as Record<string, unknown>,
      },
      ...(extracted.quotedMessageId !== undefined
        ? { quotedMessageId: extracted.quotedMessageId }
        : {}),
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
