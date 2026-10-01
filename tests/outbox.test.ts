/**
 * outbox 扫描器测试：产物发现、分类、体积上限、符号链接安全、归档。
 *
 * 全部用真实文件系统（tmpdir）：符号链接逃逸与 realpath 包含性校验
 * 只有真实 fs 才能验出真假。
 */

import { mkdtemp, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { archiveSent, SENT_DIR_NAME, scanOutbox } from '../src/pipeline/egress/outbox.js';
import { createNullLogger } from '../src/logger.js';

const SCAN_OPTIONS = {
  maxFileBytes: 1024,
  imageExtensions: ['png', 'jpg', 'jpeg', 'gif'],
  logger: createNullLogger(),
};

let dirs: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeOutbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qqbot-outbox-test-'));
  dirs.push(root);
  const outbox = join(root, 'outbox');
  await mkdir(outbox, { recursive: true });
  return outbox;
}

describe('scanOutbox', () => {
  it('目录不存在 = 没有产物（不报错）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qqbot-outbox-test-'));
    dirs.push(root);
    const result = await scanOutbox(join(root, 'outbox'), SCAN_OPTIONS);
    expect(result.attachments).toEqual([]);
    expect(result.oversize).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('按扩展名白名单分类：png 是图片，html/sh/svg 是文件', async () => {
    const outbox = await makeOutbox();
    await writeFile(join(outbox, 'a.png'), 'png-bytes');
    await writeFile(join(outbox, 'b.html'), '<html></html>');
    await writeFile(join(outbox, 'c.sh'), '#!/bin/sh');
    await writeFile(join(outbox, 'd.svg'), '<svg/>');

    const result = await scanOutbox(outbox, SCAN_OPTIONS);
    const byName = new Map(result.attachments.map((a) => [a.fileName, a.kind]));
    expect(byName.get('a.png')).toBe('image');
    expect(byName.get('b.html')).toBe('file');
    expect(byName.get('c.sh')).toBe('file');
    // svg 是图片但不进白名单：按文件发（平台不把它当图片渲染）
    expect(byName.get('d.svg')).toBe('file');
    // absPath 是 realpath 后的路径（macOS 上 /var → /private/var），断言结尾即可
    expect(result.attachments[0]?.absPath.endsWith(join('outbox', 'a.png'))).toBe(true);
    expect(result.attachments[0]?.sizeBytes).toBeGreaterThan(0);
  });

  it('隐藏文件与 .sent 归档目录被跳过；子目录进 skipped', async () => {
    const outbox = await makeOutbox();
    await writeFile(join(outbox, '.DS_Store'), 'junk');
    await mkdir(join(outbox, SENT_DIR_NAME));
    await writeFile(join(outbox, SENT_DIR_NAME, 'old.png'), 'x');
    await mkdir(join(outbox, 'subdir'));
    await writeFile(join(outbox, 'real.txt'), 'hello');

    const result = await scanOutbox(outbox, SCAN_OPTIONS);
    expect(result.attachments.map((a) => a.fileName)).toEqual(['real.txt']);
    expect(result.skipped).toEqual(['subdir']);
  });

  it('超体积文件进 oversize 名单，不进附件列表', async () => {
    const outbox = await makeOutbox();
    await writeFile(join(outbox, 'big.bin'), Buffer.alloc(2048));
    await writeFile(join(outbox, 'small.bin'), 'tiny');

    const result = await scanOutbox(outbox, SCAN_OPTIONS);
    expect(result.oversize).toEqual(['big.bin']);
    expect(result.attachments.map((a) => a.fileName)).toEqual(['small.bin']);
  });

  it('符号链接：指向 outbox 内的放行，逃逸的被跳过', async () => {
    const outbox = await makeOutbox();
    await writeFile(join(outbox, 'real.png'), 'png-bytes');
    await symlink(join(outbox, 'real.png'), join(outbox, 'alias.png'));

    // 逃逸目标：outbox 外的文件
    const outside = join(dirs[0]!, 'secret.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, join(outbox, 'escape.txt'));

    const result = await scanOutbox(outbox, SCAN_OPTIONS);
    const names = result.attachments.map((a) => a.fileName);
    expect(names).toContain('real.png');
    expect(names).toContain('alias.png');
    expect(names).not.toContain('escape.txt');
    expect(result.skipped).toContain('escape.txt');
  });
});

describe('archiveSent', () => {
  it('已发送文件移入 .sent（带时间戳前缀），outbox 里不再被扫到', async () => {
    const outbox = await makeOutbox();
    await writeFile(join(outbox, 'a.png'), 'png-bytes');
    await writeFile(join(outbox, 'b.txt'), 'left');

    await archiveSent(outbox, ['a.png'], createNullLogger(), () => 12345);

    const remaining = await scanOutbox(outbox, SCAN_OPTIONS);
    expect(remaining.attachments.map((a) => a.fileName)).toEqual(['b.txt']);

    const sentFiles = await readdir(join(outbox, SENT_DIR_NAME));
    expect(sentFiles).toEqual(['12345-a.png']);
  });

  it('空列表不创建 .sent 目录', async () => {
    const outbox = await makeOutbox();
    await archiveSent(outbox, [], createNullLogger());
    const entries = await readdir(outbox);
    expect(entries).toEqual([]);
  });
});

describe('scanOutbox notBeforeMs（只发本轮新产物）', () => {
  it('mtime 早于 notBeforeMs 的文件被跳过，其余照常', async () => {
    const outbox = await makeOutbox();
    const { utimes } = await import('node:fs/promises');
    await writeFile(join(outbox, 'fresh.png'), 'new');
    await writeFile(join(outbox, 'stale.png'), 'old');
    const past = new Date(Date.now() - 3600_000);
    await utimes(join(outbox, 'stale.png'), past, past);

    const result = await scanOutbox(outbox, { ...SCAN_OPTIONS, notBeforeMs: Date.now() - 60_000 });
    expect(result.attachments.map((a) => a.fileName)).toEqual(['fresh.png']);
  });

  it('不传 notBeforeMs 时不过滤（兼容旧行为）', async () => {
    const outbox = await makeOutbox();
    await writeFile(join(outbox, 'a.png'), 'x');
    const result = await scanOutbox(outbox, SCAN_OPTIONS);
    expect(result.attachments).toHaveLength(1);
  });
});
