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

/** 零宽不连字符，用来打断 @ 语义但仍可读 */
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
