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
import type { spawn } from 'node:child_process';
import type { Logger } from '../logger.js';
import type { DocumentExtraction, DocumentExtractor } from './files.js';
/** 抽取器缺失时给模型/用户看的说明（也是降级路径的出口） */
export const PDF_HELPER_MISSING_REASON = '本服务未安装 PDF 解析工具（poppler-utils），未能提取正文';
export interface DocumentExtractorFactoryOptions {
  /** pdftotext 可执行路径（默认从 PATH 找） */
  pdftotextBin?: string;
  /** 测试注入：替换 spawn */
  spawnImpl?: typeof spawn;
  logger: Logger;
}
/**
 * 造一个抽取器。
 *
 * 返回的函数据 `DocumentExtractor`（见 dsh/files.ts）：**永不抛错**，
 * 一切失败都变成 `{ reason }`，由调用方降级成一行说明。
 */
export type createDocumentExtractor = (
  options: DocumentExtractorFactoryOptions
) => DocumentExtractor;
/**
 * 读纯文本文件。
 *
 * 编码策略：先按 UTF-8 严格解码；失败再试 GBK——中文群里的 txt/csv 有相当比例
 * 是 GBK，一律判"非文本"会让用户觉得"发个 txt 都读不了"。两者都失败才放弃。
 * NUL 字节直接判二进制（UTF-8 文本里不该出现 NUL）。
 */
export type readPlainText = (data: Uint8Array, maxChars: number) => DocumentExtraction;
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
export type runPdftotext = (
  input: {
    data: Uint8Array;
    maxChars: number;
    maxPdfPages: number;
    timeoutMs: number;
  },
  run: {
    bin: string;
    spawnImpl?: typeof spawn;
  }
) => Promise<PdftotextOutcome>;
export {};
