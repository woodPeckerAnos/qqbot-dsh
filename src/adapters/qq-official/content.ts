/**
 * 官方消息事件 → 平台无关的内容片段（纯函数，无 IO，便于单测）。
 *
 * 依据官方文档（bot.q.qq.com/wiki/develop/api-v2）：
 *   - 群 @消息 / 群全量消息 / 单聊消息三个事件的字段完全一致；
 *   - **接收侧** `message_type` 官方文档只定义了三种：0=普通文本(content)、
 *     3=结构化卡片(ark_data)、103=引用消息(msg_elements)
 *     （<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html>）；
 *   - 图片/视频/语音/文件**不**通过 message_type 表达，一律走 `attachments`
 *     （用 `content_type` 区分：voice / image/jpeg|png|gif / video/mp4 / file）；
 *   - 引用消息的被引用内容在 `msg_elements` 里，且可递归嵌套。
 *
 * ⚠ 关于 101/102（并行消息 / 聊天记录）：这两个取值**在现行官方文档里查无实据**，
 * 是早期实现按社区资料写的。这里保留对它们的**防御性兼容**（见到就把
 * msg_elements 当聊天记录处理），但不要在它之上继续叠加假设——
 * 官方的转发/合并转发能力以真机实测为准（见 docs/FORWARD-FILE-INGRESS-PLAN.md §3.2
 * 与 docs/RUNBOOK.md 的待实测清单）。
 *
 * 这里只做"翻译"，不做下载：url 原样进片段，字节由 dsh/media.ts 在 turn 期取，
 * 这样被闸拦掉的消息不会白白下载图片。
 */

import type {
  MessageForwardPart,
  MessageImagePart,
  MessageMediaPart,
  MessagePart,
  MessageQuotePart,
  MessageVoicePart,
} from '../../core/connector.js';
import { flattenParts } from '../../core/content.js';
import type { ForwardConfig } from '../../config.js';
import { MessageType, type ArkData, type MessageAttachment, type MsgElement } from './types.js';

/** 事件里我们真正读的那些字段（群/单聊共用） */
export interface MessageBodyLike {
  content?: string;
  message_type?: number;
  attachments?: MessageAttachment[];
  ark_data?: ArkData;
  msg_elements?: MsgElement[];
  mentions?: Array<{ id?: string; username?: string; bot?: boolean }>;
}

/** 组装片段时的可选配额（缺省 = 官方侧的保守内置值） */
export interface MessagePartsOptions {
  /**
   * 转发块（聊天记录形态的 msg_elements）的展开上限。
   * 复用入站富媒体的 `attachments.forward`，与 OneBot 保持同一套旋钮。
   */
  forward?: ForwardConfig;
}

/** 解析 `message_scene.ext` 里的 `key=value` 列表，返回第一个匹配的值。 */
export function sceneExtValue(ext: readonly string[] | undefined, key: string): string | undefined {
  if (ext === undefined) return undefined;
  for (const item of ext) {
    const index = item.indexOf('=');
    if (index <= 0) continue;
    if (item.slice(0, index) === key) return item.slice(index + 1);
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 官方偶发返回协议相对 URL（`//multimedia...`），补上 https。 */
function normalizeUrl(url: string | undefined): string | undefined {
  const value = asString(url);
  if (value === undefined) return undefined;
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}

/** 附件 content_type → 图片 MIME（非图片返回 undefined）。 */
export function imageMimeTypeOf(contentType: string | undefined): string | undefined {
  const value = contentType?.trim().toLowerCase();
  if (value === undefined) return undefined;
  if (value.startsWith('image/')) return value;
  return undefined;
}

function isVoiceContentType(contentType: string | undefined, filename: string | undefined): boolean {
  const value = contentType?.trim().toLowerCase() ?? '';
  if (value === 'voice' || value.startsWith('audio/')) return true;
  const name = filename?.trim().toLowerCase() ?? '';
  return /\.(silk|amr|mp3|wav|ogg|m4a|aac|flac)$/.test(name);
}

/**
 * 附件列表 → 片段。
 *
 * 语音优先用官方给的 `asr_refer_text`（腾讯自己的识别结果，免费且省一次调用）；
 * 没有识别结果时只留 `[语音]` 标记——本项目不做本地语音识别（DS 模型不吃音频）。
 */
export function partsFromAttachments(attachments: readonly MessageAttachment[] | undefined): MessagePart[] {
  if (attachments === undefined || attachments.length === 0) return [];
  const parts: MessagePart[] = [];
  for (const attachment of attachments) {
    const contentType = attachment.content_type;
    const filename = asString(attachment.filename);
    const url = normalizeUrl(attachment.url);

    if (isVoiceContentType(contentType, filename)) {
      const voice: MessageVoicePart = { type: 'voice' };
      const asr = asString(attachment.asr_refer_text);
      if (asr !== undefined) voice.text = asr;
      if (url !== undefined) voice.url = url;
      if (filename !== undefined) voice.filename = filename;
      parts.push(voice);
      continue;
    }

    const imageMime = imageMimeTypeOf(contentType);
    if (imageMime !== undefined && url !== undefined) {
      const image: MessageImagePart = { type: 'image', url, mimeType: imageMime };
      if (filename !== undefined) image.filename = filename;
      if (typeof attachment.width === 'number') image.width = attachment.width;
      if (typeof attachment.height === 'number') image.height = attachment.height;
      parts.push(image);
      continue;
    }

    const media: MessageMediaPart = {
      type: 'media',
      mediaKind:
        contentType?.toLowerCase().startsWith('video/') === true
          ? 'video'
          : contentType?.toLowerCase() === 'file'
            ? 'file'
            : 'unknown',
    };
    if (url !== undefined) media.url = url;
    if (filename !== undefined) media.filename = filename;
    if (typeof attachment.size === 'number') media.sizeBytes = attachment.size;
    parts.push(media);
  }
  return parts;
}

/** 结构化卡片 → 一行文字说明（卡片正文模型读不到，至少给出标题与来源）。 */
export function partFromArk(ark: ArkData | undefined): MessagePart | undefined {
  if (ark === undefined) return undefined;
  const name = asString(ark.ark_name) ?? asString(ark.ark_type) ?? '未知';
  const fields = ark.fields ?? {};
  const title =
    asString(fields['title']) ?? asString(fields['desc']) ?? asString(ark.prompt) ?? undefined;
  const source = asString(fields['source']);
  const suffix = [title, source !== undefined ? `来源: ${source}` : undefined]
    .filter((value): value is string => value !== undefined)
    .join(' · ');
  return { type: 'text', text: suffix === '' ? `[卡片消息 ${name}]` : `[卡片消息 ${name}] ${suffix}` };
}

/** 消息里 @ 了谁（官方已在 content 里去掉 @ 前缀，这里补回可读信息）。 */
function partFromMentions(
  mentions: readonly { username?: string; id?: string; bot?: boolean }[] | undefined,
): MessagePart | undefined {
  if (mentions === undefined || mentions.length === 0) return undefined;
  const names = mentions
    .filter((mention) => mention.bot !== true)
    .map((mention) => asString(mention.username) ?? asString(mention.id))
    .filter((value): value is string => value !== undefined);
  if (names.length === 0) return undefined;
  return { type: 'text', text: `[提到了: ${names.join('、')}]` };
}

/**
 * 消息元素（引用消息的载荷）→ 片段。
 *
 * 递归处理：元素自己也可能带附件与嵌套元素。最多下钻 3 层，
 * 防止异常数据造成无限递归。
 */
export function partsFromElements(elements: readonly MsgElement[] | undefined, depth = 0): MessagePart[] {
  if (elements === undefined || elements.length === 0 || depth > 3) return [];
  const parts: MessagePart[] = [];
  for (const element of elements) {
    const content = asString(element.content);
    if (content !== undefined) parts.push({ type: 'text', text: content });
    parts.push(...partsFromAttachments(element.attachments));
    const ark = partFromArk(element.ark_data);
    if (ark !== undefined) parts.push(ark);
    parts.push(...partsFromElements(element.msg_elements, depth + 1));
  }
  return parts;
}

/** 引用消息（message_type=103）→ `quote` 片段；没有可用内容时返回 undefined。 */
export function quotedPartOf(body: MessageBodyLike): MessageQuotePart | undefined {
  if (body.message_type !== MessageType.QUOTE) {
    // 聊天记录 / 并行消息也把内容放在 msg_elements 里，但没有"引用"语义，
    // 用同一套解析（见下方 buildMessageParts 的兜底分支）。
    return undefined;
  }
  const elements = body.msg_elements;
  if (elements === undefined || elements.length === 0) return undefined;
  const parts = partsFromElements(elements);
  if (parts.length === 0) return undefined;
  const author =
    asString(elements[0]?.author?.username) ?? asString(elements[0]?.author?.id) ?? undefined;
  return { type: 'quote', ...(author !== undefined ? { author } : {}), parts };
}

/** 官方侧转发块的保守默认（未注入配置时使用） */
const DEFAULT_FORWARD: ForwardConfig = {
  enabled: true,
  maxNodes: 20,
  maxNodeChars: 500,
  maxChars: 4_000,
  maxDepth: 2,
  timeoutMs: 10_000,
};

/**
 * 聊天记录形态的 `msg_elements` → `forward` 片段。
 *
 * 与 OneBot 侧的差别：官方把内容随事件一起推过来，**不需要回查**，所以这里
 * 只是"翻译 + 限量"。限量是必需的：msg_elements 可以很长，而它进的是 prompt。
 */
export function forwardPartFromElements(
  elements: readonly MsgElement[],
  options: MessagePartsOptions = {},
): MessageForwardPart | undefined {
  const limits = options.forward ?? DEFAULT_FORWARD;
  if (!limits.enabled || elements.length === 0) return undefined;

  const nodes: MessagePart[] = [];
  let chars = 0;
  let truncated = elements.length > limits.maxNodes;

  for (const element of elements.slice(0, limits.maxNodes)) {
    const nodeParts = partsFromElements([element]);
    const author =
      asString(element.author?.username) ?? asString(element.author?.id) ?? undefined;
    let text = flattenParts(nodeParts).replace(/\s*\n\s*/g, ' ').trim();
    if (text === '') continue;
    if (text.length > limits.maxNodeChars) text = `${text.slice(0, limits.maxNodeChars)}…`;
    if (chars + text.length > limits.maxChars) {
      truncated = true;
      break;
    }
    chars += text.length;
    nodes.push({ type: 'text', text: author !== undefined ? `${author}: ${text}` : text });
  }

  if (nodes.length === 0) return undefined;
  return {
    type: 'forward',
    nodeCount: elements.length,
    ...(truncated ? { truncated: true } : {}),
    parts: nodes,
  };
}

/**
 * 一条官方消息事件 → 完整片段列表。
 *
 * 顺序刻意是"引用在前、本条正文在后"：模型先看到被引用的旧内容，再看用户这次说了什么，
 * 与人在群里的阅读顺序一致。
 */
export function buildMessageParts(
  body: MessageBodyLike,
  options: MessagePartsOptions = {},
): MessagePart[] {
  const parts: MessagePart[] = [];

  const quoted = quotedPartOf(body);
  if (quoted !== undefined) parts.push(quoted);

  const content = asString(body.content)?.trim();
  if (content !== undefined) parts.push({ type: 'text', text: content });

  parts.push(...partsFromAttachments(body.attachments));

  // message_type=3：ark_data 有效；有些实现只给 ark_data 不给 message_type，一并兜住。
  if (body.message_type === MessageType.ARK || body.ark_data !== undefined) {
    const ark = partFromArk(body.ark_data);
    if (ark !== undefined) parts.push(ark);
  }

  // 非引用语义的 msg_elements（聊天记录 / 并行消息）按**转发块**处理：
  // 渲染成带条号的逐条发言。这既比平铺成一段文本更可读，也让"这是别人说的"
  // 这件事在 prompt 里显式可见（注入面的边界，见 docs/FORWARD-FILE-INGRESS-PLAN.md §9）。
  if (body.message_type !== MessageType.QUOTE && body.msg_elements !== undefined) {
    const forward = forwardPartFromElements(body.msg_elements, options);
    if (forward !== undefined) parts.push(forward);
  }

  const mentions = partFromMentions(body.mentions);
  if (mentions !== undefined) parts.push(mentions);

  return parts;
}
