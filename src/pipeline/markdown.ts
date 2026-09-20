/**
 * 把 agent 的输出渲染成 QQ 消息体。
 *
 * 两种模式（由 QQ_MSG_TYPE 决定）：
 *   - `0` 纯文本：剥掉 Markdown 标记。最稳，默认。
 *   - `2` Markdown：保留基础结构（标题/列表/代码块），做最小清洗。
 *
 * 用哪种不靠猜：官方说群聊与单聊的自定义 Markdown 已对所有机器人开放，但
 * 渲染效果依客户端版本而异，所以默认走纯文本，Markdown 留给愿意调的人开。
 *
 * 清洗项（两种模式都做）：
 *   - 去掉控制字符（除换行/制表）与零宽字符——它们会让 QQ 端显示异常；
 *   - 折叠 3 个以上连续换行；
 *   - **转义 @**：agent 输出里的 @某人 会被 QQ 当成真实 at 提醒，属于越权行为
 *     （机器人不该替用户 at 别人），统一加零宽间隔或替换。
 */

import { MsgType, type SendMessageRequest } from '../qq/types.js';

/** 零宽空格，用来打断 @ 语义但仍可读 */
const ZERO_WIDTH = '\u200b';
const ZERO_WIDTH_JOINER = '\u200d';

/** 去掉控制字符与零宽字符，保留 \n 与 \t。 */
export function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[\u200b-\u200f\ufeff]/g, '');
}

/** 折叠过多空行，并 trim 行尾空白。 */
export function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 打断 @ 语义。
 *
 * 为什么必须做：QQ 消息体里的 `@昵称` 会触发真实提醒。agent 的输出内容可能来自
 * 群成员输入或网页抓取，如果原样发出，机器人就成了"替别人 at 全群"的工具。
 * 这里在 `@` 后插入零宽不连字符，视觉上几乎无差别，但不构成 at。
 */
export function defuseMentions(text: string): string {
  // 只处理"@ + 非空白"的形式，避免把邮箱等误伤太多
  return text.replace(/@(?=\S)/g, `@${ZERO_WIDTH_JOINER}`);
}

/** 纯文本模式：剥掉 Markdown 标记。 */
export function toPlainText(markdown: string): string {
  let text = markdown;
  // 代码围栏：去掉围栏行，保留代码内容
  text = text.replace(/^```[^\n]*\n?/gm, '');
  // 行内代码
  text = text.replace(/`([^`]*)`/g, '$1');
  // 粗体/斜体/删除线
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  // 标题符号
  text = text.replace(/^#{1,6}\s+/gm, '');
  // 引用符号
  text = text.replace(/^>\s?/gm, '');
  // 链接 [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // 图片 ![alt](url) → alt (url)
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)');
  // 分隔线
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, '———');
  return text;
}

/** Markdown 模式：最小清洗，保留结构。 */
export function sanitizeMarkdown(markdown: string): string {
  // 不支持的表格语法降级为等宽文本，避免渲染错乱
  return markdown.replace(/^\|(.+)\|\s*$/gm, (line) => line.replace(/\|/g, ' '));
}

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
