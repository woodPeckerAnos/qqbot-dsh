import { createHash } from 'node:crypto';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type {
  OutgoingAttachment,
  OutgoingRecordNode,
  ReplyCandidate,
  ReplyPolicy,
} from '@qqbot/contracts';
import { packFiles } from '../media/index.js';
import { renderReference, sanitizeReferenceExcerpt } from '../content/index.js';

interface BodyPart {
  index: number;
  text: string;
}
interface Media {
  type: 'image' | 'video' | 'file';
  attachment: OutgoingAttachment;
}
interface Preparation {
  filesDir: string;
  maxFileBytes?: number;
  policy: ReplyPolicy;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Choose source slices before wrapping; retain separators, fences and surrogate pairs. */
export function originalSlices(text: string, maxChars: number): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2)
    throw new Error('正文 maxChars 必须至少为 2');
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + maxChars, text.length);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    parts.push(text.slice(cursor, end));
    cursor = end;
  }
  return parts;
}

export async function prepareRecordDelivery(
  base: ReplyCandidate,
  bodyId: string,
  parts: BodyPart[],
  attachments: readonly OutgoingAttachment[],
  options: Preparation
): Promise<ReplyCandidate[]> {
  try {
    const groupId = `${bodyId}:delivery`;
    const copied = await copyAttachments(
      join(options.filesDir, base.taskId),
      groupId,
      attachments,
      options.maxFileBytes
    );
    const media: Media[] = copied
      .filter((attachment) => attachment.kind === 'image')
      .map((attachment) => ({ type: 'image', attachment }));
    const files = copied.filter((attachment) => attachment.kind !== 'image');
    if (files.length) {
      const archive = await prepareZip(
        join(options.filesDir, base.taskId),
        groupId,
        files,
        options.maxFileBytes
      );
      media.push({ type: 'file', attachment: archive });
    }
    return buildCandidates(base, bodyId, parts, media, options.policy.maxChars);
  } catch (error) {
    return [
      {
        ...base,
        text: '交付结果',
        preparationError: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

function buildCandidates(
  base: ReplyCandidate,
  bodyId: string,
  parts: BodyPart[],
  media: Media[],
  maxChars: number
) {
  const body = parts.map((part) => part.text).join('');
  const inline = media.filter((m) => m.type !== 'file');
  const record = body.length > maxChars || inline.length > 1;
  const candidates: ReplyCandidate[] = [];
  if (record) {
    if (recordNeedsReferenceTip(base, body)) candidates.push(shortTip(base, body));
    candidates.push(recordCandidate(base, bodyId, parts, inline));
  } else if (body || inline.length) {
    candidates.push(ordinaryCandidate(base, bodyId, parts, inline));
  }
  const separate = media.filter((m) => m.type === 'file');
  return [
    ...candidates,
    ...separate.map((m) => ({
      ...base,
      quote: false,
      mention: undefined,
      text: '',
      attachment: m.attachment,
    })),
  ];
}

function recordNeedsReferenceTip(base: ReplyCandidate, body: string): boolean {
  return !!((body && base.reference?.messageId) || base.mention);
}

function ordinaryCandidate(
  base: ReplyCandidate,
  bodyId: string,
  parts: BodyPart[],
  media: Media[]
): ReplyCandidate {
  const body = parts.map((part) => part.text).join('');
  const reference = !base.reference?.messageId ? renderReference(base.reference) : '';
  return {
    ...base,
    text: reference ? `${reference}\n${body}` : body,
    inlineAttachments: media.map((m) => m.attachment),
    body: body ? { id: bodyId, index: parts.at(0)?.index ?? 0, segments: parts } : undefined,
  };
}

/**
 * 长正文的记录前置提示。固定文案「请查看下面的消息」把重点全部推给记录，
 * 群里看不到任何结论；这里用正文自身的首条结论和章节标题做索引。
 * 索引只摘录、不改写，完整论据仍在记录里。
 */
function shortTip(base: ReplyCandidate, body: string): ReplyCandidate {
  const reference = base.reference;
  let prefix = '';
  if (!reference?.messageId && sanitizeReferenceExcerpt(reference?.excerpt ?? ''))
    prefix = renderReference(reference);
  return { ...base, quote: true, text: `${prefix}${replyIndex(body)}` };
}

const INDEX_HEADING =
  /^(?:#{1,6}\s|[一二三四五六七八九十]+、|\d+[.、]\s*|[（(][一二三四五六七八九十]+[）)]|第[一二三四五六七八九十]+[步章部分])/u;

function replyIndex(body: string): string {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const headingText = (line: string) =>
    clip(
      line
        .replace(/^#{1,6}\s*/u, '')
        .replace(/\*\*/gu, '')
        .replace(/^[-*]\s+/u, ''),
      50
    );
  const headings = lines
    .filter((line) => INDEX_HEADING.test(line))
    .slice(0, 5)
    .map(headingText);
  const conclusionLine = lines.find((line) => !INDEX_HEADING.test(line)) ?? lines[0] ?? '';
  const conclusion = clip(
    conclusionLine
      .replace(/^#{1,6}\s*/u, '')
      .replace(/\*\*/gu, '')
      .replace(/^[-*]\s+/u, ''),
    100
  );
  const parts = [`结果已整理：${conclusion || '正文已生成'}`];
  if (headings.length >= 2) parts.push(`要点：${headings.join('；')}`);
  parts.push('完整正文与论据见下方合并转发。');
  const text = parts.join('\n');
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/gu, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function recordCandidate(
  base: ReplyCandidate,
  bodyId: string,
  parts: BodyPart[],
  media: Media[]
): ReplyCandidate {
  const text = parts.map((part) => part.text).join('');
  const nodes: OutgoingRecordNode[] = parts.map((part) => ({ type: 'text', text: part.text }));
  const reference = !base.reference?.messageId ? renderReference(base.reference) : '';
  if (reference) nodes.unshift({ type: 'text', text: reference });
  for (const m of media) {
    if (m.type !== 'file') nodes.push({ type: m.type, attachment: m.attachment });
  }
  return {
    ...base,
    quote: false,
    mention: undefined,
    text,
    record: { nodes },
    body: text
      ? {
          id: bodyId,
          index: parts.at(0)?.index ?? 0,
          segments: parts.map((part, nodeIndex) => ({
            ...part,
            nodeIndex: nodeIndex + (reference ? 1 : 0),
          })),
        }
      : undefined,
  };
}

async function copyAttachments(
  directory: string,
  groupId: string,
  attachments: readonly OutgoingAttachment[],
  maxFileBytes = Infinity
) {
  if (attachments.length) await mkdir(directory, { recursive: true });
  const copied: OutgoingAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const source = await stat(attachment.absPath);
    if (!source.isFile()) throw new Error(`附件「${attachment.fileName}」不是文件，未发送`);
    checkFileSize(attachment, source.size, maxFileBytes);
    const absPath = join(
      directory,
      `${hash(`${groupId}:${index}`)}-${basename(attachment.fileName)}`
    );
    await copyFile(attachment.absPath, absPath);
    const sizeBytes = (await stat(absPath)).size;
    checkFileSize(attachment, sizeBytes, maxFileBytes);
    copied.push({ ...attachment, absPath, sizeBytes });
  }
  return copied;
}
function checkFileSize(attachment: OutgoingAttachment, sizeBytes: number, limit: number) {
  if (sizeBytes > limit) throw new Error(`附件「${attachment.fileName}」超过 maxFileBytes，未发送`);
}

function uniqueNames(attachments: readonly OutgoingAttachment[]) {
  const used = new Set<string>();
  return attachments.map((attachment) => {
    const original = basename(attachment.fileName);
    let fileName = original,
      suffix = 1;
    while (used.has(fileName))
      fileName = `${original.slice(0, original.length - extname(original).length)}-${suffix++}${extname(original)}`;
    used.add(fileName);
    return { ...attachment, fileName };
  });
}
async function prepareZip(
  directory: string,
  groupId: string,
  attachments: readonly OutgoingAttachment[],
  maxFileBytes = Infinity
): Promise<OutgoingAttachment> {
  const files = uniqueNames(attachments);
  const estimated =
    22 + files.reduce((size, a) => size + a.sizeBytes + 76 + 2 * Buffer.byteLength(a.fileName), 0);
  checkZipSize(estimated, maxFileBytes);
  const bytes = await packFiles(files);
  checkZipSize(bytes.length, maxFileBytes);
  const absPath = join(directory, `${hash(groupId)}.zip`);
  await writeFile(absPath, bytes);
  return { kind: 'file', absPath, fileName: '交付附件.zip', sizeBytes: bytes.length };
}
function checkZipSize(size: number, limit: number) {
  if (size > limit) throw new Error('ZIP 超过 maxFileBytes，未发送；未删减任何条目');
}
