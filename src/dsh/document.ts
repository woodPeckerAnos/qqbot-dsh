/**
 * 文件正文抽取：PDF 走 `pdftotext` 子进程，纯文本类直接解码。
 *
 * 为什么是外部命令而不是 npm 依赖（pdfjs-dist 之类）：
 *   1. 本项目部署形态**只有 Docker**，apt 装 poppler-utils 约 15MB，而导入一个
 *      纯 JS PDF 解码器会打破"运行时依赖只有 3 个"的基调；
 *   2. 健壮性：pdftotext 对中文、畸形文件、加密 PDF、加密码页的处理都远好于
 *      纯 JS 方案，也不会因为一张巨图把 Node 堆吃光；
 *   3. 代价是**不能只靠它**：抽取器缺失（本地开发没装 poppler）时必须干净降级，
 *      而不是让这一轮失败——见 `PDF_HELPER_MISSING_REASON`。原文已经落在
 *      inbox/，agent 仍可用自己的工具接手。
 *
 * 安全（用户控制的字节喂给外部进程，两条硬约束）：
 *   - **只用固定参数数组 spawn，永不拼 shell 字符串**——文件名与内容都来自用户；
 *   - 超时 kill + stdout 累计上限 kill，防一个畸形/巨大 PDF 把内存与时间吃光。
 *
 * 不做什么：OCR（扫描件没有文本层就直说）、Office 三件套正文（落盘交给 agent）。
 */

import { spawn } from 'node:child_process';

import type { Logger } from '../logger.js';
import { extensionOf } from './files.js';
import type { DocumentExtraction, DocumentExtractor } from './files.js';

/** 抽取器缺失时给模型/用户看的说明（也是降级路径的出口） */
export const PDF_HELPER_MISSING_REASON =
  '本服务未安装 PDF 解析工具（poppler-utils），未能提取正文';

/** 纯文本类扩展名：直接解码，不经过任何解析器 */
const PLAIN_TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'log',
  'xml',
  'html',
  'htm',
  'ini',
  'conf',
  'toml',
  'rst',
  'tex',
]);

export interface DocumentExtractorFactoryOptions {
  /** pdftotext 可执行路径（默认从 PATH 找） */
  pdftotextBin?: string;
  /** 测试注入：替换 spawn */
  spawnImpl?: typeof spawn;
  logger: Logger;
}

/** UTF-8 每字符最多 4 字节：用它把"字符上限"换算成 stdout 的字节上限。 */
const MAX_BYTES_PER_CHAR = 4;

/**
 * 造一个抽取器。
 *
 * 返回的函数据 `DocumentExtractor`（见 dsh/files.ts）：**永不抛错**，
 * 一切失败都变成 `{ reason }`，由调用方降级成一行说明。
 */
export function createDocumentExtractor(
  options: DocumentExtractorFactoryOptions,
): DocumentExtractor {
  const bin = options.pdftotextBin ?? 'pdftotext';
  const logger = options.logger;
  // 首次 ENOENT 之后不再尝试：本地开发（macOS）没装 poppler 是常态，
  // 每个文件都 spawn 一次注定失败的命令既慢又刷日志。
  let helperMissing = false;

  return async (input): Promise<DocumentExtraction> => {
    const ext = extensionOf(input.fileName);
    const isPdf = ext === 'pdf' || input.mimeType === 'application/pdf';

    if (isPdf) {
      if (helperMissing) return { reason: PDF_HELPER_MISSING_REASON };
      const result = await runPdftotext(input, {
        bin,
        ...(options.spawnImpl !== undefined ? { spawnImpl: options.spawnImpl } : {}),
      });
      if (result.missing === true) {
        helperMissing = true;
        logger.warn(`${bin} 不在 PATH 中，PDF 解析将降级为「只落盘」`, {
          hint: '容器镜像已装 poppler-utils；本地开发需要 brew install poppler',
        });
      }
      return result.extraction;
    }

    if (PLAIN_TEXT_EXTENSIONS.has(ext)) return readPlainText(input.data, input.maxChars);

    return { reason: `本服务不解析 .${ext === '' ? '未知' : ext} 格式` };
  };
}

/**
 * 读纯文本文件。
 *
 * 编码策略：先按 UTF-8 严格解码；失败再试 GBK——中文群里的 txt/csv 有相当比例
 * 是 GBK，一律判"非文本"会让用户觉得"发个 txt 都读不了"。两者都失败才放弃。
 * NUL 字节直接判二进制（UTF-8 文本里不该出现 NUL）。
 */
export function readPlainText(data: Uint8Array, maxChars: number): DocumentExtraction {
  if (data.byteLength === 0) return { reason: '文件内容为空' };
  if (data.includes(0)) return { reason: '该文件是二进制内容，未按文本读取' };

  const text = decodeText(data);
  if (text === undefined) return { reason: '该文件不是 UTF-8 / GBK 文本，未按文本读取' };

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized === '') return { reason: '文件内容为空' };
  if (normalized.length > maxChars) {
    return { text: normalized.slice(0, maxChars), truncated: true, totalChars: normalized.length };
  }
  return { text: normalized };
}

/**
 * 按 UTF-16 码元长度截断，但不切出落单的代理对。
 *
 * 说不清"字符"的两种口径（我们按码元、pdftotext 的页数上限按页）不如就地防一手：
 * 切在 emoji / 生僻字中间会产出一个无效的半字符，下游再编码时变成 U+FFFD。
 */
function clipAtCodePoint(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  const last = clipped.charCodeAt(clipped.length - 1);
  // 高代理（0xD800-0xDBFF）结尾 = 后半截被切掉了
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
}

function decodeText(data: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    /* 不是合法 UTF-8，试下一种 */
  }
  try {
    return new TextDecoder('gbk', { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

interface PdftotextOutcome {
  extraction: DocumentExtraction;
  /** 可执行文件不存在（调用方据此只报一次 warn 并停用） */
  missing?: boolean;
}

/**
 * 跑一次 pdftotext：从 stdin 读 PDF、往 stdout 写文本。
 *
 * 用 `- -`（stdin → stdout）而不是临时文件：不需要临时目录、不需要清理，
 * 也不会把用户文件写到工作区之外。参数顺序固定，`-f/-l` 限制页数，
 * `-enc UTF-8` 保证输出编码，`-layout` 保留版式（表格更可读，代价是中文行内
 * 会多出对齐空格——这是刻意的取舍，表格比空格重要）。
 */
export function runPdftotext(
  input: {
    data: Uint8Array;
    maxChars: number;
    maxPdfPages: number;
    timeoutMs: number;
  },
  run: { bin: string; spawnImpl?: typeof spawn },
): Promise<PdftotextOutcome> {
  const spawnImpl = run.spawnImpl ?? spawn;
  const args = [
    '-f',
    '1',
    '-l',
    String(input.maxPdfPages),
    '-layout',
    '-enc',
    'UTF-8',
    '-',
    '-',
  ];
  const maxBytes = input.maxChars * MAX_BYTES_PER_CHAR;

  return new Promise<PdftotextOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(run.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({
        extraction: { reason: `启动 PDF 解析失败：${error instanceof Error ? error.message : String(error)}` },
      });
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (outcome: PdftotextOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    };
    const kill = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
    };

    timer = setTimeout(() => {
      // 先落定再 kill：kill 可能同步触发 close 事件，顺序反了会被 close 抢答
      finish({ extraction: { reason: `解析超时（超过 ${input.timeoutMs}ms）` } });
      kill();
    }, input.timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      // settled：kill 之后子进程仍可能吐最后一两块数据，别再往 chunks 里堆
      if (settled || truncated) return;
      // 只留预算内的字节：一段超长输出不该先把内存吃光再判断超限
      const remaining = maxBytes - bytes;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        bytes = maxBytes;
        // 超过字符上限就停手：剩下的内容既不会用上，也没必要读进内存
        truncated = true;
        kill();
        return;
      }
      // 恰好等于预算不算超限：只有**超过**才截断（否则正好卡在边界上的输出
      // 会被误判成截断，还丢掉 totalChars）
      chunks.push(chunk);
      bytes += chunk.length;
    });
    // stderr 必须消费掉，否则管道写满会把子进程卡死
    child.stderr?.on('data', () => {});
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        finish({ extraction: { reason: PDF_HELPER_MISSING_REASON }, missing: true });
        return;
      }
      finish({ extraction: { reason: `解析失败：${error.message}` } });
    });

    child.on('close', (code: number | null) => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (truncated) {
        const clipped = clipAtCodePoint(text, input.maxChars);
        finish(
          clipped.trim() === ''
            ? { extraction: { reason: '没有从该 PDF 提取到文本' } }
            : { extraction: { text: clipped, truncated: true } },
        );
        return;
      }
      if (code !== 0) {
        finish({ extraction: { reason: `解析失败（pdftotext 退出码 ${code}）` } });
        return;
      }
      const normalized = text.replace(/\r\n/g, '\n').trim();
      if (normalized === '') {
        finish({
          extraction: { reason: '该 PDF 没有可提取的文本层，可能是扫描件' },
        });
        return;
      }
      if (normalized.length > input.maxChars) {
        finish({
          extraction: {
            text: clipAtCodePoint(normalized, input.maxChars),
            truncated: true,
            totalChars: normalized.length,
          },
        });
        return;
      }
      finish({ extraction: { text: normalized } });
    });

    // 子进程提前退出时 stdin 会 EPIPE，属预期，不要让它冒成未处理错误
    child.stdin?.on('error', () => {});
    child.stdin?.end(Buffer.from(input.data));
  });
}
