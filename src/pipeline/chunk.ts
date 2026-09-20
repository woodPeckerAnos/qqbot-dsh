/**
 * 长回复分段。
 *
 * 官方**没有公布**单条消息的字符数上限，只在超限时返回 `40054007`。
 * 社区普遍使用 4000，但没有权威依据。因此策略是"保守默认 + 遇错折半"：
 *
 *   1. 默认按 `maxChars`（1500）切分；
 *   2. 切分点优先选自然边界：段落 → 换行 → 句末标点 → 空格 → 硬切；
 *   3. 若某段仍被平台判为超长（40054007），调用方把上限折半重试。
 *
 * 代码块处理：切分时不破坏围栏。若一段的起止落在 ``` 块内部，会给该段重新补上
 * 开启/闭合围栏，保证每段 Markdown 自身合法（否则 QQ 端渲染会错乱）。
 */

export interface SegmentOptions {
  /** 单段最大字符数 */
  maxChars: number;
  /** 最多分多少段；超出部分合并进最后一段并截断 */
  maxSegments: number;
}

export interface SegmentationResult {
  segments: string[];
  /** 是否因为段数上限而丢弃了内容 */
  truncated: boolean;
  /** 原始文本长度 */
  originalLength: number;
}

const PARAGRAPH_BREAK = '\n\n';
const LINE_BREAK = '\n';
const SENTENCE_ENDS = ['。', '！', '？', '；', '.', '!', '?', ';', '：', ':'];

/**
 * 找出 [start, start+maxChars) 内最靠后的自然切分点。
 *
 * 返回值是"下一段开始的下标"，也就是切分点落在分隔符**之前**：
 * 段落分隔的 `\n\n` 归到下一段的开头（下一段构造时会 trim），
 * 这样上一段结尾不会拖一串空行（实测过，那样在 QQ 里会显示成空白消息尾）。
 */
function findBreakPoint(text: string, start: number, maxChars: number): number {
  const limit = Math.min(text.length, start + maxChars);
  if (limit >= text.length) return text.length;
  const window = text.slice(start, limit);

  // 1. 段落边界：切在分隔符之前
  const paragraph = window.lastIndexOf(PARAGRAPH_BREAK);
  if (paragraph > maxChars * 0.4) return start + paragraph;

  // 2. 换行：同样切在换行符之前
  const line = window.lastIndexOf(LINE_BREAK);
  if (line > maxChars * 0.4) return start + line;

  // 3. 句末标点：标点本身留在上一段（中文句号结尾更自然）
  let bestSentence = -1;
  for (const end of SENTENCE_ENDS) {
    const idx = window.lastIndexOf(end);
    if (idx > bestSentence) bestSentence = idx;
  }
  if (bestSentence > maxChars * 0.4) return start + bestSentence + 1;

  // 4. 空格：切在空格之前
  const space = window.lastIndexOf(' ');
  if (space > maxChars * 0.6) return start + space;

  // 5. 硬切
  return limit;
}

/** 判断 text 在 pos 处是否位于未闭合的 ``` 围栏内。 */
function fenceStateAt(text: string, pos: number): { inside: boolean; language: string } {
  let inside = false;
  let language = '';
  let index = 0;
  while (index < pos) {
    const next = text.indexOf('```', index);
    if (next < 0 || next >= pos) break;
    if (!inside) {
      const lineEnd = text.indexOf('\n', next);
      language = lineEnd >= 0 && lineEnd < pos ? text.slice(next + 3, lineEnd).trim() : '';
      inside = true;
    } else {
      inside = false;
      language = '';
    }
    index = next + 3;
  }
  return { inside, language };
}

/**
 * 把一段文本切成至多 maxSegments 段，每段尽量不超过 maxChars。
 * 段数不足时返回实际段数；内容超限时最后一段截断并标记 truncated。
 */
export function segmentText(text: string, options: SegmentOptions): SegmentationResult {
  const trimmed = text.trim();
  const originalLength = trimmed.length;
  if (trimmed === '') return { segments: [], truncated: false, originalLength: 0 };
  const { maxChars, maxSegments } = options;
  if (maxSegments <= 0) return { segments: [], truncated: true, originalLength };
  if (trimmed.length <= maxChars) return { segments: [trimmed], truncated: false, originalLength };

  const segments: string[] = [];
  let cursor = 0;

  while (cursor < trimmed.length && segments.length < maxSegments) {
    const isLastAllowed = segments.length === maxSegments - 1;
    // 最后一段直接吃到结尾（不再切），由下面的截断逻辑处理
    const end = isLastAllowed ? trimmed.length : findBreakPoint(trimmed, cursor, maxChars);
    // trimEnd：切分点落在分隔符之前，这里抹掉本段尾部的空白，
    // 否则段尾会拖一串空行（在 QQ 里表现为多出一条空消息）
    let piece = trimmed.slice(cursor, end).trimEnd();

    // 围栏修复：如果这一段起始处在围栏内部，补一个开启标记
    const stateAtStart = fenceStateAt(trimmed, cursor);
    if (stateAtStart.inside && !piece.trimStart().startsWith('```')) {
      piece = `\`\`\`${stateAtStart.language}\n${piece}`;
    }
    // 若这一段结束处仍在围栏内部，补一个闭合标记
    const stateAtEnd = fenceStateAt(trimmed, end);
    if (stateAtEnd.inside && !piece.trimEnd().endsWith('```')) {
      piece = `${piece.trimEnd()}\n\`\`\``;
    }

    if (isLastAllowed && piece.length > maxChars) {
      // 最后一段超限：截断并明确告知，而不是让平台报 40054007
      const notice = '\n…（内容过长已截断）';
      const keep = Math.max(1, maxChars - notice.length);
      segments.push(`${piece.slice(0, keep)}${notice}`);
      return { segments, truncated: true, originalLength };
    }

    segments.push(piece);
    // 跳过分隔符后的空白，避免下一段以空行开头
    cursor = end;
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor] ?? '')) cursor += 1;
  }

  return { segments, truncated: cursor < trimmed.length, originalLength };
}
