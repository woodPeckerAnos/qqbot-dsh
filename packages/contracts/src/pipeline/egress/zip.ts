/**
 * 最小 ZIP 打包器（store-only，不压缩）。
 *
 * 为什么自己写而不是引依赖：
 *   - 用途单一：把 outbox 里本轮的多个产物打成一个 zip，作为**一条**文件消息
 *     发出（"多文件合并发送"的桥接侧实现，见 responder.ts）；
 *   - 只需 stored（不压缩）条目：要发的大多是图片/已压缩格式，deflate 收益小，
 *     省掉压缩换实现极简（无第三方依赖，容器镜像不变）；
 *   - 体积在打包前由调用方按 maxFileBytes 预估过，这里不做流式/backpressure。
 *
 * 格式约束：条目数 < 65535、单文件与总包 < 4GiB（ZIP32 限制）。调用方传入的
 * 总量受 media.maxFileBytes（≤100MB）约束，远够不到这些边界。
 * 文件名按 UTF-8 写入并设置 general purpose bit 11（EPFS），中文名在
 * Windows/macOS/QQ 端都能正确解出。
 */
export interface ZipEntry {
  /** 包内文件名（UTF-8；不含目录） */
  name: string;
  data: Buffer;
}
/** 打包若干条目为一个 zip 包（全部 stored、不压缩）。 */
export type packZip = (entries: readonly ZipEntry[], now?: Date) => Buffer;
/** 从磁盘读入若干文件并打包。调用方负责体积预算与路径安全（outbox 扫描已做）。 */
export type packFiles = (
  files: readonly {
    absPath: string;
    fileName: string;
  }[]
) => Promise<Buffer>;
