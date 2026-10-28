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

import type { Metadata, Sharp, SharpOptions } from 'sharp';
import type { Logger } from '../logger.js';

// ---------------------------------------------------------------------------
// 与 runtime 对齐的硬常量
// ---------------------------------------------------------------------------

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

/** 质量阶梯：先高后低，命中即用。三档足够覆盖"能看"到"能收下"的区间。 */
const QUALITY_LADDER = [90, 82, 72] as const;

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

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
  | { kind: 'prepared'; tiles: ImageTile[]; changed: boolean; notes: string[] }
  /** sharp 无法加载：调用方退回旧行为 */
  | { kind: 'unavailable' }
  /** 字节不是可解码图片，或超出解码上限 */
  | { kind: 'undecodable'; reason: string };

/** runtime 准入的三种栅格格式（gif 只能直通，重编码一律走 png/jpeg/webp）。 */
type AdmittedMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

interface EncodedImage {
  data: Uint8Array;
  width: number;
  height: number;
  mimeType: AdmittedMimeType;
}

// ---------------------------------------------------------------------------
// sharp 的懒加载与缓存
// ---------------------------------------------------------------------------

/** sharp 的模块面。`import type` 会被完全擦除，运行时不产生静态依赖。 */
type SharpModule = typeof import('sharp');

let sharpLoad: Promise<SharpModule | undefined> | undefined;
let sharpFailureReason: string | undefined;

/**
 * 懒加载 sharp，**只尝试一次**。
 *
 * 缓存 Promise 而不是结果：并发调用共享同一次 import（图片是按批来的）；
 * 失败的结论也一并记住——native 绑定缺失不会"重试就好了"，反复重试只会
 * 每次走一遍 fs + dlopen 并刷日志。
 */
function loadSharp(): Promise<SharpModule | undefined> {
  sharpLoad ??= import('sharp').then(
    (module) => {
      if (typeof module.default !== 'function') {
        sharpFailureReason = 'sharp 模块没有默认导出';
        return undefined;
      }
      return module;
    },
    (error: unknown) => {
      sharpFailureReason = reasonOf(error);
      return undefined;
    },
  );
  return sharpLoad;
}

/** sharp 是否可用（结果缓存；只做动态 import，不抛错） */
export async function probeImagePreparer(): Promise<boolean> {
  return (await loadSharp()) !== undefined;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 把一张图片字节变成"一定能被 runtime 收下"的 1..maxTiles 个块。 */
export async function prepareImageForPrompt(
  data: Uint8Array,
  options: ImagePrepareOptions,
): Promise<ImagePrepareResult> {
  const logger = options.logger;
  const sharpModule = await loadSharp();
  if (sharpModule === undefined) {
    logger?.debug('图片预处理不可用（sharp 未加载），按旧行为处理', { reason: sharpFailureReason });
    return { kind: 'unavailable' };
  }

  // 配置值兜底：调用方传的是配置文件里的数，一个 NaN/0 不该把整条图片链路弄崩。
  // 字节上限的兜底刻意取 provider 自己的单图上限（1MiB）——它是"送进模型"这件事
  // 本身的硬约束，比任何本地默认值都更有依据。
  const maxBytes = positiveInteger(options.maxBytes, TILE_TARGET_BYTES);
  const maxTiles = positiveInteger(options.maxTiles, 1);
  const maxDimension = positiveInteger(options.maxDimension ?? ADMIT_MAX_DIMENSION, ADMIT_MAX_DIMENSION);
  const maxPixels = positiveInteger(options.maxPixels ?? ADMIT_MAX_PIXELS, ADMIT_MAX_PIXELS);
  const tilePixels = positiveInteger(options.tilePixels ?? MODEL_IMAGE_PIXEL_BUDGET, MODEL_IMAGE_PIXEL_BUDGET);

  const notes: string[] = [];

  // ---- 1. 探针：只读头，不解码 ----
  let meta: Metadata;
  try {
    meta = await sharpModule.default(data, decodeOptions()).metadata();
  } catch (error) {
    return { kind: 'undecodable', reason: `无法解码图片（${reasonOf(error)}）` };
  }

  const mimeType = mimeTypeOfFormat(meta.format);
  if (mimeType === undefined) {
    return { kind: 'undecodable', reason: `不支持的图片格式（${meta.format ?? '未知'}）` };
  }

  // metadata 的类型把 width/height 写成必填，但 SVG/损坏头这类输入运行期可能缺失，
  // 而下面的几何计算全靠这两个数。
  const rawWidth = toPixelCount(meta.width);
  const rawHeight = toPixelCount(meta.height);
  if (rawWidth === 0 || rawHeight === 0) {
    return { kind: 'undecodable', reason: '图片尺寸不可读' };
  }
  // 像素上限在**解码之前**判：真正的解压炸弹在这一步就被挡住，而不是等在
  // libvips 分配完 400MB 之后。
  if (rawWidth * rawHeight > MAX_DECODE_PIXELS) {
    return {
      kind: 'undecodable',
      reason: `图片像素过多（${rawWidth}×${rawHeight}），超过解码上限 ${MAX_DECODE_PIXELS}`,
    };
  }

  // EXIF orientation >= 5 的四档是"带转置"的（宽高互换），metadata 报的是旋转前的
  // 尺寸。后面所有几何计算、说明文本都必须用**人眼看到的**尺寸。
  const orientation = meta.orientation ?? 1;
  const transposed = orientation >= 5;
  const viewWidth = transposed ? rawHeight : rawWidth;
  const viewHeight = transposed ? rawWidth : rawHeight;
  const hasAlpha = meta.hasAlpha === true;
  const sourceIsPng = meta.format === 'png';

  // ---- 2. 快路径：原样直通 ----
  if (
    viewWidth <= maxDimension &&
    viewHeight <= maxDimension &&
    viewWidth * viewHeight <= maxPixels &&
    data.byteLength <= maxBytes
  ) {
    // 刻意原样返回、绝不重编码：runtime 的准入本来就收它，provider 对预算内的图
    // 也做字节直通；这里任何一次"顺手压一下"都只会掉画质（还可能掉透明度）。
    logger?.debug('图片无需处理，原样送入', {
      width: viewWidth,
      height: viewHeight,
      bytes: data.byteLength,
      mimeType,
    });
    return {
      kind: 'prepared',
      tiles: [{ data, mimeType, width: viewWidth, height: viewHeight }],
      changed: false,
      notes: [],
    };
  }

  // ---- 3. 长图切片 vs 等比缩放 ----
  const longSide = Math.max(viewWidth, viewHeight);
  const shortSide = Math.min(viewWidth, viewHeight);
  const vertical = viewHeight >= viewWidth;
  // 单块长边：同时受准入单边上限与模型像素预算约束，取两者更严的那个。
  // 这样每块都是"模型按原生分辨率能看清的最大一块"。
  const perTileLong = Math.max(1, Math.min(maxDimension, Math.floor(tilePixels / shortSide)));
  const sliceable =
    longSide / shortSide >= SLICE_MIN_ASPECT &&
    shortSide <= maxDimension &&
    // 短边本身就超预算时，切得再碎也不会有哪块落进预算（块短边就是短边），
    // 这时切片只是把一张糊图变成一堆糊图，不如老老实实缩放。
    shortSide <= tilePixels;
  const needed = sliceable ? Math.ceil(longSide / perTileLong) : 0;
  const count = Math.min(maxTiles, needed);

  if (sliceable && count >= 2) {
    const sliced = await sliceIntoTiles(sharpModule, {
      data,
      orientation,
      hasAlpha,
      sourceIsPng,
      maxBytes,
      logger,
    }, {
      width: viewWidth,
      height: viewHeight,
      vertical,
      count,
      perTileLong,
    });
    if (sliced.tiles.length === 0) {
      return { kind: 'undecodable', reason: sliced.failure ?? '图片切片失败（每一块都无法编码）' };
    }
    const direction = vertical ? '从上到下' : '从左到右';
    if (sliced.tiles.length === needed) {
      notes.push(`（长图已按${direction}切成 ${sliced.tiles.length} 块送入，内容完整）`);
    } else {
      const percent = Math.max(1, Math.min(100, Math.round((sliced.covered / longSide) * 100)));
      notes.push(
        `（长图过长：按可读分辨率共需 ${needed} 块，本次按${direction}只送入前 ${sliced.tiles.length} 块` +
          `（约 ${percent}%），其余未读入——建议请对方分段发送）`,
      );
    }
    logger?.info('长图已切片送入', {
      from: `${viewWidth}×${viewHeight}`,
      tileLong: perTileLong,
      needed,
      sent: sliced.tiles.length,
      percent: Math.round((sliced.covered / longSide) * 100),
    });
    return { kind: 'prepared', tiles: sliced.tiles, changed: true, notes };
  }

  // ---- 4. 等比缩放 ----
  // 说明文本要说清"为什么被缩放"：超的是尺寸上限、还是只超了字节上限（后者
  // 只是重编码时顺手缩了一档）。两者都写"超出模型可读上限"会让模型以为拿到了
  // 一张缩略图，从而不敢引用图里的细节。
  const overDimensionLimit =
    viewWidth > maxDimension || viewHeight > maxDimension || viewWidth * viewHeight > maxPixels;
  const box = fitWithin(viewWidth, viewHeight, maxDimension, maxPixels);
  const encoded = await encodeWithin(sharpModule, {
    source: data,
    // 方向还没"烤"进字节（切片路径才需要烤），所以在这里让流水线先自动定向。
    // 不用先烤一次：这一步本来就是重编码，多烤一次等于多一代画质损失。
    rotate: orientation >= 2,
    box,
    target: maxBytes,
    losslessPng: sourceIsPng,
    hasAlpha,
    logger,
  });
  if (encoded === undefined) {
    return { kind: 'undecodable', reason: '图片缩放或重编码失败' };
  }
  // 用编码结果里的真实尺寸判断"是否缩过"：libvips 的取整可能与我们算的差 1 像素，
  // 拿算出来的尺寸写说明会出现"说明说缩了、实际没缩"这种对不上的情况。
  if (encoded.width !== viewWidth || encoded.height !== viewHeight) {
    notes.push(
      overDimensionLimit
        ? `（原图 ${viewWidth}×${viewHeight} 超出模型可读上限，已等比缩放到 ` +
            `${encoded.width}×${encoded.height} 后送入）`
        : `（图片体积超过上限，已压缩到 ${encoded.width}×${encoded.height} 后送入）`,
    );
    logger?.info('图片已等比缩放', {
      from: `${viewWidth}×${viewHeight}`,
      to: `${encoded.width}×${encoded.height}`,
      bytes: encoded.data.byteLength,
    });
  } else {
    // 尺寸没变、只是字节超标：这属于"压了一下"，说明文本里不提缩放，否则会
    // 误导模型以为拿到了缩略图。
    logger?.debug('图片仅按字节上限重编码', {
      size: `${viewWidth}×${viewHeight}`,
      from: data.byteLength,
      to: encoded.data.byteLength,
    });
  }
  return { kind: 'prepared', tiles: [encoded], changed: true, notes };
}

// ---------------------------------------------------------------------------
// 切片
// ---------------------------------------------------------------------------

interface SliceRequest {
  data: Uint8Array;
  orientation: number;
  hasAlpha: boolean;
  sourceIsPng: boolean;
  maxBytes: number;
  logger?: Logger;
}

interface SliceGeometry {
  width: number;
  height: number;
  /** true = 竖长图（从上到下切），false = 横长图（从左到右切） */
  vertical: boolean;
  /** 要切几块（已按调用方配额裁剪） */
  count: number;
  perTileLong: number;
}

interface SliceOutcome {
  tiles: ImageTile[];
  /** 实际覆盖的长边像素数（有块编码失败时会小于 count × perTileLong） */
  covered: number;
  /** 一块都没切出来时的可读原因 */
  failure?: string;
}

/**
 * 沿长轴顺序切片，返回成功的块与"实际覆盖了多长"。
 *
 * 坐标必须与**人眼看到的**一致，所以带 EXIF 方向时先把旋转烤进工作字节：
 * `extract()` 的坐标是作用在解码后的像素上的，不烤就会出现"第一块切到了图的
 * 中段"这种错位——切片错位比不切更糟，模型会把断句当原文。
 */
async function sliceIntoTiles(
  sharpModule: SharpModule,
  request: SliceRequest,
  geometry: SliceGeometry,
): Promise<SliceOutcome> {
  const { logger } = request;
  let source = request.data;
  if (request.orientation >= 2) {
    const baked = await bakeOrientation(sharpModule, request.data, request.hasAlpha, logger);
    if (baked === undefined) {
      logger?.warn('EXIF 方向无法应用，放弃切片');
      return { tiles: [], covered: 0, failure: '图片的 EXIF 方向信息无法应用' };
    }
    source = baked;
  }

  const { width, height, vertical, count, perTileLong } = geometry;
  const longSide = Math.max(width, height);
  const crossExtent = vertical ? width : height;
  const target = Math.min(request.maxBytes, TILE_TARGET_BYTES);
  const tiles: ImageTile[] = [];
  let covered = 0;

  for (let index = 0; index < count; index += 1) {
    const offset = index * perTileLong;
    const length = Math.min(perTileLong, longSide - offset);
    if (length <= 0) break;
    const encoded = await encodeWithin(sharpModule, {
      source,
      rotate: false,
      region: vertical
        ? { left: 0, top: offset, width: crossExtent, height: length }
        : { left: offset, top: 0, width: length, height: crossExtent },
      target,
      losslessPng: request.sourceIsPng,
      hasAlpha: request.hasAlpha,
      logger,
    });
    // 单块失败只丢这一块：其余块仍然读得懂，整张图作废才是更糟的降级。
    if (encoded === undefined) {
      logger?.warn('长图切片中有一块编码失败，已跳过', { index, offset });
      continue;
    }
    tiles.push(encoded);
    covered += length;
  }

  return tiles.length === 0
    ? { tiles: [], covered: 0, failure: '图片切片失败（每一块都无法编码）' }
    : { tiles, covered };
}

/**
 * 把 EXIF 方向烤进字节（一次重编码），返回新的源字节。
 *
 * 为什么失败就返回 undefined、而不是"退回原字节继续切"：坐标错位的切片是**静默
 * 错误**（块能编码、能送出，只是内容错位），比明确失败危险得多。
 *
 * 中间这一代用无损格式（PNG），因为后面的每块还要再编码一次：截图这类无损源
 * 在中间掉一代画质是纯粹的浪费。代价是噪声大图会慢一些——但这类图本来也不是
 * 切片路径的常客。
 */
async function bakeOrientation(
  sharpModule: SharpModule,
  data: Uint8Array,
  hasAlpha: boolean,
  logger?: Logger,
): Promise<Uint8Array | undefined> {
  try {
    // .rotate() 不带角度 = 按 EXIF 自动定向，并且顺手把 Orientation 标签去掉，
    // 于是下游拿到的是"所见即所得"的像素与坐标。
    const pipeline = sharpModule
      .default(data, decodeOptions())
      .rotate()
      .toColourspace('srgb')
      .png({ compressionLevel: hasAlpha ? 9 : 6 });
    const { data: baked } = await pipeline.toBuffer({ resolveWithObject: true });
    return baked;
  } catch (error) {
    logger?.warn('应用 EXIF 方向失败', { error: reasonOf(error) });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

interface EncodeRequest {
  /** 源字节（已定向，或由 rotate 参数负责定向） */
  source: Uint8Array;
  /** 是否先自动定向（EXIF orientation >= 2 且尚未烤进字节时为 true） */
  rotate: boolean;
  /** 只取源图的一块（长图切片）；整体缩放时省略 */
  region?: { left: number; top: number; width: number; height: number };
  /** 输出尺寸框（等比缩到框内）；省略表示保持 region 的原生尺寸 */
  box?: { width: number; height: number };
  /** 字节上限 */
  target: number;
  /** 源是 PNG：先试无损 PNG（截图那种"大片纯色 + 文字"的图，PNG 又小又清楚） */
  losslessPng: boolean;
  hasAlpha: boolean;
  logger?: Logger;
}

/**
 * 把一块/整张图压进 `target` 字节以内。
 *
 * 顺序：无损 PNG（仅 PNG 源）→ 质量阶梯 → 缩一档再编一轮。
 * 为什么 PNG 源先试无损：截图是 QQ 里最常见的图，无损 PNG 往往比 JPEG 更小，
 * 且文字边缘不会出现 JPEG 的振铃——代价是 PNG 不达标时白编一次，可以接受。
 */
async function encodeWithin(
  sharpModule: SharpModule,
  request: EncodeRequest,
): Promise<EncodedImage | undefined> {
  const variants = encodeVariants(request.losslessPng, request.hasAlpha);

  // sharp 实例的 toBuffer() 是一次性的，换一档就得重置流水线，所以传的是"建线函数"。
  const build = (box?: { width: number; height: number }): Sharp => {
    let pipeline = sharpModule.default(request.source, decodeOptions());
    if (request.rotate) pipeline = pipeline.rotate();
    if (request.region !== undefined) pipeline = pipeline.extract(request.region);
    const final = box ?? request.box;
    if (final !== undefined) {
      pipeline = pipeline.resize({
        width: final.width,
        height: final.height,
        // inside + 不放大的组合保证"只缩不放、比例不变"：放大只会插值出假细节，
        // 还会白白撑大字节。
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    // provider 的直通条件是 8 位 sRGB / 无多余元数据，这里先转好，
    // 免得它再为色彩空间重编码一次。
    return pipeline.toColourspace('srgb');
  };

  const attempt = async (box?: { width: number; height: number }): Promise<EncodedImage | undefined> => {
    let best: EncodedImage | undefined;
    // 逐档串行 await：同一时刻只有一份解码在内存里。大图并发编码看着快，实际是
    // 把容器往 OOM 上推——单张 21.6M 像素的图解码就是几十 MB。
    for (const variant of variants) {
      const rendered = await render(build(box), variant.apply, variant.mimeType, request.logger);
      if (rendered === undefined) continue;
      if (best === undefined || rendered.data.byteLength < best.data.byteLength) best = rendered;
      if (rendered.data.byteLength <= request.target) return rendered;
    }
    return best;
  };

  const first = await attempt(undefined);
  if (first === undefined) return undefined;
  if (first.data.byteLength <= request.target) return first;

  // 阶梯全不达标：按 sqrt(目标/当前) 缩一档再编一轮。
  // **只做一轮**是有意的：再缩下去字就看不清了，"能收下但读不出"并不比失败好；
  // 这一层的目标是"尽量可读地收下"，剩下的交给调用方说明或请对方分段发送。
  // 乘 0.95 是给"字节数不随像素数严格平方缩放"留的余量。
  const scale = Math.sqrt(request.target / first.data.byteLength) * 0.95;
  const box = {
    width: Math.max(1, Math.floor(first.width * scale)),
    height: Math.max(1, Math.floor(first.height * scale)),
  };
  if (box.width === first.width && box.height === first.height) return first;

  const second = await attempt(box);
  if (second === undefined) return first;
  return second.data.byteLength < first.data.byteLength ? second : first;
}

interface EncodeVariant {
  mimeType: AdmittedMimeType;
  apply: (pipeline: Sharp) => Sharp;
}

/**
 * 候选编码档位。命中即用，全部不达标时由调用方取最小的那份。
 *
 * 带 alpha 时不走 JPEG：JPEG 没有透明通道，会把透明区域填成黑/白（QQ 里的
 * 表情包、截图的圆角外沿都会中招）；webp 是阶梯里唯一能保住透明的格式。
 * 不带 alpha 时用 JPEG：兼容面最广，同等观感下体积也够用。
 */
function encodeVariants(losslessPng: boolean, hasAlpha: boolean): EncodeVariant[] {
  const variants: EncodeVariant[] = [];
  if (losslessPng) {
    variants.push({ mimeType: 'image/png', apply: (pipeline) => pipeline.png({ compressionLevel: 9 }) });
  }
  if (hasAlpha) {
    for (const quality of QUALITY_LADDER) {
      variants.push({ mimeType: 'image/webp', apply: (pipeline) => pipeline.webp({ quality }) });
    }
    return variants;
  }
  for (const quality of QUALITY_LADDER) {
    // mozjpeg: false —— mozjpeg 的默认参数偏"极致压缩"，在需要快速出图的服务里
    // 不值得，且它会把质量参数的解释整个换一套，跨机器结果差异更大。
    variants.push({
      mimeType: 'image/jpeg',
      apply: (pipeline) => pipeline.jpeg({ quality, mozjpeg: false }),
    });
  }
  return variants;
}

/** 跑一条流水线并取回真实输出尺寸（编码失败返回 undefined，绝不抛）。 */
async function render(
  pipeline: Sharp,
  apply: (pipeline: Sharp) => Sharp,
  mimeType: AdmittedMimeType,
  logger?: Logger,
): Promise<EncodedImage | undefined> {
  try {
    // resolveWithObject 顺手给出 info.width/height：它是 libvips 舍入后的**真实**尺寸，
    // 比我们自己算的缩放结果更可信（说明文本要用它）。
    const { data, info } = await apply(pipeline).toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, mimeType };
  } catch (error) {
    logger?.warn('图片编码失败，换下一档', { mimeType, error: reasonOf(error) });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 每条流水线都必须带的解码选项。
 *
 * `animated: false` 与 runtime 自己的归一化保持一致（动图取首帧）——不然同一张
 * 图在"准入看到的"和"模型看到的"之间会变成两个东西。`limitInputPixels` 是最后
 * 一道防线：即便上游漏判，libvips 也不会为一张声明尺寸造假的图分配天量内存。
 */
function decodeOptions(): SharpOptions {
  return { failOn: 'error', limitInputPixels: MAX_DECODE_PIXELS, animated: false };
}

/**
 * 等比缩到框内。
 *
 * 只缩不放：放大只会插值出并不存在的细节（模型会把糊掉的边缘当证据），
 * 而且白白撑大字节数。`scale < 1` 之外的输入（NaN、无穷）一律按"不动"处理。
 */
function fitWithin(
  width: number,
  height: number,
  maxDimension: number,
  maxPixels: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  if (!(scale < 1)) return { width, height };
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/** sharp 报的格式名 → runtime 准入的 MIME；不在准入集合里返回 undefined。 */
function mimeTypeOfFormat(format: string | undefined): AdmittedMimeType | 'image/gif' | undefined {
  switch (format) {
    case 'png':
      return 'image/png';
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return undefined;
  }
}

/**
 * 出错原因压成一行短文本。
 *
 * reason 会被调用方拼进 prompt 说明里，换行与超长都会把说明撑坏（还能伪造出
 * 结构），所以这里就把空白压平、长度截断——错误信息本身不值得为它冒注入风险。
 */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/**
 * 配置值兜底。
 *
 * 这些数来自配置文件（config/media.yml），NaN/0/负数在配置层可能被漏掉，但绝不能让它们把
 * 几何计算变成 NaN（那会切出 0 像素的块或死循环）。
 */
function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/** metadata 里的尺寸转成"可用的像素数"；缺失/非法一律算 0（调用方按不可解码处理）。 */
function toPixelCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
