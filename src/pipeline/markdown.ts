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
 *   - 去掉控制字符（除换行/制表）和不可见空白，保留 emoji 使用的连接符；
 *   - 折叠 3 个以上连续换行。
 */

/** 零宽不连字符，用来打断 @ 语义但仍可读 */
const ZERO_WIDTH_JOINER = '\u200d';

/** 去掉控制字符和不可见空白，保留 \n、\t 与 ZWJ/ZWNJ。 */
export function stripControlChars(text: string): string {
  return (
    text
      // 这里就是要匹配控制字符：它们是 QQ 端显示异常的来源，不是笔误。
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/[\u200b\u200e\u200f\ufeff]/g, '')
  );
}

/** 折叠过多空行，并 trim 行尾空白。 */
export function normalizeWhitespace(text: string): string {
  return withProtectedCode(text, (prose) =>
    prose
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
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
  return withProtectedCode(markdown, plainProse, 'plain');
}

function plainProse(prose: string): string {
  let text = prose;
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
  return withProtectedCode(markdown, (prose) =>
    prose.replace(/^\|(.+)\|\s*$/gm, (line) => line.replace(/\|/g, ' '))
  );
}

/** 完整正文转换一次；代码内容和 emoji 连接符保留，转换后再切分。 */
export function renderReplyText(text: string, format: 'plain' | 'markdown' = 'plain'): string {
  return withProtectedCode(
    stripControlChars(text),
    (prose) => {
      const rendered = format === 'plain' ? plainProse(prose) : sanitizeMarkdown(prose);
      return normalizeWhitespace(rendered);
    },
    format
  );
}

/** 代码有自己的空白和符号语义，正文清洗期间用不会出现在输入中的标记保存。 */
function withProtectedCode(
  text: string,
  renderProse: (text: string) => string,
  format: 'plain' | 'markdown' = 'markdown'
): string {
  let prefix = '\ue000code';
  while (text.includes(prefix)) prefix += '_';
  const saved: string[] = [];
  const pattern = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)|(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\2(?!`)/gm;
  let protectedText = '',
    cursor = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    protectedText += text.slice(cursor, match.index);
    const span = codeSpan(text, match);
    saved.push(format === 'plain' ? span.code : span.raw);
    protectedText += `${prefix}${saved.length - 1}\ue001`;
    cursor = pattern.lastIndex = span.end;
  }
  protectedText += text.slice(cursor);
  const rendered = renderProse(protectedText);
  return rendered.replace(
    new RegExp(`${prefix}(\\d+)\ue001`, 'g'),
    (_, index: string) => saved[Number(index)] ?? ''
  );
}

/** 一段行内代码或围栏代码，围栏后的换行仍归正文分隔符。 */
function codeSpan(
  text: string,
  match: RegExpExecArray
): { raw: string; code: string; end: number } {
  const start = match.index + match[0].length;
  const fence = match[1];
  if (!fence) return { raw: match[0], code: match[3] ?? '', end: start };
  const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\n|$)`, 'gm');
  closing.lastIndex = start;
  const matched = closing.exec(text);
  let end = matched ? matched.index + matched[0].length : text.length;
  if (matched?.[0].endsWith('\n')) end--;
  return {
    raw: text.slice(match.index, end),
    code: text.slice(start, matched?.index ?? text.length),
    end,
  };
}
