/**
 * 平台无关的文本清洗工具。
 *
 * 各适配器在发送前按需组合使用：
 *   - 官方 QQ：全部使用（含 defuseMentions——官方消息体里的 `@昵称` 会触发
 *     真实 at 提醒，属于越权行为，必须打断），渲染成请求体的部分在
 *     adapters/qq-official/render.ts；
 *   - OneBot：纯文本发送，@ 是用消息段表达的，正文里的 "@xx" 不会触发提醒，
 *     所以不用 defuseMentions。
 *
 * 通用清洗项：
 *   - 去掉控制字符（除换行/制表）与零宽字符——它们会让 QQ 端显示异常；
 *   - 折叠 3 个以上连续换行。
 */
/** 去掉控制字符与零宽字符，保留 \n 与 \t。 */
export type stripControlChars = (text: string) => string;
/** 折叠过多空行，并 trim 行尾空白。 */
export type normalizeWhitespace = (text: string) => string;
/**
 * 打断 @ 语义。
 *
 * 为什么必须做：QQ 消息体里的 `@昵称` 会触发真实提醒。agent 的输出内容可能来自
 * 群成员输入或网页抓取，如果原样发出，机器人就成了"替别人 at 全群"的工具。
 * 这里在 `@` 后插入零宽不连字符，视觉上几乎无差别，但不构成 at。
 */
export type defuseMentions = (text: string) => string;
/** 纯文本模式：剥掉 Markdown 标记。 */
export type toPlainText = (markdown: string) => string;
/** Markdown 模式：最小清洗，保留结构。 */
export type sanitizeMarkdown = (markdown: string) => string;
