/**
 * 把 agent 的输出渲染成官方 QQ 平台的请求体。
 *
 * 这是官方平台专有的部分（msg_type / markdown 字段 / msg_id 与 event_id 互斥），
 * 所以放在适配器里而不是编排层。通用的文本清洗工具在 pipeline/markdown.ts。
 *
 * 两种模式（由 QQ_MSG_TYPE 决定）：
 *   - `0` 纯文本：剥掉 Markdown 标记。最稳，默认。
 *   - `2` Markdown：保留基础结构（标题/列表/代码块），做最小清洗。
 */

import {
  defuseMentions,
  normalizeWhitespace,
  sanitizeMarkdown,
  stripControlChars,
  toPlainText,
} from '../../pipeline/markdown.js';
import { MsgType, type SendMessageRequest } from './types.js';

export interface RenderOptions {
  msgType: 0 | 2;
  /** 被动回复的 msg_id */
  msgId?: string;
  /** 或用 event_id 回复（进群、加好友、按钮交互） */
  eventId?: string;
  /** 平台分配的 msg_seq */
  msgSeq: number;
  /** 是否引用被回复的消息 */
  quoteMessageId?: string;
}

/**
 * 渲染成可直接发送的请求体。
 * `text` 是 agent 的原始输出（可能是 Markdown）。
 *
 * 群聊与单聊的请求体字段完全一致，端点由调用方按会话类型选择，
 * 所以这里不需要知道消息发往哪里。
 */
export function renderMessage(text: string, options: RenderOptions): SendMessageRequest {
  const cleaned = defuseMentions(normalizeWhitespace(stripControlChars(text)));

  const body: SendMessageRequest = {
    msg_type: options.msgType === 2 ? MsgType.MARKDOWN : MsgType.TEXT,
    msg_seq: options.msgSeq,
  };

  if (options.msgType === 2) {
    body.markdown = { content: sanitizeMarkdown(cleaned) };
  } else {
    body.content = toPlainText(cleaned);
  }

  // msg_id 与 event_id 互斥：优先 msg_id（被动回复提问）
  if (options.msgId !== undefined && options.msgId !== '') {
    body.msg_id = options.msgId;
  } else if (options.eventId !== undefined && options.eventId !== '') {
    body.event_id = options.eventId;
  }

  if (options.quoteMessageId !== undefined && options.quoteMessageId !== '') {
    body.message_reference = { message_id: options.quoteMessageId };
  }

  return body;
}

/** 从请求体里取出实际要发送的文本长度（用于日志与超限判断）。 */
export function messageTextLength(body: SendMessageRequest): number {
  return body.content?.length ?? body.markdown?.content.length ?? 0;
}
