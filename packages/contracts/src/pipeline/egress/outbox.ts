/**
 * outbox 扫描器：发现 agent 放进 `<workspace>/outbox/` 的待发送产物。
 *
 * 为什么用目录约定而不是文本标记（`<<<FILE:path>>>`）：
 *   1. 超时/中断路径下文本是残缺的，标记可能写了一半；文件实打实落在磁盘上，
 *      扫描不受文本完整性影响——最需要兜底的场景恰好是它最稳的场景；
 *   2. "把产物放进指定目录"是文件操作，恰是 coding agent 最可靠的行为；
 *   3. 解析失败不会在用户屏幕上留下标记残留。
 * （完整论证见 docs/RICH-MEDIA-PLAN.md §3。）
 *
 * 安全不变量（本模块负责保证，Responder 依赖它）：
 *   - 每个候选文件的 realpath 必须仍落在 outbox 目录内——符号链接逃逸、
 *     `..` 之类的把戏在这里被挡掉；
 *   - 隐藏文件（以 `.` 开头，含归档目录 `.sent`）一律跳过；
 *   - 超过体积上限的文件不进入附件列表，只留名字供降级文案使用。
 *
 * 配额截断（发几个）**不在这里做**：那涉及回复账本，归 Responder。
 */
/**
 * outbox 扫描器：发现 agent 放进 `<workspace>/outbox/` 的待发送产物。
 *
 * 为什么用目录约定而不是文本标记（`<<<FILE:path>>>`）：
 *   1. 超时/中断路径下文本是残缺的，标记可能写了一半；文件实打实落在磁盘上，
 *      扫描不受文本完整性影响——最需要兜底的场景恰好是它最稳的场景；
 *   2. "把产物放进指定目录"是文件操作，恰是 coding agent 最可靠的行为；
 *   3. 解析失败不会在用户屏幕上留下标记残留。
 * （完整论证见 docs/RICH-MEDIA-PLAN.md §3。）
 *
 * 安全不变量（本模块负责保证，Responder 依赖它）：
 *   - 每个候选文件的 realpath 必须仍落在 outbox 目录内——符号链接逃逸、
 *     `..` 之类的把戏在这里被挡掉；
 *   - 隐藏文件（以 `.` 开头，含归档目录 `.sent`）一律跳过；
 *   - 超过体积上限的文件不进入附件列表，只留名字供降级文案使用。
 *
 * 配额截断（发几个）**不在这里做**：那涉及回复账本，归 Responder。
 */
import type { OutgoingAttachment } from '../../core/connector.js';
import type { Logger } from '../../logger.js';
/** 已发送文件的归档子目录名（隐藏目录，扫描时天然被跳过）。 */
export const SENT_DIR_NAME = '.sent';
/**
 * mtime 比较的容差（毫秒）。
 *
 * **别删**。Linux 的 inode 时间戳由**粗粒度时钟**打戳（`current_time()` 走
 * `ktime_get_coarse_real_ts64()`，按 tick 取整，HZ=250 时约 4ms），而
 * `Date.now()` 是精确值。于是"在 notBeforeMs 之后 0.1ms 写入"的文件，mtime
 * 可能比 notBeforeMs 还小几毫秒——用精确时间比它，会把**本轮刚产出的文件**
 * 当成上轮遗留静默跳过（用户永远收不到文件）。
 *
 * 这不是理论风险：CI（Linux runner）上 `tests/responder-media.test.ts` 就是
 * 因为这个稳定变红，而本机 macOS（APFS 纳秒时间戳）全绿——同一份代码、同一份
 * 测试，只差文件系统时间戳的粒度。
 *
 * 代价的取舍：容差只会让"上一轮刚结束、下一轮立刻开始"时把上次没发出去的文件
 * 再试一次。发送成功的文件早已归档进 `.sent/`（不会重发），而失败件重试一次
 * 本来就是用户想要的——比"本轮文件被静默丢掉"好得多。
 */
export const MTIME_TOLERANCE_MS = 1000;
export interface OutboxScanOptions {
  /** 单附件体积上限（字节），超出的进 oversize 名单 */
  maxFileBytes: number;
  /** 图片扩展名白名单（小写、不带点）；不在名单里的一律按 file 发 */
  imageExtensions: readonly string[];
  /**
   * 只发送 mtime 不早于该时间戳的文件（= 本轮处理开始时间）。
   *
   * 为什么必须有：上轮发送失败/超额的文件会留在 outbox 里，不过滤的话下一轮
   * 重扫会把它们再发一遍（"旧文件反复拆分发送"的生产问题）。早于此时间的
   * 文件静默跳过（只在 debug 日志留痕）——要重发旧文件，persona 已约定
   * "复制一份进 outbox"（复制即刷新 mtime）。
   *
   * 比较时留 `MTIME_TOLERANCE_MS` 的容差，理由见该常量：文件系统时间戳是粗粒度的。
   */
  notBeforeMs?: number;
  logger: Logger;
}
export interface OutboxScanResult {
  /** 通过全部校验、可以发送的附件（按文件名排序，保证顺序确定） */
  attachments: OutgoingAttachment[];
  /** 超过体积上限的文件名（Responder 用来生成降级文案） */
  oversize: string[];
  /** 未通过校验（符号链接逃逸、非常规文件等）的文件名 */
  skipped: string[];
}
/**
 * 扫描 outbox 目录。目录不存在视为"没有附件"（agent 没放东西是常态，不是错误）。
 *
 * 任何单个文件出问题都只影响它自己，绝不抛出中断整轮发送。
 */
export type scanOutbox = (dir: string, options: OutboxScanOptions) => Promise<OutboxScanResult>;
/**
 * 把成功发送的文件归档到 `outbox/.sent/`（带时间戳前缀防重名）。
 *
 * 发送失败的文件**留在原地**、不自动重发：自动重发需要跨 turn 的账本，
 * 复杂度不值——用户追问一句"把文件发我"即可（见 docs/RICH-MEDIA-PLAN.md §3）。
 *
 * 归档失败（如磁盘满）只记日志，不影响主流程。
 */
export type archiveSent = (
  dir: string,
  fileNames: readonly string[],
  logger: Logger,
  now?: () => number
) => Promise<void>;
