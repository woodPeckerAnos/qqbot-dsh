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
 */

import type {
  MediaBytes,
  MediaFetchOptions,
  MessageImagePart,
  RemoteMedia,
} from '../core/connector.js';
import type { Logger } from '../logger.js';
import type { PromptContentBlock, PromptImageMimeType } from './protocol.js';

export interface BuildImageBlocksOptions {
  /** 单条消息最多送入几张图（超出部分只留文字说明） */
  maxImages: number;
  /** 单张图片最大字节数 */
  maxBytes: number;
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
 * 单边像素上限，与 `@deepseek-ai/dsh-attachment-local` 的默认 `maxImageDimension`
 * （8192）对齐：超过它的图会在 runtime 准入时被直接拒绝（`IMAGE_DIMENSION_TOO_LARGE`）。
 *
 * 这里用平台**声明**的尺寸做一次预筛，只为省下一次注定失败的下载
 * （长截图动辄上万像素，是最常见的触发场景）。声明不可信也没关系——
 * 真实准入仍由 runtime 判定，失败时 TurnRunner 会退回纯文本重试。
 */
export const MAX_INLINE_IMAGE_DIMENSION = 8192;

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
 * 顺序下载并编码图片。返回的 blocks 只含 image 块，text 块由调用方拼在最前面。
 */
export async function buildImageBlocks(
  images: readonly MessageImagePart[],
  options: BuildImageBlocksOptions,
): Promise<ImageBlocksResult> {
  const { maxImages, maxBytes, timeoutMs, fetchMedia, logger } = options;
  const blocks: PromptContentBlock[] = [];
  const notes: string[] = [];

  if (images.length > maxImages) {
    notes.push(`（另有 ${images.length - maxImages} 张图片超出单条消息上限，未读入）`);
  }

  for (const image of images.slice(0, maxImages)) {
    // 声明尺寸就超限的直接跳过，不浪费一次下载（见 MAX_INLINE_IMAGE_DIMENSION）
    const longSide = Math.max(image.width ?? 0, image.height ?? 0);
    if (longSide > MAX_INLINE_IMAGE_DIMENSION) {
      notes.push(
        `（有 1 张图片尺寸过大（${image.width ?? '?'}×${image.height ?? '?'}），未读入）`,
      );
      continue;
    }

    const media: RemoteMedia = {
      ...(image.url !== undefined ? { url: image.url } : {}),
      ...(image.fileId !== undefined ? { fileId: image.fileId } : {}),
      ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
      ...(image.filename !== undefined ? { filename: image.filename } : {}),
    };
    let bytes: MediaBytes | undefined;
    // 没有可下载地址时只有平台侧 fetchMedia（动作回查）能拿到字节
    if (media.url === undefined && fetchMedia === undefined) {
      bytes = undefined;
    } else {
      try {
        bytes =
          fetchMedia !== undefined
            ? await fetchMedia(media, { maxBytes, timeoutMs })
            : await defaultFetchMedia(media, { maxBytes, timeoutMs });
      } catch (error) {
        logger.warn('下载图片失败', {
          url: image.url ?? image.fileId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (bytes === undefined) {
      notes.push('（有 1 张图片读取失败，未读入）');
      continue;
    }
    if (bytes.data.byteLength > maxBytes) {
      notes.push(`（有 1 张图片超过 ${Math.round(maxBytes / 1024)}KB，未读入）`);
      continue;
    }
    const mimeType = sniffImageMimeType(bytes.data);
    if (mimeType === undefined) {
      const declared = bytes.mimeType ?? image.mimeType ?? '未知格式';
      notes.push(`（有 1 张图片格式不支持内联（${declared}），未读入）`);
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
