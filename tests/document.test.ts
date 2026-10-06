/**
 * 文档正文抽取单测（全离线）。
 *
 * pdftotext 用**假子进程**替换 spawn：CI 不保证宿主装了 poppler，也不该在单测里
 * 起真实子进程（与 CI 的"单测不触网、不起 DSH 子进程"约束同源）。真实 pdftotext
 * 的行为走容器内手工验证，列在 RUNBOOK 的待实测项里。
 *
 * 这里要守住的四条硬性质：
 *   1. 任何失败都变成 `{ reason }`，**永不抛错**（否则整个 turn 挂掉）；
 *   2. 抽取器缺失只警告一次，之后不再 spawn；
 *   3. 超时 / 超量都要能真的把子进程杀掉，并给出可读原因；
 *   4. 编码：UTF-8 优先，GBK 兜底，二进制（含 NUL）判非文本。
 */

import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  createDocumentExtractor,
  PDF_HELPER_MISSING_REASON,
  readPlainText,
  runPdftotext,
} from '../src/dsh/document.js';
import { createNullLogger } from '../src/logger.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------
// 假子进程
// ---------------------------------------------------------------------------

interface FakePlan {
  stdout?: string;
  code?: number | null;
  error?: NodeJS.ErrnoException;
  /** 永不 close（测超时与 kill） */
  hang?: boolean;
}

interface FakeSpawn {
  impl: typeof spawn;
  calls: Array<{ bin: string; args: string[]; stdin: () => string; killed: boolean }>;
}

/** 造一个可控的 spawn 替身：能吐 stdout、给退出码、报 ENOENT、或挂住不退出。 */
function makeFakeSpawn(plan: FakePlan): FakeSpawn {
  const calls: FakeSpawn['calls'] = [];
  const impl = ((bin: string, args: readonly string[]) => {
    const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    let input = '';
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        input += chunk.toString('utf8');
        callback();
      },
    });
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const record = { bin, args: [...args], stdin: () => input, killed: false };
    calls.push(record);

    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      kill: () => {
        record.killed = true;
        child.emit('close', null);
        return true;
      },
    });

    process.nextTick(() => {
      if (plan.error !== undefined) {
        child.emit('error', plan.error);
        return;
      }
      if (plan.hang === true) return;
      if (plan.stdout !== undefined) stdout.push(plan.stdout);
      stdout.push(null);
      // 'close' 必须晚于 stdout 数据送达：真实子进程的 'close' 也保证在 stdio
      // 全部读完（'end'）之后才触发，先发 close 会让被测代码读到空输出
      setImmediate(() => child.emit('close', plan.code ?? 0));
    });

    return child;
  }) as unknown as typeof spawn;

  return { impl, calls };
}

const runOptions = { bin: 'pdftotext' };

// ---------------------------------------------------------------------------
// 纯文本读取
// ---------------------------------------------------------------------------

describe('readPlainText', () => {
  it('UTF-8 正文原样读出，统一换行并 trim', () => {
    expect(readPlainText(utf8('第一行\r\n第二行  \n'), 1000)).toEqual({
      text: '第一行\n第二行',
    });
  });

  it('GBK 编码兜底（中文群里 txt/csv 的常见形态）', () => {
    // "中文" 的 GBK 编码
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    expect(readPlainText(gbk, 1000)).toEqual({ text: '中文' });
  });

  it('含 NUL 的一律当二进制，不做文本读取', () => {
    const binary = new Uint8Array([0x41, 0x00, 0x42]);
    expect(readPlainText(binary, 1000).reason).toContain('二进制');
  });

  it('空文件与空白文件都给原因', () => {
    expect(readPlainText(new Uint8Array(), 1000).reason).toContain('空');
    expect(readPlainText(utf8('   \n  '), 1000).reason).toContain('空');
  });

  it('超长截断并给出原文总字数', () => {
    const result = readPlainText(utf8('一二三四五'), 3);
    expect(result.text).toBe('一二三');
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// pdftotext 子进程
// ---------------------------------------------------------------------------

describe('runPdftotext', () => {
  it('参数固定不可拼串，从 stdin 读、往 stdout 写', async () => {
    const fake = makeFakeSpawn({ stdout: '正文内容' });
    const outcome = await runPdftotext(
      { data: utf8('%PDF-1.4'), maxChars: 100, maxPdfPages: 7, timeoutMs: 1_000 },
      { ...runOptions, spawnImpl: fake.impl },
    );
    expect(outcome.extraction).toEqual({ text: '正文内容' });
    expect(fake.calls[0]!.bin).toBe('pdftotext');
    expect(fake.calls[0]!.args).toEqual([
      '-f',
      '1',
      '-l',
      '7',
      '-layout',
      '-enc',
      'UTF-8',
      '-',
      '-',
    ]);
    expect(fake.calls[0]!.stdin()).toContain('%PDF-1.4');
  });

  it('没有文本层时给出可读原因（不抛错）', async () => {
    const fake = makeFakeSpawn({ stdout: '   \n' });
    const outcome = await runPdftotext(
      { data: utf8('x'), maxChars: 100, maxPdfPages: 5, timeoutMs: 1_000 },
      { ...runOptions, spawnImpl: fake.impl },
    );
    expect(outcome.extraction.reason).toContain('扫描件');
  });

  it('非零退出码变成原因', async () => {
    const fake = makeFakeSpawn({ code: 1 });
    const outcome = await runPdftotext(
      { data: utf8('x'), maxChars: 100, maxPdfPages: 5, timeoutMs: 1_000 },
      { ...runOptions, spawnImpl: fake.impl },
    );
    expect(outcome.extraction.reason).toContain('退出码 1');
  });

  it('ENOENT 标记 missing（调用方据此停用并只警告一次）', async () => {
    const error = Object.assign(new Error('spawn pdftotext ENOENT'), { code: 'ENOENT' });
    const fake = makeFakeSpawn({ error });
    const outcome = await runPdftotext(
      { data: utf8('x'), maxChars: 100, maxPdfPages: 5, timeoutMs: 1_000 },
      { ...runOptions, spawnImpl: fake.impl },
    );
    expect(outcome.missing).toBe(true);
    expect(outcome.extraction.reason).toBe(PDF_HELPER_MISSING_REASON);
  });

  it('超时会杀掉子进程并给出原因', async () => {
    const fake = makeFakeSpawn({ hang: true });
    const outcome = await runPdftotext(
      { data: utf8('x'), maxChars: 100, maxPdfPages: 5, timeoutMs: 30 },
      { ...runOptions, spawnImpl: fake.impl },
    );
    expect(outcome.extraction.reason).toContain('解析超时');
    expect(fake.calls[0]!.killed).toBe(true);
  });

  it('输出超过字符上限时截断并杀掉子进程', async () => {
    const fake = makeFakeSpawn({ stdout: 'x'.repeat(10_000) });
    const outcome = await runPdftotext(
      { data: utf8('x'), maxChars: 10, maxPdfPages: 5, timeoutMs: 1_000 },
      { ...runOptions, spawnImpl: fake.impl },
    );
    expect(outcome.extraction.truncated).toBe(true);
    expect(outcome.extraction.text!.length).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// 抽取器工厂：分派与降级
// ---------------------------------------------------------------------------

describe('createDocumentExtractor', () => {
  it('PDF 走 pdftotext；纯文本类不经子进程', async () => {
    const fake = makeFakeSpawn({ stdout: 'PDF 正文' });
    const extract = createDocumentExtractor({
      spawnImpl: fake.impl,
      logger: createNullLogger(),
    });

    const pdf = await extract({
      data: utf8('%PDF'),
      fileName: 'a.pdf',
      maxChars: 100,
      maxPdfPages: 5,
      timeoutMs: 1_000,
    });
    expect(pdf.text).toBe('PDF 正文');

    const txt = await extract({
      data: utf8('纯文本正文'),
      fileName: 'b.txt',
      maxChars: 100,
      maxPdfPages: 5,
      timeoutMs: 1_000,
    });
    expect(txt.text).toBe('纯文本正文');
    expect(fake.calls).toHaveLength(1);
  });

  it('按 MIME 识别 PDF（扩展名缺失时）', async () => {
    const fake = makeFakeSpawn({ stdout: 'PDF 正文' });
    const extract = createDocumentExtractor({
      spawnImpl: fake.impl,
      logger: createNullLogger(),
    });
    const result = await extract({
      data: utf8('%PDF'),
      fileName: 'file',
      mimeType: 'application/pdf',
      maxChars: 100,
      maxPdfPages: 5,
      timeoutMs: 1_000,
    });
    expect(result.text).toBe('PDF 正文');
    expect(fake.calls).toHaveLength(1);
  });

  it('未支持的扩展名直接给原因，不 spawn', async () => {
    const fake = makeFakeSpawn({ stdout: 'x' });
    const extract = createDocumentExtractor({
      spawnImpl: fake.impl,
      logger: createNullLogger(),
    });
    const result = await extract({
      data: utf8('PK'),
      fileName: 'a.docx',
      maxChars: 100,
      maxPdfPages: 5,
      timeoutMs: 1_000,
    });
    expect(result.reason).toContain('.docx');
    expect(fake.calls).toHaveLength(0);
  });

  it('抽取器缺失后不再重复 spawn（本地开发是常态）', async () => {
    const error = Object.assign(new Error('spawn pdftotext ENOENT'), { code: 'ENOENT' });
    const fake = makeFakeSpawn({ error });
    const extract = createDocumentExtractor({
      spawnImpl: fake.impl,
      logger: createNullLogger(),
    });
    const input = {
      data: utf8('%PDF'),
      fileName: 'a.pdf',
      maxChars: 100,
      maxPdfPages: 5,
      timeoutMs: 1_000,
    };
    expect((await extract(input)).reason).toBe(PDF_HELPER_MISSING_REASON);
    expect((await extract(input)).reason).toBe(PDF_HELPER_MISSING_REASON);
    expect(fake.calls).toHaveLength(1);
  });
});
