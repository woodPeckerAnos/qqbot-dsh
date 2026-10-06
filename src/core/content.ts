/**
 * 内容片段的公共工具：把结构化片段渲染成可读文本、挑出要送进模型的图片。
 *
 * 为什么放 core：两个适配器（官方 / OneBot）都要把片段"拍平"成 content，
 * 编排层又要按同样的规则渲染 prompt；规则只写一遍，才能保证
 * "对话记录里看到的"和"模型看到的"是同一套语义。
 *
 * 纯函数、无 IO，可直接单测。
 */

import type {
  MessageForwardPart,
  MessageImagePart,
  MessageMediaPart,
  MessagePart,
  MessageQuotePart,
  NormalizedMessage,
} from './connector.js';

/** 一条消息的全部片段；适配器没给 parts 时退回单一文本片段。 */
export function messageParts(message: NormalizedMessage): MessagePart[] {
  if (message.parts !== undefined && message.parts.length > 0) return message.parts;
  return message.content === '' ? [] : [{ type: 'text', text: message.content }];
}

/**
 * 把片段渲染成一行/多行的可读文本。
 *
 * 渲染规则刻意保守：模型能从文字里看出"这里原本是张图"，但不能凭空看到图片
 * 内容——图片本身由 buildPromptBlocks 以 image block 的形式另行送入。
 */
export function flattenParts(parts: readonly MessagePart[]): string {
  const rendered: string[] = [];
  for (const part of parts) {
    // 逐段 trim：平台给的文本段常带首尾空格（" /今日天气 "），不清掉会让
    // content 里出现 "正文 \n[图片]" 这种别扭形态，也会影响命令匹配。
    const line = renderPart(part).trim();
    if (line !== '') rendered.push(line);
  }
  return rendered.join('\n').trim();
}

function renderPart(part: MessagePart): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'image':
      return part.filename !== undefined && part.filename !== ''
        ? `[图片: ${part.filename}]`
        : '[图片]';
    case 'voice': {
      const text = part.text?.trim() ?? '';
      return text === '' ? '[语音]' : `[语音] ${text}`;
    }
    case 'media': {
      const label = part.mediaKind === 'video' ? '视频' : part.mediaKind === 'file' ? '文件' : '附件';
      const name = part.filename !== undefined && part.filename !== '' ? `: ${part.filename}` : '';
      return `[${label}${name}]`;
    }
    case 'quote':
      return renderQuote(part);
    case 'forward':
      return renderForward(part);
  }
}

/**
 * 转发消息块渲染成"标题 + 带条号的逐条发言"。
 *
 * 为什么保留条号与发言人：扁平化结果是**对话记录、冷启动回放、话题判定**的唯一
 * 输入。一旦压成一坨没有边界的文本，模型就分不清"用户在转述别人"还是
 * "用户自己在说"——这两种情况该给的回答完全不同。
 */
function renderForward(part: MessageForwardPart): string {
  const count = part.nodeCount !== undefined ? `共 ${part.nodeCount} 条` : '';
  const head = `[转发消息${count !== '' ? ` ${count}` : ''}]`;
  const nodes: string[] = [];
  part.parts.forEach((node, index) => {
    // 单条发言压成一行：多行会把"第几条"的边界冲掉，与 renderQuote 同理
    const line = flattenParts([node]).replace(/\s*\n\s*/g, ' ').trim();
    if (line !== '') nodes.push(`${index + 1}. ${line}`);
  });
  if (nodes.length === 0) return `${head}（内容未读入）`;
  const tail = part.truncated === true ? ['（仅展开以上条目，其余未读入）'] : [];
  return [head, ...nodes, ...tail].join('\n');
}

/**
 * 引用消息渲染成单行（`[引用 小明] 正文`）。
 *
 * 刻意把引用内部的换行压成空格：引用块如果展开成多行，会盖住"用户这次说了什么"
 * （引用在前、用户正文在后），模型容易把被引用的旧内容当成新指令。
 */
function renderQuote(part: MessageQuotePart): string {
  const head = part.author !== undefined && part.author !== '' ? `[引用 ${part.author}]` : '[引用消息]';
  const inner = flattenParts(part.parts).replace(/\s*\n\s*/g, ' ').trim();
  return inner === '' ? head : `${head} ${inner}`;
}

/** 消息是否含"可送去模型"的内容（只有附件标记也算）。 */
export function partsHaveContent(parts: readonly MessagePart[]): boolean {
  return flattenParts(parts) !== '';
}

/**
 * 递归收集所有图片片段（含引用消息里的图片）。
 *
 * **刻意不下钻进 `forward`**：一期不内联转发块里的图片（一个转发块可能带几十张，
 * 成本失控），只渲染 `[图片]` 标记。真要开这个口子，递归遍历器本身已经支持，
 * 缺的只是配额策略——见 docs/FORWARD-FILE-INGRESS-PLAN.md §14。
 *
 * 顺序即"消息里出现的顺序"，上限由调用方裁剪——配额判断属于编排层。
 */
export function collectImageParts(parts: readonly MessagePart[]): MessageImagePart[] {
  return collectByType<MessageImagePart>(parts, (part) => part.type === 'image');
}

/** 递归收集文件/视频类片段（含引用里的；同样不下钻 `forward`，理由同上）。 */
export function collectMediaParts(parts: readonly MessagePart[]): MessageMediaPart[] {
  return collectByType<MessageMediaPart>(parts, (part) => part.type === 'media');
}

function collectByType<T extends MessagePart>(
  parts: readonly MessagePart[],
  match: (part: MessagePart) => boolean,
): T[] {
  const found: T[] = [];
  const walk = (list: readonly MessagePart[]): void => {
    for (const part of list) {
      if (match(part)) found.push(part as T);
      else if (part.type === 'quote') walk(part.parts);
    }
  };
  walk(parts);
  return found;
}

/** 消息里的图片片段（含引用里的）。 */
export function messageImageParts(message: NormalizedMessage): MessageImagePart[] {
  return collectImageParts(messageParts(message));
}

/** 消息里的文件/视频片段（含引用里的）。 */
export function messageMediaParts(message: NormalizedMessage): MessageMediaPart[] {
  return collectMediaParts(messageParts(message));
}
