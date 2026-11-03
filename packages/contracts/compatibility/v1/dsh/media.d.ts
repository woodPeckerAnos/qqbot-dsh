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
import type { MediaBytes, MediaFetchOptions, MessageImagePart, RemoteMedia } from '../core/connector.js';
import type { Logger } from '../logger.js';
import type { PromptContentBlock, PromptImageMimeType } from './protocol.js';
import type { MediaResultFetcher } from '../media-result.js';
export interface BuildImageBlocksOptions {
    /** 单条消息最多取几张**源图**（超出部分只留文字说明） */
    maxImages: number;
    /** 单张图片内联进 prompt 的最大字节数（超限会先降采样再判） */
    maxBytes: number;
    /** 一张长图最多切成几块 */
    maxTiles: number;
    /** 单张图片下载超时（毫秒） */
    timeoutMs: number;
    /**
     * 本次调用最多可往 prompt 里加几个 image block（缺省 {@link MAX_BLOCKS_PER_PROMPT}）。
     *
     * 存在的理由：张数上限是**整条 prompt** 的，而一轮 prompt 可能有多个来源
     * （当前这条消息 + 滚窗上下文）。各自按 20 裁剪，两份加起来就会撞爆 runtime 的
     * 上限，导致整条 prompt 被拒。所以预算是**共享的**，由 PromptPreparer
     * 给上下文媒体传剩下的额度，两个 lane 复用同一份准备结果。
     */
    maxBlocks?: number;
    /**
     * 逐图标签（缺省「第 N 张图：」，单图不带标签）。
     *
     * 多来源时必须有区分度：滚窗来源用「上下文附图 #N」，失败注记与调用方写的
     * 成功说明才能对上同一个编号。
     */
    indexLabel?: (index: number, total: number) => string;
    /**
     * 来源说明（缺省空串 = "当前这条消息"的口径），只用在"超出上限"这类**批量注记**里。
     * 例：`群聊上下文` → 「（群聊上下文另有 1 张图片超出单条消息上限，未读入）」。
     *
     * 为什么值得单开一个参数：同一句话在"你刚发的图"和"群里别人的图"两种语境下
     * 该说的对象完全不同，而这句话是模型转述给用户的依据。
     */
    sourceLabel?: string;
    /** 平台侧取字节（官方需要带 access_token）。缺省时用普通 GET。 */
    fetchMedia?: (media: RemoteMedia, options: MediaFetchOptions) => Promise<MediaBytes | undefined>;
    /** Typed source; compatibility fetchMedia is adapted only at the media boundary. */
    fetchResult?: MediaResultFetcher;
    logger: Logger;
}
export interface ImageBlocksResult {
    /** 可直接拼进 session/prompt 的 image 块 */
    blocks: PromptContentBlock[];
    /** 未能送进模型的图片说明（调用方拼进 prompt 文本，让模型知道"这里原本有图"） */
    notes: string[];
    /**
     * 成功内联的**源图**在本批 `images` 里的下标（升序）。
     *
     * 调用方据此写"哪几张真的进来了"的说明（滚窗来源必须说清"这张是谁发的那条
     * 消息里的"）。只返回下标而不是计数：注记里的编号就是按这个下标编的。
     */
    inlinedIndexes: number[];
}
/**
 * 单条 prompt 的图片张数硬上限，对齐 `dsh-attachment-local` 的
 * `maxImagesPerMessage`（默认 20）：超了整条 prompt 会被拒收，连文字都拿不到。
 * 长图切片最容易撞上它——块数是"多张图"，不是一张。
 *
 * 导出是为了让调用方算"剩下的额度"：一轮 prompt 里的多个来源（当前消息与滚窗
 * 上下文）共享这个上限，见 {@link BuildImageBlocksOptions.maxBlocks}。
 */
export declare const MAX_BLOCKS_PER_PROMPT = 20;
/**
 * 按字节魔数判断真实图片类型。
 *
 * 只认这四种的原因同上：runtime 只准入这四种，其余（bmp/heic/tiff）内联会被拒。
 */
export type sniffImageMimeType = (data: Uint8Array) => PromptImageMimeType | undefined;
/**
 * 把 runtime 的英文准入错误翻译成一句中文说明（进 prompt，模型会转述给用户）。
 *
 * 为什么不直接把原文塞给模型：`Image exceeds the configured per-side pixel limit.`
 * 这种句子模型只能照抄，用户拿到的是"配置的单边像素上限被超出"——既不知道发生了什么，
 * 也不知道该怎么办。原文仍然进日志。
 */
export type describeImageRejection = (reason: string) => string;
/**
 * 顺序下载、按需降采样/切片，再编码成 base64 image block。
 * 返回的 blocks 只含 image 块，text 块由调用方拼在最前面。
 */
export type buildImageBlocks = (images: readonly MessageImagePart[], options: BuildImageBlocksOptions) => Promise<ImageBlocksResult>;
/** 兜底实现：普通 GET（OneBot 的图片地址通常不需要鉴权）。 */
export type defaultFetchMedia = (media: RemoteMedia, options: MediaFetchOptions) => Promise<MediaBytes | undefined>;
