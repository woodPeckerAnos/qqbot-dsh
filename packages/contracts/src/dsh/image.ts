/**
 * 图片准入前处理：把 runtime 一定会拒收的图，变成"一定能被收下"的 1..N 个块。
 *
 * 为什么要有这一层（而不是超限就拒收）：
 *   1. DSH 附件准入是硬门槛：>6400 万像素、单边 >8192、编码 >20MiB 会被
 *      `IMAGE_TOO_MANY_PIXELS` / `IMAGE_DIMENSION_TOO_LARGE` 整条拒掉，用户发的
 *      长截图（聊天记录、网页长图）动辄两万像素高，命中率并不低；
 *   2. 只等比缩小最省事，但 20000 高的长图压进 8192 之后字已经糊了，模型
 *      "看得到图、读不出字"，等于没送；
 *   3. 所以长条图按**原生分辨率**切片：provider 对每张图有 640000 像素的
 *      `imagePixelBudget`，单块落在预算内就字节直通、不再重编码，字还是清楚的；
 *      调用方把每块依次送进去，模型顺着读即可。
 *
 * 分层：media.ts 管"把字节取到手"，本模块只管"把字节变成能被收下的形状"。
 * 这里不认识 prompt 协议（返回 `Uint8Array`，base64 与说明文本由调用方拼），
 * 也不做任何网络/落盘——纯字节进、纯字节出，单测可以离线跑真 sharp。
 *
 * 为什么 sharp 走动态 import：它是 native 依赖（容器/宿主上未必装得上）。
 * 静态 import 一旦加载失败，整个 bot 起不来；动态 import + 结果缓存之后，
 * 坏掉的只是"图片增强"这一条路，调用方拿到 `unavailable` 后退回旧行为即可。
 */
/**
 * 图片准入前处理：把 runtime 一定会拒收的图，变成"一定能被收下"的 1..N 个块。
 *
 * 为什么要有这一层（而不是超限就拒收）：
 *   1. DSH 附件准入是硬门槛：>6400 万像素、单边 >8192、编码 >20MiB 会被
 *      `IMAGE_TOO_MANY_PIXELS` / `IMAGE_DIMENSION_TOO_LARGE` 整条拒掉，用户发的
 *      长截图（聊天记录、网页长图）动辄两万像素高，命中率并不低；
 *   2. 只等比缩小最省事，但 20000 高的长图压进 8192 之后字已经糊了，模型
 *      "看得到图、读不出字"，等于没送；
 *   3. 所以长条图按**原生分辨率**切片：provider 对每张图有 640000 像素的
 *      `imagePixelBudget`，单块落在预算内就字节直通、不再重编码，字还是清楚的；
 *      调用方把每块依次送进去，模型顺着读即可。
 *
 * 分层：media.ts 管"把字节取到手"，本模块只管"把字节变成能被收下的形状"。
 * 这里不认识 prompt 协议（返回 `Uint8Array`，base64 与说明文本由调用方拼），
 * 也不做任何网络/落盘——纯字节进、纯字节出，单测可以离线跑真 sharp。
 *
 * 为什么 sharp 走动态 import：它是 native 依赖（容器/宿主上未必装得上）。
 * 静态 import 一旦加载失败，整个 bot 起不来；动态 import + 结果缓存之后，
 * 坏掉的只是"图片增强"这一条路，调用方拿到 `unavailable` 后退回旧行为即可。
 */
import type { Logger } from '../logger.js';
/**
 * 单边上限，对齐 `@deepseek-ai/dsh-attachment-local` 的 `maxImageDimension`（8192）。
 * 超过它的图在准入时被直接拒绝（`IMAGE_DIMENSION_TOO_LARGE`）。
 */
export const ADMIT_MAX_DIMENSION = 8192;
/**
 * 总像素上限，对齐同一个包的 `maxImagePixels`（64_000_000）。
 * 准入时它**先于**单边上限判定，所以两个都要守。
 */
export const ADMIT_MAX_PIXELS = 64_000_000;
/**
 * 模型侧单图像素预算，对齐 `@deepseek-ai/dsh-llm-deepseek` 默认模型的
 * `imagePixelBudget`（640_000）。
 *
 * 刻意对齐它而不是随便取个小值：预算内的图在 provider 请求阶段**字节直通**
 * （不重编码、不掉画质），恰好等于"模型按原生分辨率看图"。切片按这个数切，
 * 每块就是"模型能看清的最大一块"。
 */
export const MODEL_IMAGE_PIXEL_BUDGET = 640_000;
/**
 * 解码上限（1 亿像素），比准入上限宽一档：准入看的是"编码里的声明尺寸"，
 * 解码吃的是"真实内存"。1 亿像素 RGBA 已是 ~400MB，再往上就是解压炸弹与
 * 容器 OOM 的领域了——宁可判 `undecodable`，也不要把宿主拖死。
 */
export const MAX_DECODE_PIXELS = 100_000_000;
/**
 * 长边/短边达到这个倍数才算"长图"，值得切片。
 *
 * 4 是个经验阈值：3 以下的图切片收益（读得清）抵不过代价（多张图的 token
 * 与调用方的配额）；而 4 以上基本就是截图/长图，缩放的损失已经很明显。
 */
export const SLICE_MIN_ASPECT = 4;
/**
 * 单块字节目标，对齐 provider 的 `imageMaxBytes`（1MiB）。
 *
 * 对齐它是为了让调用方**省掉二次压缩**：provider 只对超预算的图重编码，
 * 我们这里就把块压到它的上限内，provider 那一步就成了纯直通。
 */
export const TILE_TARGET_BYTES = 1024 * 1024;
export interface ImageTile {
  data: Uint8Array;
  /** 'image/png' | 'image/jpeg' | 'image/webp' —— 必须是 runtime 准入的三种之一 */
  mimeType: string;
  width: number;
  height: number;
}
export interface ImagePrepareOptions {
  /** 内联单张上限（配置值） */
  maxBytes: number;
  /** 本次最多允许产出几块（调用方按剩余配额传入，>=1） */
  maxTiles: number;
  /** 覆盖默认：单边上限 */
  maxDimension?: number;
  /** 覆盖默认：像素上限 */
  maxPixels?: number;
  /** 覆盖默认：切片单块像素预算 */
  tilePixels?: number;
  logger?: Logger;
}
export type ImagePrepareResult =
  | {
      kind: 'prepared';
      tiles: ImageTile[];
      changed: boolean;
      notes: string[];
    }
  /** sharp 无法加载：调用方退回旧行为 */
  | {
      kind: 'unavailable';
    }
  /** 字节不是可解码图片，或超出解码上限 */
  | {
      kind: 'undecodable';
      reason: string;
    };
/** sharp 是否可用（结果缓存；只做动态 import，不抛错） */
export type probeImagePreparer = () => Promise<boolean>;
/** 把一张图片字节变成"一定能被 runtime 收下"的 1..maxTiles 个块。 */
export type prepareImageForPrompt = (
  data: Uint8Array,
  options: ImagePrepareOptions
) => Promise<ImagePrepareResult>;
