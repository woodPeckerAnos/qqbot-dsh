/**
 * 把消息里的图片片段变成 DSH 能吃的 image prompt block。
 *
 * 为什么单独一层：
 *   1. 下载是 IO，必须发生在"消息确定要处理"之后（闸、去重、准入都过了），
 *      所以不能放在适配器归一化里；
 *   2. DSH 的 image block 要求 base64 + 受限 MIME，属于 DSH 协议细节，
 *      编排层不该自己拼；
 *   3. 任何一张图失败都只降级成一行文字说明，绝不打断整轮——用户至少能拿到
 *      文字部分的回答。
 *
 * 安全与稳健：
 *   - 只接受 png/jpeg/webp/gif（runtime 准入时会校验，我们提前挡住，避免整条
 *     prompt 被拒）；
 *   - MIME 以**字节嗅探**为准，不信平台声明，也不信响应头；
 *   - 单张字节数与张数都有上限，下载有超时。
 *
 * 「超限」的处置是**降级为可读**，不是拒绝（见 image.ts）：
 *   - 单边 > 8192 或总像素 > 6400 万的图会被 runtime 直接拒收，进而让整轮只剩
 *     纯文本回退。所以这里先自己缩放/切片，再送进 prompt；
 *   - 极长的截图按"模型对每张图只有 64 万像素预算"竖切成若干块，块内文字才
 *     真的读得清；切不完的部分在正文里明说"未读入"，而不是假装看到了。
 */

import type {
  MediaBytes,
  MediaFetchOptions,
  MessageImagePart,
  RemoteMedia,
} from '../core/connector.js';
import type { Logger } from '../logger.js';
import { ADMIT_MAX_DIMENSION, MAX_DECODE_PIXELS, prepareImageForPrompt, probeImagePreparer } from './image.js';
import type { PromptContentBlock, PromptImageMimeType } from './protocol.js';

export interface BuildImageBlocksOptions {
  /** 单条消息最多取几张**源图**（超出部分只留文字说明） */
  maxImages: number;
  /** 单张图片内联进 prompt 的最大字节数（超限会先降采样再判） */
  maxBytes: number;
  /** 一张长图最多切成几块 */
  maxTiles: number;
  /** 单张图片下载超时（毫秒） */
  timeoutMs: number;
  /** 平台侧取字节（官方需要带 access_token）。缺省时用普通 GET。 */
  fetchMedia?: (media: RemoteMedia, options: MediaFetchOptions) => Promise<MediaBytes | undefined>;
  logger: Logger;
}

export interface ImageBlocksResult {
  /** 可直接拼进 session/prompt 的 image 块 */
  blocks: PromptContentBlock[];
  /** 未能送进模型的图片说明（调用方拼进 prompt 文本，让模型知道"这里原本有图"） */
  notes: string[];
}

/**
 * 下载阶段的硬上限，**与内联上限 `attachments.maxImageBytes` 是两件事**。
 *
 * 内联上限是"送进 prompt 的图片多大"（默认 8MB）；下载上限是"为了把它压到内联
 * 上限以内，最多愿意先拉下来多少字节"。长截图动辄十几 MB，如果按内联上限截断下载，
 * 就等于把最能说明问题的那类图直接扔掉——而这正是要修的场景。
 *
 * 32MB 的取法：QQ 单图硬上限 200MB，照单全收会拖垮一轮；而 32MB 足以覆盖
 * 常见长截图（PNG 1080×20000 约 5–15MB），再大的图基本也不是"能读懂的截图"了。
 */
const MAX_IMAGE_DOWNLOAD_BYTES = 32 * 1024 * 1024;

/**
 * 单条 prompt 的图片张数硬上限，对齐 `dsh-attachment-local` 的
 * `maxImagesPerMessage`（默认 20）：超了整条 prompt 会被拒收，连文字都拿不到。
 * 长图切片最容易撞上它——块数是"多张图"，不是一张。
 */
const MAX_BLOCKS_PER_PROMPT = 20;

/**
 * 按字节魔数判断真实图片类型。
 *
 * 只认这四种的原因同上：runtime 只准入这四种，其余（bmp/heic/tiff）内联会被拒。
 */
export function sniffImageMimeType(data: Uint8Array): PromptImageMimeType | undefined {
  if (data.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((byte, index) => data[index] === byte)) return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 6) {
    const head = String.fromCharCode(...data.subarray(0, 6));
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (data.length >= 12) {
    const riff = String.fromCharCode(...data.subarray(0, 4));
    const webp = String.fromCharCode(...data.subarray(8, 12));
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  return undefined;
}

/**
 * 把 runtime 的英文准入错误翻译成一句中文说明（进 prompt，模型会转述给用户）。
 *
 * 为什么不直接把原文塞给模型：`Image exceeds the configured per-side pixel limit.`
 * 这种句子模型只能照抄，用户拿到的是"配置的单边像素上限被超出"——既不知道发生了什么，
 * 也不知道该怎么办。原文仍然进日志。
 */
export function describeImageRejection(reason: string): string {
  if (/per-side pixel limit/i.test(reason)) return '图片单边像素超过模型上限';
  if (/decoded-pixel limit/i.test(reason)) return '图片总像素超过模型上限';
  if (/byte limit/i.test(reason)) return '图片体积超过模型上限';
  if (/Unsupported or malformed|INVALID_IMAGE/i.test(reason)) return '图片格式无法识别';
  if (/TOO_MANY_IMAGES|too many images/i.test(reason)) return '图片张数超过单条消息上限';
  return reason;
}

/**
 * 顺序下载、按需降采样/切片，再编码成 base64 image block。
 * 返回的 blocks 只含 image 块，text 块由调用方拼在最前面。
 */
export async function buildImageBlocks(
  images: readonly MessageImagePart[],
  options: BuildImageBlocksOptions,
): Promise<ImageBlocksResult> {
  const { maxImages, maxBytes, maxTiles, timeoutMs, fetchMedia, logger } = options;
  const blocks: PromptContentBlock[] = [];
  const notes: string[] = [];

  if (images.length > maxImages) {
    notes.push(`（另有 ${images.length - maxImages} 张图片超出单条消息上限，未读入）`);
  }

  // 降采样能力（sharp）在容器里由 DSH 自带；拿不到就退回"只预筛、不处理"的旧行为，
  // 而不是把用户这条消息整条丢掉。
  const canPrepare = await probeImagePreparer();
  let notedBlockCap = false;

  for (const [index, image] of images.slice(0, maxImages).entries()) {
    // 一条消息里有多张图时，注记必须指明"是哪一张"：长图切片的注记不带主语时，
    // 模型会把"共需 34 块"错记到旁边的照片上。
    const label = images.length > 1 ? `第 ${index + 1} 张图：` : '';
    if (blocks.length >= MAX_BLOCKS_PER_PROMPT) {
      // 只提示一次：长图切片最容易撞上它（块数是"多张图"），而剩下的源图可能还有好几张
      if (!notedBlockCap) {
        notedBlockCap = true;
        notes.push('（图片过多，超出单条消息可送入的张数上限，其余未读入）');
      }
      break;
    }

    // 平台声明的尺寸只用来挡"注定解不动"的图（省一次下载与一次解码），
    // 不再用来拒绝普通超限图——那些现在都能救回来。
    const declaredPixels = (image.width ?? 0) * (image.height ?? 0);
    if (declaredPixels > MAX_DECODE_PIXELS) {
      notes.push(
        `（${label}过大（${image.width ?? '?'}×${image.height ?? '?'}），超出可解码范围，未读入）`,
      );
      continue;
    }
    // 没有降采样能力时保持旧行为：先挡掉注定被 runtime 拒绝的图，别浪费下载。
    const declaredLongSide = Math.max(image.width ?? 0, image.height ?? 0);
    if (!canPrepare && declaredLongSide > ADMIT_MAX_DIMENSION) {
      notes.push(
        `（${label}尺寸过大（${image.width ?? '?'}×${image.height ?? '?'}），未读入）`,
      );
      continue;
    }

    const media: RemoteMedia = {
      ...(image.url !== undefined ? { url: image.url } : {}),
      ...(image.fileId !== undefined ? { fileId: image.fileId } : {}),
      ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
      ...(image.filename !== undefined ? { filename: image.filename } : {}),
    };
    // 下载上限宽于内联上限：多拉的字节是为了把它压到内联上限以内（见常量说明）
    const fetchOptions: MediaFetchOptions = {
      maxBytes: Math.max(maxBytes, MAX_IMAGE_DOWNLOAD_BYTES),
      timeoutMs,
    };
    let bytes: MediaBytes | undefined;
    // 没有可下载地址时只有平台侧 fetchMedia（动作回查）能拿到字节
    if (media.url === undefined && fetchMedia === undefined) {
      bytes = undefined;
    } else {
      try {
        bytes =
          fetchMedia !== undefined
            ? await fetchMedia(media, fetchOptions)
            : await defaultFetchMedia(media, fetchOptions);
      } catch (error) {
        logger.warn('下载图片失败', {
          url: image.url ?? image.fileId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (bytes === undefined) {
      notes.push(`（${label}读取失败，未读入）`);
      continue;
    }
    const mimeType = sniffImageMimeType(bytes.data);
    if (mimeType === undefined) {
      const declared = bytes.mimeType ?? image.mimeType ?? '未知格式';
      notes.push(`（${label}格式不支持内联（${declared}），未读入）`);
      continue;
    }

    const remaining = MAX_BLOCKS_PER_PROMPT - blocks.length;
    const prepared = canPrepare
      ? await prepareImageForPrompt(bytes.data, {
          maxBytes,
          maxTiles: Math.max(1, Math.min(maxTiles, remaining)),
          logger,
        })
      : ({ kind: 'unavailable' } as const);

    if (prepared.kind === 'prepared') {
      for (const tile of prepared.tiles) {
        if (blocks.length >= MAX_BLOCKS_PER_PROMPT) break;
        blocks.push({
          type: 'image',
          data: Buffer.from(tile.data).toString('base64'),
          mimeType: tile.mimeType as PromptImageMimeType,
        });
      }
      for (const note of prepared.notes) notes.push(withImageLabel(note, label));
      continue;
    }

    if (prepared.kind === 'undecodable') {
      // 解不开字节就别内联：runtime 会以 INVALID_IMAGE 拒掉**整条** prompt，
      // 连同一轮里的其他图与文字都一起陪葬。
      logger.warn('图片无法解码，未内联', {
        url: image.url ?? image.fileId,
        reason: prepared.reason,
      });
      const size =
        image.width !== undefined && image.height !== undefined
          ? `（声明 ${image.width}×${image.height}）`
          : '';
      notes.push(`（${label}无法解码${size}，未读入）`);
      continue;
    }

    // `unavailable`：没有降采样能力，按旧行为处理——字节超限就只留说明。
    if (bytes.data.byteLength > maxBytes) {
      notes.push(`（${label}超过 ${Math.round(maxBytes / 1024)}KB，未读入）`);
      continue;
    }
    blocks.push({
      type: 'image',
      data: Buffer.from(bytes.data).toString('base64'),
      mimeType,
    });
  }

  return { blocks, notes };
}

/**
 * 把"第 N 张图："插进注记的开括号之后。
 *
 * 注记统一是 `（……）` 句式，插在括号里比在括号外再套一层更好读：
 * `（第 2 张图：长图过长……）`。
 */
function withImageLabel(note: string, label: string): string {
  if (label === '') return note;
  return note.startsWith('（') ? `（${label}${note.slice(1)}` : `（${label}${note}）`;
}

/** 兜底实现：普通 GET（OneBot 的图片地址通常不需要鉴权）。 */
export async function defaultFetchMedia(
  media: RemoteMedia,
  options: MediaFetchOptions,
): Promise<MediaBytes | undefined> {
  if (media.url === undefined) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(media.url, { signal: controller.signal });
    if (!response.ok) return undefined;
    const declaredLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) return undefined;
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > options.maxBytes) return undefined;
    return {
      data: buffer,
      ...(response.headers.get('content-type') !== null
        ? { mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() }
        : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
