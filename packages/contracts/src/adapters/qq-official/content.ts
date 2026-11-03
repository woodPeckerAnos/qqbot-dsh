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
import type { MessageForwardPart, MessagePart, MessageQuotePart } from '../../core/connector.js';
import type { ForwardConfig } from '../../config.js';
import type { ArkData, MessageAttachment, MsgElement } from './types.js';
/** 事件里我们真正读的那些字段（群/单聊共用） */
export interface MessageBodyLike {
  content?: string;
  message_type?: number;
  attachments?: MessageAttachment[];
  ark_data?: ArkData;
  msg_elements?: MsgElement[];
  mentions?: Array<{
    id?: string;
    username?: string;
    bot?: boolean;
  }>;
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
export type sceneExtValue = (ext: readonly string[] | undefined, key: string) => string | undefined;
/** 附件 content_type → 图片 MIME（非图片返回 undefined）。 */
export type imageMimeTypeOf = (contentType: string | undefined) => string | undefined;
/**
 * 附件列表 → 片段。
 *
 * 语音优先用官方给的 `asr_refer_text`（腾讯自己的识别结果，免费且省一次调用）；
 * 没有识别结果时只留 `[语音]` 标记——本项目不做本地语音识别（DS 模型不吃音频）。
 */
export type partsFromAttachments = (
  attachments: readonly MessageAttachment[] | undefined
) => MessagePart[];
/** 结构化卡片 → 一行文字说明（卡片正文模型读不到，至少给出标题与来源）。 */
export type partFromArk = (ark: ArkData | undefined) => MessagePart | undefined;
/**
 * 消息元素（引用消息的载荷）→ 片段。
 *
 * 递归处理：元素自己也可能带附件与嵌套元素。最多下钻 3 层，
 * 防止异常数据造成无限递归。
 */
export type partsFromElements = (
  elements: readonly MsgElement[] | undefined,
  depth?: number
) => MessagePart[];
/** 引用消息（message_type=103）→ `quote` 片段；没有可用内容时返回 undefined。 */
export type quotedPartOf = (body: MessageBodyLike) => MessageQuotePart | undefined;
/**
 * 聊天记录形态的 `msg_elements` → `forward` 片段。
 *
 * 与 OneBot 侧的差别：官方把内容随事件一起推过来，**不需要回查**，所以这里
 * 只是"翻译 + 限量"。限量是必需的：msg_elements 可以很长，而它进的是 prompt。
 */
export type forwardPartFromElements = (
  elements: readonly MsgElement[],
  options?: MessagePartsOptions
) => MessageForwardPart | undefined;
/**
 * 一条官方消息事件 → 完整片段列表。
 *
 * 顺序刻意是"引用在前、本条正文在后"：模型先看到被引用的旧内容，再看用户这次说了什么，
 * 与人在群里的阅读顺序一致。
 */
export type buildMessageParts = (
  body: MessageBodyLike,
  options?: MessagePartsOptions
) => MessagePart[];
