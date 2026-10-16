/**
 * 图片准入前处理单测（全离线，跑真 sharp）。
 *
 * 为什么用真 sharp 而不是替身：这一层的全部价值就在"几何对不对"——切片切在了
 * 哪一段、缩放后的尺寸与字节数是多少。把 sharp 换成替身之后，剩下的只是我自己
 * 写的算术在自证，等于没测。所以 fixture 用 sharp 现场生成（不提交二进制），
 * 只在两处收着点：
 *   1. 大多数用例用 maxDimension/maxPixels/tilePixels 覆盖默认值，把编码量压到
 *      几十毫秒；
 *   2. 但至少留两组**真阈值**的用例（20000 高的长图、9000 宽的方图），否则
 *      "对齐 runtime 常量"这句话就没被任何测试盯住。
 *
 * 切片用例靠"颜色由坐标决定"的 fixture 验证连续性：每块的第一行颜色必须等于
 * 该块起点坐标应有的颜色——只对块数/高度做断言的话，切歪了（比如每块都从 0
 * 开始切）照样能过。
 */

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  ADMIT_MAX_DIMENSION,
  ADMIT_MAX_PIXELS,
  MODEL_IMAGE_PIXEL_BUDGET,
  TILE_TARGET_BYTES,
  prepareImageForPrompt,
  probeImagePreparer,
  type ImagePrepareResult,
} from '../src/dsh/image.js';
import { createNullLogger } from '../src/logger.js';

const logger = createNullLogger();

/** 配置里的默认内联上限（attachments.maxImageBytes），比 TILE_TARGET_BYTES 宽。 */
const CONFIG_MAX_BYTES = 8 * 1024 * 1024;

/** 某坐标应有的颜色（fixture 用的规则，同时也是断言的期望值）。 */
function rampColor(x: number, y: number): [number, number, number] {
  return [x & 255, y & 255, (x ^ y) & 255];
}

/**
 * 生成颜色由 (x, y) 决定的无损 PNG（规则与 rampColor 一致）。
 *
 * 无损是刻意的：切片断言要比对像素，JPEG 的色度二次采样会把"哪一段"糊掉。
 */
async function rampPng(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      raw[index] = x & 255;
      raw[index + 1] = y & 255;
      raw[index + 2] = (x ^ y) & 255;
    }
  }
  return await sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/** 生成只在"列"方向变化的无损 PNG（EXIF 方向用例：转正后颜色随行变化）。 */
async function columnRampPng(width: number, height: number, orientation: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      raw[index] = (x >> 4) & 255;
      raw[index + 1] = ((x >> 4) * 3) & 255;
      raw[index + 2] = 128;
    }
  }
  return await sharp(raw, { raw: { width, height, channels: 3 } })
    .withMetadata({ orientation })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/**
 * 生成接近不可压缩的 PNG（用来逼出"字节超限"路径）。
 *
 * 用固定种子的 xorshift 而不是 `randomBytes`：这条路径会走"编一档不行再缩一档"，
 * 输出体积是断言的一部分，随机噪声会让用例偶发失败（而且失败了还不好复现）。
 */
async function noisePng(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let state = 0x9e3779b9;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  for (let offset = 0; offset < raw.length; offset += 4) {
    const word = next();
    for (let byte = 0; byte < 4 && offset + byte < raw.length; byte += 1) {
      raw[offset + byte] = (word >>> (byte * 8)) & 255;
    }
  }
  return await sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/** 读某块图里 (x, y) 处的 RGB（sRGB 三通道，够用）。 */
async function pixelAt(data: Uint8Array, x: number, y: number): Promise<number[]> {
  const { data: raw, info } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
  const index = (y * info.width + x) * info.channels;
  return [raw[index] ?? -1, raw[index + 1] ?? -1, raw[index + 2] ?? -1];
}

function expectPrepared(result: ImagePrepareResult): Extract<ImagePrepareResult, { kind: 'prepared' }> {
  if (result.kind !== 'prepared') throw new Error(`期望 prepared，实际 ${JSON.stringify(result)}`);
  return result;
}

describe('probeImagePreparer', () => {
  it('sharp 装得上就返回 true（容器里装不上时才会退化成 false）', async () => {
    await expect(probeImagePreparer()).resolves.toBe(true);
  });
});

describe('prepareImageForPrompt 快路径', () => {
  it('尺寸与体积都合规时原样返回：字节不动、无说明', async () => {
    const png = await rampPng(200, 200);
    const result = expectPrepared(
      await prepareImageForPrompt(png, { maxBytes: CONFIG_MAX_BYTES, maxTiles: 3, logger }),
    );

    expect(result.changed).toBe(false);
    expect(result.notes).toEqual([]);
    expect(result.tiles).toHaveLength(1);
    const tile = result.tiles[0]!;
    // 同一个引用：这一层最怕"顺手重编码一下"，重编码既掉画质又掉元数据
    expect(tile.data).toBe(png);
    expect(tile.mimeType).toBe('image/png');
    expect(tile.width).toBe(200);
    expect(tile.height).toBe(200);
  });

  it('直通时 MIME 取自字节的真实格式（JPEG 不会被当成 PNG）', async () => {
    const jpeg = await sharp({
      create: { width: 120, height: 80, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();
    const result = expectPrepared(
      await prepareImageForPrompt(jpeg, { maxBytes: CONFIG_MAX_BYTES, maxTiles: 3, logger }),
    );

    expect(result.changed).toBe(false);
    expect(result.tiles[0]!.mimeType).toBe('image/jpeg');
  });
});

describe('prepareImageForPrompt 长图切片', () => {
  it('1080×20000 的竖长图按配额切片，每块都不超准入与模型预算，且逐块连续', async () => {
    const png = await rampPng(1080, 20_000);
    const result = expectPrepared(
      await prepareImageForPrompt(png, { maxBytes: CONFIG_MAX_BYTES, maxTiles: 3, logger }),
    );

    // 单块长边 = min(8192, floor(640000 / 1080)) = 592；共需 ceil(20000 / 592) = 34 块
    expect(result.changed).toBe(true);
    expect(result.tiles).toHaveLength(3);
    const perTileLong = Math.floor(MODEL_IMAGE_PIXEL_BUDGET / 1080);
    expect(perTileLong).toBe(592);

    result.tiles.forEach((tile) => {
      expect(tile.width).toBe(1080);
      expect(tile.height).toBe(perTileLong);
      expect(tile.width).toBeLessThanOrEqual(ADMIT_MAX_DIMENSION);
      expect(tile.height).toBeLessThanOrEqual(ADMIT_MAX_DIMENSION);
      expect(tile.width * tile.height).toBeLessThanOrEqual(MODEL_IMAGE_PIXEL_BUDGET);
      expect(tile.data.byteLength).toBeLessThanOrEqual(Math.min(CONFIG_MAX_BYTES, TILE_TARGET_BYTES));
      expect(['image/png', 'image/jpeg', 'image/webp']).toContain(tile.mimeType);
    });

    for (let index = 0; index < result.tiles.length; index += 1) {
      const tile = result.tiles[index]!;
      const expected = rampColor(0, index * perTileLong);
      await expect(pixelAt(tile.data, 0, 0)).resolves.toEqual(expected);
      // 块末行也要对得上：只对首行断言的话，"块内被缩放/裁短"这类错误会漏
      await expect(pixelAt(tile.data, 0, tile.height - 1)).resolves.toEqual(
        rampColor(0, index * perTileLong + perTileLong - 1),
      );
    }

    // 需求 34 块、只送了 3 块 → 必须说清"没读完"和读了多少（3*592/20000 ≈ 8.88% → 9%）
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('共需 34 块');
    expect(result.notes[0]).toContain('只送入前 3 块');
    expect(result.notes[0]).toContain('约 9%');
    expect(result.notes[0]).toContain('未读入');
  });

  it('配额够时不切碎也不留尾巴：块高之和等于原高，说明写"内容完整"', async () => {
    const png = await rampPng(400, 4000);
    const result = expectPrepared(
      await prepareImageForPrompt(png, {
        maxBytes: CONFIG_MAX_BYTES,
        maxTiles: 8,
        // 4000 高没超真实的单边上限，只有把像素上限压低才能逼出切片路径
        maxPixels: 1_000_000,
        logger,
      }),
    );

    // floor(640000 / 400) = 1600 → 共需 ceil(4000 / 1600) = 3 块，配额 8 够用
    expect(result.tiles).toHaveLength(3);
    const covered = result.tiles.reduce((sum, tile) => sum + tile.height, 0);
    expect(covered).toBe(4000);
    await expect(pixelAt(result.tiles[2]!.data, 0, 0)).resolves.toEqual(rampColor(0, 3200));

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('从上到下');
    expect(result.notes[0]).toContain('内容完整');
    expect(result.notes[0]).toContain('切成 3 块');
  });

  it('20000×600 的横长图从左到右切', async () => {
    const png = await rampPng(20_000, 600);
    const result = expectPrepared(
      await prepareImageForPrompt(png, { maxBytes: CONFIG_MAX_BYTES, maxTiles: 3, logger }),
    );

    // floor(640000 / 600) = 1066
    const perTileLong = Math.floor(MODEL_IMAGE_PIXEL_BUDGET / 600);
    expect(perTileLong).toBe(1066);
    expect(result.tiles).toHaveLength(3);
    result.tiles.forEach((tile) => {
      expect(tile.width).toBe(perTileLong);
      expect(tile.height).toBe(600);
      expect(tile.width * tile.height).toBeLessThanOrEqual(MODEL_IMAGE_PIXEL_BUDGET);
    });
    for (let index = 0; index < result.tiles.length; index += 1) {
      await expect(pixelAt(result.tiles[index]!.data, 0, 0)).resolves.toEqual(
        rampColor(index * perTileLong, 0),
      );
    }

    expect(result.notes[0]).toContain('共需 19 块');
    expect(result.notes[0]).toContain('约 16%');
  });

  it('横向长图配额够时写"从左到右"且内容完整', async () => {
    const png = await rampPng(4000, 600);
    const result = expectPrepared(
      await prepareImageForPrompt(png, {
        maxBytes: CONFIG_MAX_BYTES,
        maxTiles: 8,
        maxPixels: 1_000_000,
        logger,
      }),
    );

    // floor(640000 / 600) = 1066 → 共需 ceil(4000 / 1066) = 4 块
    const perTileLong = Math.floor(MODEL_IMAGE_PIXEL_BUDGET / 600);
    expect(result.tiles).toHaveLength(4);
    const covered = result.tiles.reduce((sum, tile) => sum + tile.width, 0);
    expect(covered).toBe(4000);
    await expect(pixelAt(result.tiles[3]!.data, 0, 0)).resolves.toEqual(
      rampColor(3 * perTileLong, 0),
    );

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('从左到右');
    expect(result.notes[0]).toContain('内容完整');
    expect(result.notes[0]).toContain('切成 4 块');
  });

  it('EXIF 方向先烤正再切：块坐标按人眼看到的方向走', async () => {
    // 存储态 4000×500 + orientation 6 → 人眼看到 500×4000（竖长图，长宽比 8）
    const png = await columnRampPng(4000, 500, 6);
    const viewed = await sharp(png).metadata();
    expect(viewed.orientation).toBe(6);

    const result = expectPrepared(
      await prepareImageForPrompt(png, {
        maxBytes: CONFIG_MAX_BYTES,
        maxTiles: 3,
        // 转正后 500×4000 没超真实上限，压低像素上限才能逼出切片路径
        maxPixels: 1_000_000,
        logger,
      }),
    );
    // 转正后短边 500 → 单块长边 min(8192, floor(640000/500)) = 1280，共需 4 块
    const perTileLong = Math.floor(MODEL_IMAGE_PIXEL_BUDGET / 500);
    expect(perTileLong).toBe(1280);
    expect(result.tiles).toHaveLength(3);
    for (const tile of result.tiles) {
      // 尺寸是转正后的：宽 500、高 1280（若没烤正就会切成 4000×500 的横条）
      expect(tile.width).toBe(500);
      expect(tile.height).toBe(perTileLong);
    }
    // 存储态每列一个颜色，转正后每行一个颜色：第 index 块的首行颜色对应源列 index*1280
    for (let index = 0; index < result.tiles.length; index += 1) {
      const column = index * perTileLong;
      await expect(pixelAt(result.tiles[index]!.data, 0, 0)).resolves.toEqual([
        (column >> 4) & 255,
        ((column >> 4) * 3) & 255,
        128,
      ]);
    }
    expect(result.notes[0]).toContain('共需 4 块');
    expect(result.notes[0]).toContain('约 96%');
  });

  it('配额只有 1 块时绝不切片', async () => {
    const png = await rampPng(1080, 20_000);
    const result = expectPrepared(
      await prepareImageForPrompt(png, { maxBytes: CONFIG_MAX_BYTES, maxTiles: 1, logger }),
    );

    expect(result.tiles).toHaveLength(1);
    expect(result.tiles[0]!.height).toBeLessThanOrEqual(ADMIT_MAX_DIMENSION);
    expect(result.notes.join('')).not.toContain('切成');
    expect(result.notes.join('')).toContain('已等比缩放到');
  });
});

describe('prepareImageForPrompt 等比缩放', () => {
  it('9000×9000（真阈值）缩进准入框内并压到字节上限以下', async () => {
    // 9000×9000 = 8100 万像素 > ADMIT_MAX_PIXELS，且长宽比 1 不构成"长图"
    const raw = Buffer.alloc(9000 * 9000 * 3);
    for (let y = 0; y < 9000; y += 1) {
      for (let x = 0; x < 9000; x += 1) {
        const index = (y * 9000 + x) * 3;
        raw[index] = (x >> 4) & 255;
        raw[index + 1] = (y >> 4) & 255;
        raw[index + 2] = 128;
      }
    }
    const source = await sharp(raw, { raw: { width: 9000, height: 9000, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer();

    const result = expectPrepared(
      await prepareImageForPrompt(source, {
        maxBytes: 2 * 1024 * 1024,
        maxTiles: 2,
        logger,
      }),
    );

    expect(result.changed).toBe(true);
    expect(result.tiles).toHaveLength(1);
    const tile = result.tiles[0]!;
    expect(tile.width).toBeLessThanOrEqual(ADMIT_MAX_DIMENSION);
    expect(tile.height).toBeLessThanOrEqual(ADMIT_MAX_DIMENSION);
    expect(tile.width * tile.height).toBeLessThanOrEqual(ADMIT_MAX_PIXELS);
    expect(tile.data.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    // 比例没被改坏
    expect(Math.abs(tile.width / tile.height - 1)).toBeLessThan(0.01);

    // 说明里的尺寸必须是**真实**输出尺寸，不能是我们算出来的期望值
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('超出模型可读上限');
    expect(result.notes[0]).toContain(`缩放到 ${tile.width}×${tile.height}`);
  });

  it('像素超限但长宽比不到 4 的图不切片，直接缩放', async () => {
    const png = await rampPng(1200, 400);
    const result = expectPrepared(
      await prepareImageForPrompt(png, {
        maxBytes: CONFIG_MAX_BYTES,
        maxTiles: 4,
        maxPixels: 100_000,
        logger,
      }),
    );

    expect(result.tiles).toHaveLength(1);
    expect(result.tiles[0]!.width * result.tiles[0]!.height).toBeLessThanOrEqual(100_000);
    expect(result.notes.join('')).toContain('已等比缩放到');
    expect(result.notes.join('')).not.toContain('切成');
  });

  it('短边本身就超单块像素预算时不切片（切了也不会有哪块落进预算）', async () => {
    const png = await rampPng(4000, 400);
    const result = expectPrepared(
      await prepareImageForPrompt(png, {
        maxBytes: CONFIG_MAX_BYTES,
        maxTiles: 4,
        // 短边 400 > 100：任何一块的短边都还是 400，切片毫无意义
        tilePixels: 100,
        maxPixels: 200_000,
        logger,
      }),
    );

    expect(result.tiles).toHaveLength(1);
    expect(result.notes.join('')).not.toContain('切成');
  });

  it('尺寸合规但字节超限的图被压到字节上限以内', async () => {
    // 噪声图不可压缩：3000×3000 的 PNG 有 20MB+，远超声明的 300KB
    const png = await noisePng(3000, 3000);
    expect(png.byteLength).toBeGreaterThan(5_000_000);

    const result = expectPrepared(
      await prepareImageForPrompt(png, { maxBytes: 300_000, maxTiles: 2, logger }),
    );

    expect(result.changed).toBe(true);
    expect(result.tiles).toHaveLength(1);
    const tile = result.tiles[0]!;
    expect(tile.data.byteLength).toBeLessThanOrEqual(300_000);
    expect(tile.width).toBeLessThanOrEqual(ADMIT_MAX_DIMENSION);
    expect(tile.height).toBeLessThanOrEqual(ADMIT_MAX_DIMENSION);
    expect(['image/png', 'image/jpeg', 'image/webp']).toContain(tile.mimeType);
  });
});

describe('prepareImageForPrompt 兜底', () => {
  it('垃圾字节判不可解码，并给一句可读原因', async () => {
    const result = await prepareImageForPrompt(Buffer.from('not an image'), {
      maxBytes: CONFIG_MAX_BYTES,
      maxTiles: 3,
      logger,
    });

    expect(result.kind).toBe('undecodable');
    if (result.kind !== 'undecodable') throw new Error('unreachable');
    expect(result.reason.length).toBeGreaterThan(0);
    // reason 会被拼进 prompt 说明：不能带换行（否则说明会被撑成多行、结构可被伪造）
    expect(result.reason).not.toContain('\n');
  });

  it('空字节不抛错', async () => {
    const result = await prepareImageForPrompt(new Uint8Array(0), {
      maxBytes: CONFIG_MAX_BYTES,
      maxTiles: 3,
      logger,
    });

    expect(result.kind).toBe('undecodable');
  });
});
