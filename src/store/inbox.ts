/**
 * inbox：把用户发来的文件落到会话工作区，供 agent 用自己已有的工具继续深挖。
 *
 * 为什么必须有这一层（而不是只把抽取出的文本塞进 prompt）：
 *   抽取是有损且有限的——截断、扫描件没有文本层、表格版式丢失。原文落到工作区，
 *   agent 就能读文件、写脚本、分页处理接着做；prompt 里的抽取文本只是
 *   "确定性基线"。两条路共用同一次下载，边际成本只是一次写盘。
 *
 * 与 outbox 的关系：**语义相反、必须分开**。outbox 是"要发回用户的产物"，
 * egress 会扫描即发；把用户发来的文件写进 outbox 会立刻回声给用户。
 * 配置层（config.ts）已经禁止两者同名，那是第一道闸，这里是第二道。
 *
 * 安全不变量（本模块负责）：
 *   - 文件名来自用户 → 一律 sanitize（去分隔符 / 控制字符 / 前导点，限长），
 *     再以 `<时间戳>-` 前缀保证唯一；写入用 `wx` 标志，**绝不覆盖**已有文件；
 *   - 写前做 realpath 包含性校验（与 outbox 同款），挡住符号链接把戏；
 *   - 单文件体积由调用方按 maxFileBytes 预筛，本层再按实际字节数复核一次；
 *   - 清理与配额一律 best-effort：失败只记 warn，绝不影响本轮回答。
 */

import { mkdir, open, readdir, realpath, stat, unlink } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';

import type { Logger } from '../logger.js';

/** 兜底文件名（sanitize 后什么都不剩时用） */
const FALLBACK_NAME = 'file';
/** 文件名长度上限（保留扩展名），防超长名字撞上文件系统上限 */
const MAX_NAME_LENGTH = 80;
/** 同名冲突时的再试次数 */
const SAVE_ATTEMPTS = 3;

/**
 * 把平台给的文件名洗成"只能落在 inbox 里的一个普通文件名"。
 *
 * 纯函数、可单测。规则刻意偏保守：宁可把不认识的字换成下划线，也不放行任何
 * 可能有特殊含义的字符。中英文、数字与 `._-() ` 之外的字符都会被替换。
 */
export function sanitizeInboxFileName(raw: string): string {
  // 先只取最后一段：文件名可能来自 Windows 或 POSIX，两种分隔符都要按分隔符处理
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // 控制字符与 NUL：不仅难看，还可能被当作字符串终止符
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[^\p{L}\p{N}._\-() ]/gu, '_')
    // 前导点：隐藏文件、`.` 与 `..` 都在这一步被消掉
    .replace(/^\.+/, '')
    .trim();
  const name = cleaned === '' ? FALLBACK_NAME : cleaned;
  if (name.length <= MAX_NAME_LENGTH) return name;
  // 超长时保住扩展名——用户与模型都靠它判断类型
  const ext = extname(name);
  if (ext.length >= MAX_NAME_LENGTH) return name.slice(0, MAX_NAME_LENGTH);
  return `${name.slice(0, MAX_NAME_LENGTH - ext.length)}${ext}`;
}

export interface SaveInboxFileOptions {
  /** 该会话的工作区绝对路径 */
  workspacePath: string;
  /** 工作区内的 inbox 目录名（配置层已保证是纯目录名） */
  inboxDir: string;
  /** 平台给的文件名（会被 sanitize） */
  fileName: string;
  data: Uint8Array;
  /** 单文件字节上限（本层复核一次） */
  maxBytes: number;
  logger: Logger;
  now?: () => number;
}

export interface SavedInboxFile {
  /** 落盘绝对路径 */
  absPath: string;
  /** 相对工作区的展示路径（`inbox/1767-report.pdf`），写进 prompt 用 */
  relPath: string;
  /** 实际落盘的文件名（含时间戳前缀） */
  fileName: string;
  sizeBytes: number;
}

/**
 * 落一个文件到 inbox。失败一律返回 undefined（调用方降级成文字说明）。
 *
 * 时间戳前缀有两个作用：目录内按名字排序即按时间排序；同一秒内同名文件靠
 * `-N` 后缀与 `wx` 标志退让。
 */
export async function saveInboxFile(
  options: SaveInboxFileOptions,
): Promise<SavedInboxFile | undefined> {
  const { workspacePath, inboxDir, data, maxBytes, logger } = options;
  const now = options.now ?? Date.now;

  if (data.byteLength === 0) return undefined;
  if (data.byteLength > maxBytes) {
    logger.warn('inbox 落盘被拒：文件超过单文件上限', {
      sizeBytes: data.byteLength,
      maxBytes,
    });
    return undefined;
  }

  const dir = join(workspacePath, inboxDir);
  try {
    await mkdir(dir, { recursive: true });
    // 包含性校验：inboxDir 已在配置层被限制为纯目录名，这里再挡一次符号链接
    // （攻击面是"工作区里预先存在一个指向外部的 inbox 符号链接"）
    const realDir = await realpath(dir);
    const realRoot = await realpath(workspacePath);
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
      logger.warn('inbox 目录不在会话工作区内，已拒绝落盘', { dir, realDir, realRoot });
      return undefined;
    }

    const safeName = sanitizeInboxFileName(options.fileName);
    const ext = extname(safeName);
    const stem = ext === '' ? safeName : safeName.slice(0, -ext.length);

    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
      const name = attempt === 0 ? safeName : `${stem}-${attempt}${ext}`;
      const fileName = `${now()}-${name}`;
      const absPath = join(realDir, fileName);
      try {
        // wx：已存在就失败。绝不覆盖——覆盖等于用别人的文件内容顶掉已有产物。
        const handle = await open(absPath, 'wx');
        try {
          await handle.write(data);
        } finally {
          await handle.close();
        }
        return {
          absPath,
          relPath: `${inboxDir}/${fileName}`,
          fileName,
          sizeBytes: data.byteLength,
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') continue;
        throw error;
      }
    }
    logger.warn('inbox 落盘失败：同名文件过多', { fileName: options.fileName });
    return undefined;
  } catch (error) {
    logger.warn('inbox 落盘失败（该文件按未保存处理）', {
      fileName: options.fileName,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export interface InboxCleanupOptions {
  workspacePath: string;
  inboxDir: string;
  /** 保留天数（0 = 只按总量配额清理，不按时间） */
  retentionDays: number;
  /** 目录总字节上限；超出时**删最旧的**而不是拒绝新文件 */
  maxBytes: number;
  logger: Logger;
  now?: () => number;
}

/**
 * inbox 清理：先删超期文件，再删最旧的直到总量回到上限内。
 *
 * 为什么是"删最旧"而不是"拒绝新文件"：用户刚发来的文件价值最高，
 * 旧文件的价值随时间衰减；拒绝新文件会让"刚发的 PDF 读不了"变成常态故障。
 *
 * 全程 best-effort：任何一步失败只记 warn。清理失败不该影响用户这一轮的回答。
 */
export async function cleanupInbox(options: InboxCleanupOptions): Promise<void> {
  const { workspacePath, inboxDir, retentionDays, maxBytes, logger } = options;
  const now = options.now ?? Date.now;
  const dir = join(workspacePath, inboxDir);

  let entries: Array<{ name: string; size: number; mtimeMs: number }>;
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    entries = [];
    for (const dirent of dirents) {
      if (!dirent.isFile() || dirent.name.startsWith('.')) continue;
      try {
        const info = await stat(join(dir, dirent.name));
        entries.push({ name: dirent.name, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        /* 单个文件 stat 失败不影响整体清理 */
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn('读取 inbox 目录失败，跳过清理', {
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  // 最旧的排前面：时间清理与容量清理共用同一个顺序
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const doomed = new Set<string>();
  if (retentionDays > 0) {
    const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (entry.mtimeMs < cutoff) doomed.add(entry.name);
    }
  }
  let total = entries.reduce((sum, entry) => sum + (doomed.has(entry.name) ? 0 : entry.size), 0);
  for (const entry of entries) {
    if (total <= maxBytes) break;
    if (doomed.has(entry.name)) continue;
    doomed.add(entry.name);
    total -= entry.size;
  }

  let removed = 0;
  for (const name of doomed) {
    try {
      await unlink(join(dir, name));
      removed += 1;
    } catch {
      /* 已被别处删掉 / 权限问题：忽略 */
    }
  }
  if (removed > 0) {
    logger.debug('inbox 已清理', { dir, removed, retentionDays, maxBytes });
  }
}
