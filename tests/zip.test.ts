/**
 * zip.ts 单测：store-only ZIP 结构的正确性。
 *
 * 测试里用一个最小只读解析器（读 EOCD → 中央目录 → 按 local header offset
 * 取回条目内容与 CRC）做整包校验——比"看看 PK 头"强，能抓住偏移量算错、
 * CRC 没写、条目数不对这类真实 bug。
 */

import { describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';

import { packZip, packFiles } from '../src/pipeline/egress/zip.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface ParsedEntry {
  name: string;
  data: Buffer;
  crc: number;
}

/** 最小 ZIP 解析器：只支持本模块产出的 stored 条目（测试够用）。 */
function parseZip(buf: Buffer): ParsedEntry[] {
  // EOCD 固定在末尾 22 字节（我们不写 comment）
  expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50);
  const entryCount = buf.readUInt16LE(buf.length - 22 + 10);
  const centralSize = buf.readUInt32LE(buf.length - 22 + 12);
  const centralOffset = buf.readUInt32LE(buf.length - 22 + 16);
  expect(centralOffset + centralSize).toBe(buf.length - 22);

  const entries: ParsedEntry[] = [];
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    expect(buf.readUInt32LE(cursor)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const size = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    // stored + UTF-8 文件名标记
    expect(method).toBe(0);
    expect(flags & 0x0800).toBe(0x0800);

    // 按 central directory 记录的 local header offset 找回数据
    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLen;
    const data = buf.subarray(dataStart, dataStart + size);
    entries.push({ name, data: Buffer.from(data), crc });
    cursor += 46 + nameLen;
  }
  return entries;
}

describe('packZip', () => {
  it('多条目打包后可完整解析：名字、内容、CRC 全对', () => {
    const zip = packZip([
      { name: 'a.png', data: Buffer.from('png-bytes-a') },
      { name: '报告-最终版.html', data: Buffer.from('<html>中文</html>', 'utf8') },
      { name: 'c.sh', data: Buffer.from('#!/bin/sh\necho hi\n') },
    ]);

    const entries = parseZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['a.png', '报告-最终版.html', 'c.sh']);
    expect(entries[0]!.data.toString()).toBe('png-bytes-a');
    expect(entries[1]!.data.toString('utf8')).toBe('<html>中文</html>');
    expect(entries[2]!.crc).toBe(crc32(Buffer.from('#!/bin/sh\necho hi\n')));
  });

  it('空条目列表直接抛错（不产生半个 zip）', () => {
    expect(() => packZip([])).toThrow();
  });
});

describe('packFiles', () => {
  it('从磁盘读入并打包', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qqbot-zip-test-'));
    await writeFile(join(dir, 'x.txt'), 'hello');
    const zip = await packFiles([{ absPath: join(dir, 'x.txt'), fileName: 'x.txt' }]);
    const entries = parseZip(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data.toString()).toBe('hello');
  });
});
