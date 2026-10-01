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

import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

export interface ZipEntry {
  /** 包内文件名（UTF-8；不含目录） */
  name: string;
  data: Buffer;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION = 20;
const UTF8_FLAG = 0x0800;
const METHOD_STORED = 0;

/** 把 Date 转成 DOS 时间戳（ZIP 头部格式）。 */
function dosTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** 打包若干条目为一个 zip 包（全部 stored、不压缩）。 */
export function packZip(entries: readonly ZipEntry[], now: Date = new Date()): Buffer {
  if (entries.length === 0) throw new Error('packZip 至少需要 1 个条目');
  if (entries.length > 0xffff) throw new Error('zip 条目数超过 ZIP32 上限');

  const { time, date } = dosTime(now);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.byteLength;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(METHOD_STORED, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, entry.data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    header.writeUInt16LE(VERSION, 4); // version made by
    header.writeUInt16LE(VERSION, 6); // version needed
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(METHOD_STORED, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(size, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(nameBytes.byteLength, 28);
    // extra/comment/disk/internal/external 全 0；local header offset：
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += 30 + nameBytes.byteLength + size;
  }

  const centralStart = offset;
  const centralBody = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBody.byteLength, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([...chunks, centralBody, eocd]);
}

/** 从磁盘读入若干文件并打包。调用方负责体积预算与路径安全（outbox 扫描已做）。 */
export async function packFiles(files: readonly { absPath: string; fileName: string }[]): Promise<Buffer> {
  const entries: ZipEntry[] = [];
  for (const file of files) {
    entries.push({ name: file.fileName, data: await readFile(file.absPath) });
  }
  return packZip(entries);
}
