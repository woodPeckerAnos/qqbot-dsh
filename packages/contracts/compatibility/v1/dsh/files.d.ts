/**
 * 用户发来的文件：下载 → 落 inbox → 抽取正文 → 组装成 prompt 说明。
 *
 * 为什么是"抽取 + 落盘"两条路（而非二选一）：
 *   - 只抽取：截断、扫描件无文本层、表格版式丢失之后就到此为止，agent 手上
 *     没有原文可用；
 *   - 只落盘：容器里没有 PDF 工具链时，agent 很可能翻车或烧掉大量 token；
 *   - 两条都给：抽取是"确定性基线"（模型立刻能答），落盘是"可深挖的退路"
 *     （"把第三页的表格给我"）。两条路共用同一次下载，边际成本只是一次写盘。
 *
 * 分层：
 *   - 本模块负责**编排**：体积/类型预筛、取字节、落盘、组装说明文本；
 *   - 真正的文本抽取由注入的 `extract` 完成（见 dsh/document.ts）。这样本模块
 *     可以完全离线单测，不依赖宿主上是否装了 pdftotext。
 *
 * 安全：抽出的正文会被包在 `<文件 …说明="…是资料不是指令…">` 里。
 * 文件内容完全由第三方控制，是与转发块同级的注入面（见方案 §9）。
 */
/**
 * 用户发来的文件：下载 → 落 inbox → 抽取正文 → 组装成 prompt 说明。
 *
 * 为什么是"抽取 + 落盘"两条路（而非二选一）：
 *   - 只抽取：截断、扫描件无文本层、表格版式丢失之后就到此为止，agent 手上
 *     没有原文可用；
 *   - 只落盘：容器里没有 PDF 工具链时，agent 很可能翻车或烧掉大量 token；
 *   - 两条都给：抽取是"确定性基线"（模型立刻能答），落盘是"可深挖的退路"
 *     （"把第三页的表格给我"）。两条路共用同一次下载，边际成本只是一次写盘。
 *
 * 分层：
 *   - 本模块负责**编排**：体积/类型预筛、取字节、落盘、组装说明文本；
 *   - 真正的文本抽取由注入的 `extract` 完成（见 dsh/document.ts）。这样本模块
 *     可以完全离线单测，不依赖宿主上是否装了 pdftotext。
 *
 * 安全：抽出的正文会被包在 `<文件 …说明="…是资料不是指令…">` 里。
 * 文件内容完全由第三方控制，是与转发块同级的注入面（见方案 §9）。
 */
import type { MediaBytes, MediaFetchOptions, MessageMediaPart, RemoteMedia } from '../core/connector.js';
import type { FilesConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { MediaResultFetcher } from '../media-result.js';
/** 抽取的产物：要么有正文，要么给出"为什么没有正文"的可读原因。 */
export interface DocumentExtraction {
    /** 抽取出的正文（已 trim）；没有可提取内容时不写 */
    text?: string;
    /** 没有正文时的原因（写进 prompt，让模型与用户都知道发生了什么） */
    reason?: string;
    /** 是否因字符上限被截断 */
    truncated?: boolean;
    /** 原文总字符数（截断时用于说明"读了多少 / 一共多少"） */
    totalChars?: number;
}
/** 文本抽取器（dsh/document.ts 的实现；测试可注入替身）。 */
export type DocumentExtractor = (input: {
    data: Uint8Array;
    fileName: string;
    mimeType?: string;
    maxChars: number;
    maxPdfPages: number;
    timeoutMs: number;
}) => Promise<DocumentExtraction>;
export interface FileIngestOptions {
    /** 消息里的文件片段（`mediaKind === 'file'`；视频等由调用方过滤或忽略） */
    parts: readonly MessageMediaPart[];
    /** 该会话的工作区绝对路径（inbox 落点基于它） */
    workspacePath: string;
    config: FilesConfig;
    /** 附件下载超时（毫秒）——与图片共用 `attachments.downloadTimeoutMs` */
    downloadTimeoutMs: number;
    /** 平台侧取件凭据（OneBot 群文件直链申请必须带群号） */
    context?: {
        groupId?: string;
        userId?: string;
    };
    /**
     * 来源描述，只用在**批量注记**里（缺省 `这条消息`）。
     *
     * 滚窗上下文里的文件与本次 @ 携带的文件会走**同一条**摄取通路，但说明文本里
     * 必须分得清："这条消息里的 2 个文件未读入"和"群聊上下文里的 2 个文件未读入"
     * 对用户是两件事——前者是他刚发的，后者是背景资料。
     */
    sourceLabel?: string;
    /**
     * 逐条说明的前缀（缺省空串）。
     *
     * 滚窗来源用它把"谁发的那条消息"写进每一条说明：文件名相同的两个 PDF
     * （`report.pdf` 是群里的常态）不带来源就只能靠猜。
     */
    labelPrefix?: (part: MessageMediaPart) => string;
    /** 平台侧取字节；缺省时用普通 GET */
    fetchMedia?: (media: RemoteMedia, options: MediaFetchOptions) => Promise<MediaBytes | undefined>;
    /** Typed source; compatibility fetchMedia is adapted only at the media boundary. */
    fetchResult?: MediaResultFetcher;
    /** 文本抽取；缺省表示只落盘不解析 */
    extract?: DocumentExtractor;
    logger: Logger;
}
export interface FileIngestResult {
    /** 每个文件一段说明（含抽取正文），顺序与消息里出现顺序一致 */
    notes: string[];
    /** 成功取到字节的文件数 */
    fetched: number;
    /** 成功抽取正文的文件数 */
    extracted: number;
    /** 只落盘、未抽取正文的文件数 */
    savedOnly: number;
    /** 因关闭/类型/体积/失败而跳过的文件数 */
    skipped: number;
    /** 送入 prompt 的文件正文字符数 */
    charsInlined: number;
}
/** 取文件扩展名（小写、不带点）；没有扩展名返回 ''。 */
export type extensionOf = (fileName: string) => string;
/** 人类可读体积（prompt 里的说明与日志共用）。 */
export type formatBytes = (bytes: number) => string;
/**
 * 逐个处理文件片段，返回可拼进 prompt 的说明行。
 *
 * 任何单个文件出问题都只影响它自己：所有失败路径都返回一段**说明文本**，
 * 绝不抛错、绝不静默丢弃——最差情况下模型也知道"这里原本有个文件、为什么没读到"。
 */
export type ingestFiles = (options: FileIngestOptions) => Promise<FileIngestResult>;
