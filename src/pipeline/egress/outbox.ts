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

import { mkdir, readdir, realpath, rename, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

import type { OutgoingAttachment } from '../../core/connector.js';
import type { Logger } from '../../logger.js';

/** 已发送文件的归档子目录名（隐藏目录，扫描时天然被跳过）。 */
export const SENT_DIR_NAME = '.sent';

export interface OutboxScanOptions {
  /** 单附件体积上限（字节），超出的进 oversize 名单 */
  maxFileBytes: number;
  /** 图片扩展名白名单（小写、不带点）；不在名单里的一律按 file 发 */
  imageExtensions: readonly string[];
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
export async function scanOutbox(dir: string, options: OutboxScanOptions): Promise<OutboxScanResult> {
  const result: OutboxScanResult = { attachments: [], oversize: [], skipped: [] };

  let realDir: string;
  try {
    realDir = await realpath(dir);
  } catch {
    return result; // 目录不存在 = 没有产物
  }

  let entries;
  try {
    entries = await readdir(realDir, { withFileTypes: true });
  } catch (error) {
    options.logger.warn('读取 outbox 目录失败', {
      dir,
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }

  // 按文件名排序：发送顺序确定，测试与排障都可预期
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue; // 隐藏文件与 .sent 归档目录
    if (entry.isDirectory()) {
      // 目录不支持发送（平台没有"文件夹消息"），跳过不噪音
      result.skipped.push(entry.name);
      continue;
    }

    try {
      const absPath = join(realDir, entry.name);
      const realFile = await realpath(absPath);
      // 包含性校验：符号链接的最终落点必须还在 outbox 内
      if (realFile !== absPath && !realFile.startsWith(realDir + sep)) {
        options.logger.warn('outbox 文件符号链接逃逸，已跳过', { name: entry.name, realFile });
        result.skipped.push(entry.name);
        continue;
      }
      const info = await stat(realFile);
      if (!info.isFile()) {
        result.skipped.push(entry.name);
        continue;
      }
      if (info.size > options.maxFileBytes) {
        result.oversize.push(entry.name);
        continue;
      }
      const ext = entry.name.includes('.')
        ? (entry.name.split('.').pop()?.toLowerCase() ?? '')
        : '';
      result.attachments.push({
        kind: options.imageExtensions.includes(ext) ? 'image' : 'file',
        absPath: realFile,
        fileName: entry.name,
        sizeBytes: info.size,
      });
    } catch (error) {
      options.logger.warn('检查 outbox 文件失败，已跳过', {
        name: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
      result.skipped.push(entry.name);
    }
  }

  return result;
}

/**
 * 把成功发送的文件归档到 `outbox/.sent/`（带时间戳前缀防重名）。
 *
 * 发送失败的文件**留在原地**、不自动重发：自动重发需要跨 turn 的账本，
 * 复杂度不值——用户追问一句"把文件发我"即可（见 docs/RICH-MEDIA-PLAN.md §3）。
 *
 * 归档失败（如磁盘满）只记日志，不影响主流程。
 */
export async function archiveSent(
  dir: string,
  fileNames: readonly string[],
  logger: Logger,
  now: () => number = Date.now,
): Promise<void> {
  if (fileNames.length === 0) return;
  const sentDir = join(dir, SENT_DIR_NAME);
  try {
    await mkdir(sentDir, { recursive: true });
    for (const name of fileNames) {
      await rename(join(dir, name), join(sentDir, `${now()}-${name}`));
    }
  } catch (error) {
    logger.warn('归档已发送文件失败（文件仍在 outbox，下轮可能被重扫）', {
      dir,
      fileNames,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
