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
    let media = copied.map((attachment) =>
      classify(attachment, options.policy.record?.videoExtensions ?? [])
    );
    if (media.length > 1 && media.some((m) => m.type === 'file')) {
      const archive = await prepareZip(
        join(options.filesDir, base.taskId),
        groupId,
        copied,
        options.maxFileBytes
      );
      media = [{ type: 'file', attachment: archive }];
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

function classify(attachment: OutgoingAttachment, videoExtensions: readonly string[]): Media {
  if (attachment.kind === 'image') return { type: 'image', attachment };
  const extension = extname(attachment.fileName).slice(1).toLowerCase();
  return { type: videoExtensions.includes(extension) ? 'video' : 'file', attachment };
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
    if (body) candidates.push(shortTip(base));
    candidates.push(recordCandidate(base, bodyId, parts, inline));
  } else if (body) {
    candidates.push({
      ...base,
      text: body,
      body: { id: bodyId, index: parts.at(0)?.index ?? 0, segments: parts },
    });
  }
  const separate = record ? media.filter((m) => m.type === 'file') : media;
  return [
    ...candidates,
    ...separate.map((m) => ({
      ...base,
      quote: false,
      mention: undefined,
      attachment: m.attachment,
    })),
  ];
}

function shortTip(base: ReplyCandidate): ReplyCandidate {
  const reference = base.reference;
  return {
    ...base,
    quote: true,
    text: reference?.messageId
      ? '结果已整理，请查看下面的消息。'
      : `关于「${reference?.excerpt.slice(0, 120) ?? ''}」的结果，请查看下面的消息。`,
  };
}

function recordCandidate(
  base: ReplyCandidate,
  bodyId: string,
  parts: BodyPart[],
  media: Media[]
): ReplyCandidate {
  const text = parts.map((part) => part.text).join('');
  const nodes: OutgoingRecordNode[] = parts.map((part) => ({ type: 'text', text: part.text }));
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
          segments: parts.map((part, nodeIndex) => ({ ...part, nodeIndex })),
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
    checkFileSize(attachment, (await stat(attachment.absPath)).size, maxFileBytes);
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
