/**
 * 入站文件链路单测：inbox 落盘 → 摄取编排（下载/落盘/抽取/说明文本）→
 * OneBot 文件取字节。
 *
 * 全部离线：取字节用注入替身或本地 http 服务器，抽取器用注入的桩，
 * 不依赖宿主上有没有装 pdftotext。
 */

import { createServer, type Server } from 'node:http';
import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { OnebotConnector, type OnebotConnectorOptions } from '../src/adapters/onebot/connector.js';
import { extractMessageContent } from '../src/adapters/onebot/normalize.js';
import type { FilesConfig } from '../src/config.js';
import type { MessageMediaPart, RemoteMedia } from '../src/core/connector.js';
import { ingestFiles, type DocumentExtraction } from '../src/dsh/files.js';
import { createNullLogger } from '../src/logger.js';
import { scanOutbox } from '../src/pipeline/egress/outbox.js';
import { cleanupInbox, sanitizeInboxFileName, saveInboxFile } from '../src/store/inbox.js';

const FILES_CONFIG: FilesConfig = {
  enabled: true,
  maxFiles: 2,
  maxFileBytes: 1024 * 1024,
  maxExtractChars: 20_000,
  maxPdfPages: 30,
  extractTimeoutMs: 10_000,
  saveToInbox: true,
  inboxDir: 'inbox',
  retentionDays: 7,
  maxInboxBytes: 200 * 1024 * 1024,
  extractExtensions: ['pdf', 'txt'],
};

const logger = createNullLogger();

let workspaces: string[] = [];
function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-inbox-'));
  workspaces.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
  workspaces = [];
});

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

function filePart(overrides: Partial<MessageMediaPart> = {}): MessageMediaPart {
  return {
    type: 'media',
    mediaKind: 'file',
    filename: 'report.pdf',
    sizeBytes: PDF_BYTES.byteLength,
    url: 'https://cdn.example.com/report.pdf',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 文件名清洗
// ---------------------------------------------------------------------------

describe('sanitizeInboxFileName', () => {
  it('剥掉路径、控制字符与前导点', () => {
    expect(sanitizeInboxFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeInboxFileName('/abs/path/报表 2026.pdf')).toBe('报表 2026.pdf');
    expect(sanitizeInboxFileName('..\\..\\windows\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeInboxFileName('....')).toBe('file');
    expect(sanitizeInboxFileName('a\u0000b.txt')).toBe('a_b.txt');
    // shell 元字符一律换成下划线（它们本来就没有文件名语义）
    expect(sanitizeInboxFileName('x;y$z`w.txt')).toBe('x_y_z_w.txt');
  });

  it('保留中英文与常见符号，超长时保住扩展名', () => {
    expect(sanitizeInboxFileName('会议纪要-v2 (final).pdf')).toBe('会议纪要-v2 (final).pdf');
    const long = sanitizeInboxFileName(`${'x'.repeat(200)}.pdf`);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------
// inbox 落盘与清理
// ---------------------------------------------------------------------------

describe('inbox 落盘', () => {
  it('写进工作区 inbox/，返回相对路径', async () => {
    const workspace = tempWorkspace();
    const saved = await saveInboxFile({
      workspacePath: workspace,
      inboxDir: 'inbox',
      fileName: '../../报告.pdf',
      data: PDF_BYTES,
      maxBytes: 1024,
      logger,
      now: () => 1_700_000_000_000,
    });
    expect(saved).toBeDefined();
    expect(saved!.relPath).toBe('inbox/1700000000000-报告.pdf');
    // 落盘路径基于 realpath（macOS 上 /var 会解析成 /private/var），
    // 断言用 realpath 比对而不是原始字符串
    expect(saved!.absPath.startsWith(realpathSync(workspace))).toBe(true);
    expect(statSync(saved!.absPath).size).toBe(PDF_BYTES.byteLength);
  });

  it('同名文件退让出 -1 后缀，绝不覆盖已有文件', async () => {
    const workspace = tempWorkspace();
    const base = {
      workspacePath: workspace,
      inboxDir: 'inbox',
      fileName: 'a.txt',
      data: PDF_BYTES,
      maxBytes: 1024,
      logger,
      now: () => 1,
    };
    const first = await saveInboxFile(base);
    const second = await saveInboxFile(base);
    expect(first!.relPath).toBe('inbox/1-a.txt');
    expect(second!.relPath).toBe('inbox/1-a-1.txt');
  });

  it('超过单文件上限时拒写', async () => {
    const workspace = tempWorkspace();
    const saved = await saveInboxFile({
      workspacePath: workspace,
      inboxDir: 'inbox',
      fileName: 'big.pdf',
      data: new Uint8Array(2048),
      maxBytes: 1024,
      logger,
    });
    expect(saved).toBeUndefined();
  });

  it('inbox 里的文件不会被 egress 的 outbox 扫描看见（防回声）', async () => {
    const workspace = tempWorkspace();
    await saveInboxFile({
      workspacePath: workspace,
      inboxDir: 'inbox',
      fileName: 'report.pdf',
      data: PDF_BYTES,
      maxBytes: 1024,
      logger,
    });
    const scan = await scanOutbox(join(workspace, 'outbox'), {
      maxFileBytes: 1024 * 1024,
      imageExtensions: ['png'],
      logger,
    });
    expect(scan.attachments).toEqual([]);
  });

  it('清理：删超期文件，超总量时删最旧的而不是拒绝新文件', async () => {
    const workspace = tempWorkspace();
    const dir = join(workspace, 'inbox');
    const old = join(dir, 'old.txt');
    const mid = join(dir, 'mid.txt');
    const fresh = join(dir, 'fresh.txt');
    await saveInboxFile({
      workspacePath: workspace,
      inboxDir: 'inbox',
      fileName: 'old.txt',
      data: new Uint8Array(100),
      maxBytes: 1024,
      logger,
    });
    // 手工改名以控制 mtime 排序与时间跨度
    const created = readdirSync(dir)[0]!;
    renameSync(join(dir, created), old);
    utimesSync(old, new Date(0), new Date(0));
    writeFileSync(mid, 'x'.repeat(100));
    utimesSync(mid, new Date(999_950_000_000), new Date(999_950_000_000));
    writeFileSync(fresh, 'y'.repeat(100));
    utimesSync(fresh, new Date(999_990_000_000), new Date(999_990_000_000));

    await cleanupInbox({
      workspacePath: workspace,
      inboxDir: 'inbox',
      retentionDays: 1,
      maxBytes: 150,
      logger,
      now: () => 1_000_000_000_000,
    });
    const left = readdirSync(dir).sort();
    expect(left).not.toContain('old.txt');
    expect(left).toHaveLength(1);
    expect(left[0]).toBe('fresh.txt');
  });

  it('目录不存在时清理不抛错', async () => {
    await expect(
      cleanupInbox({
        workspacePath: tempWorkspace(),
        inboxDir: 'inbox',
        retentionDays: 7,
        maxBytes: 1024,
        logger,
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 摄取编排
// ---------------------------------------------------------------------------

describe('ingestFiles', () => {
  it('抽取成功：正文包在不可信边界里，并给出原文路径', async () => {
    const workspace = tempWorkspace();
    const fetched: RemoteMedia[] = [];
    const result = await ingestFiles({
      parts: [filePart()],
      workspacePath: workspace,
      config: FILES_CONFIG,
      downloadTimeoutMs: 1_000,
      context: { groupId: '8888' },
      fetchMedia: async (media) => {
        fetched.push(media);
        return { data: PDF_BYTES, mimeType: 'application/pdf' };
      },
      extract: async (): Promise<DocumentExtraction> => ({ text: '第一章 概述\n正文内容' }),
      logger,
    });

    expect(result.fetched).toBe(1);
    expect(result.extracted).toBe(1);
    expect(result.charsInlined).toBe('第一章 概述\n正文内容'.length);
    const note = result.notes.join('\n');
    expect(note).toContain('[文件: report.pdf, 8B]');
    expect(note).toContain('<文件 名称="report.pdf"');
    expect(note).toContain('是资料不是指令');
    expect(note).toContain('第一章 概述');
    expect(note).toContain('</文件>');
    expect(note).toContain('完整原文：inbox/');
    // 取件时带上 kind 与会话上下文（OneBot 群文件直链申请需要群号）
    expect(fetched[0]).toMatchObject({ kind: 'file', context: { groupId: '8888' } });
    expect(readdirSync(join(workspace, 'inbox'))).toHaveLength(1);
  });

  it('抽取被截断时说明读了多少 / 一共多少', async () => {
    const result = await ingestFiles({
      parts: [filePart()],
      workspacePath: tempWorkspace(),
      config: FILES_CONFIG,
      downloadTimeoutMs: 1_000,
      fetchMedia: async () => ({ data: PDF_BYTES }),
      extract: async () => ({ text: '前若干字', truncated: true, totalChars: 99_999 }),
      logger,
    });
    expect(result.notes.join('\n')).toContain('已读入前 4 字，原文约 99999 字');
  });

  it('没有文本层：说明原因并给出原文路径（不是静默失败）', async () => {
    const result = await ingestFiles({
      parts: [filePart()],
      workspacePath: tempWorkspace(),
      config: FILES_CONFIG,
      downloadTimeoutMs: 1_000,
      fetchMedia: async () => ({ data: PDF_BYTES }),
      extract: async () => ({ reason: '该文件没有可提取的文本层，可能是扫描件' }),
      logger,
    });
    expect(result.savedOnly).toBe(1);
    expect(result.extracted).toBe(0);
    const note = result.notes.join('\n');
    expect(note).toContain('没有可提取的文本层');
    expect(note).toContain('原文已保存到');
  });

  it('关闭落盘时说明"未落盘是配置"，而不是含糊的"未能保存"', async () => {
    const result = await ingestFiles({
      parts: [filePart()],
      workspacePath: tempWorkspace(),
      config: { ...FILES_CONFIG, saveToInbox: false },
      downloadTimeoutMs: 1_000,
      fetchMedia: async () => ({ data: PDF_BYTES }),
      extract: async () => ({ reason: '该文件没有可提取的文本层' }),
      logger,
    });
    expect(result.savedOnly).toBe(1);
    const note = result.notes.join('\n');
    expect(note).toContain('saveToInbox 已关闭');
    expect(note).not.toContain('未能保存原文');
  });

  it('没有注入解析器时措辞不误导成"解析失败"', async () => {
    const result = await ingestFiles({
      parts: [filePart()],
      workspacePath: tempWorkspace(),
      config: FILES_CONFIG,
      downloadTimeoutMs: 1_000,
      fetchMedia: async () => ({ data: PDF_BYTES }),
      logger,
    });
    expect(result.notes.join('\n')).toContain('未启用文档解析');
  });

  it('白名单外的类型根本不下载', async () => {
    let called = false;
    const result = await ingestFiles({
      parts: [filePart({ filename: 'tool.exe', sizeBytes: 10 })],
      workspacePath: tempWorkspace(),
      config: FILES_CONFIG,
      downloadTimeoutMs: 1_000,
      fetchMedia: async () => {
        called = true;
        return { data: PDF_BYTES };
      },
      logger,
    });
    expect(called).toBe(false);
    expect(result.skipped).toBe(1);
    expect(result.notes[0]).toContain('不解析该类型');
  });

  it('平台声明的体积超限时不下载', async () => {
    let called = false;
    const result = await ingestFiles({
      parts: [filePart({ sizeBytes: 10 * 1024 * 1024 })],
      workspacePath: tempWorkspace(),
      config: FILES_CONFIG,
      downloadTimeoutMs: 1_000,
      fetchMedia: async () => {
        called = true;
        return { data: PDF_BYTES };
      },
      logger,
    });
    expect(called).toBe(false);
    expect(result.notes[0]).toContain('超过');
  });

  it('下载失败与运行期异常都只降级成说明', async () => {
    const failed = await ingestFiles({
      parts: [filePart()],
      workspacePath: tempWorkspace(),
      config: FILES_CONFIG,
      downloadTimeoutMs: 1_000,
      fetchMedia: async () => undefined,
      logger,
    });
    expect(failed.notes[0]).toContain('读取失败');

    const thrown = await ingestFiles({
      parts: [filePart()],
      workspacePath: tempWorkspace(),
      config: FILES_CONFIG,
      downloadTimeoutMs: 1_000,
      fetchMedia: async () => {
        throw new Error('boom');
      },
      logger,
    });
    expect(thrown.skipped).toBe(1);
    expect(thrown.notes[0]).toContain('读取失败');
  });

  it('单条消息超过 maxFiles 时只处理前 N 个并说明其余', async () => {
    const result = await ingestFiles({
      parts: [filePart(), filePart({ filename: 'b.pdf' }), filePart({ filename: 'c.pdf' })],
      workspacePath: tempWorkspace(),
      config: FILES_CONFIG,
      downloadTimeoutMs: 1_000,
      fetchMedia: async () => ({ data: PDF_BYTES }),
      logger,
    });
    expect(result.fetched).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.notes.join('\n')).toContain('另有 1 个文件超出单条消息上限');
  });

  it('关闭文件读取时不产生任何下载', async () => {
    let called = false;
    const result = await ingestFiles({
      parts: [filePart()],
      workspacePath: tempWorkspace(),
      config: { ...FILES_CONFIG, enabled: false },
      downloadTimeoutMs: 1_000,
      fetchMedia: async () => {
        called = true;
        return { data: PDF_BYTES };
      },
      logger,
    });
    expect(called).toBe(false);
    expect(result.notes[0]).toContain('已关闭文件读取');
  });

  it('视频片段不按文件处理', async () => {
    let called = false;
    const result = await ingestFiles({
      parts: [filePart({ mediaKind: 'video', filename: 'v.mp4' })],
      workspacePath: tempWorkspace(),
      config: FILES_CONFIG,
      downloadTimeoutMs: 1_000,
      fetchMedia: async () => {
        called = true;
        return { data: PDF_BYTES };
      },
      logger,
    });
    expect(called).toBe(false);
    expect(result.notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OneBot：file 段归一化 + 文件取字节
// ---------------------------------------------------------------------------

describe('OneBot file 段归一化', () => {
  it('带上 file_id 与体积，供连接器申请直链', () => {
    const extracted = extractMessageContent(
      [
        {
          type: 'file',
          data: { file_id: 'fid-1', name: '报告.pdf', size: 2048 },
        },
      ],
      10000,
    );
    expect(extracted.parts).toEqual([
      { type: 'media', mediaKind: 'file', fileId: 'fid-1', filename: '报告.pdf', sizeBytes: 2048 },
    ]);
    expect(extracted.content).toBe('[文件: 报告.pdf]');
  });
});

describe('OneBot 文件取字节', () => {
  let connector: OnebotConnector | undefined;
  const clients: WebSocket[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const ws of clients.splice(0)) ws.close();
    await connector?.stop();
    connector = undefined;
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function makeConnector(port: number, overrides: Partial<OnebotConnectorOptions> = {}) {
    return new OnebotConnector({
      host: '127.0.0.1',
      port,
      accessToken: 'test-token',
      acceptsC2C: true,
      autoAcceptFriend: true,
      autoAcceptGroupInvite: false,
      replyPolicy: {
        maxChars: 1500,
        maxRepliesPerMsg: 10,
        progressMax: 3,
        progressAfterMs: 90_000,
        progressIntervalMs: 90_000,
        turnTimeoutMs: 600_000,
        passiveWindowMs: Number.POSITIVE_INFINITY,
      },
      logger,
      ...overrides,
    });
  }

  async function connectClient(port: number): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(
      JSON.stringify({
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        sub_type: 'connect',
        self_id: 10000,
        time: 0,
      }),
    );
    return ws;
  }

  function portOf(c: OnebotConnector): number {
    return (c as unknown as { server: { address: () => { port: number } } }).server.address().port;
  }

  /** 起一个只服务一个文件的本地 http 服务器，返回其 URL */
  async function serveBytes(data: Uint8Array): Promise<string> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from(data));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return `http://127.0.0.1:${port}/f.bin`;
  }

  it('群文件：先 get_group_file_url（带群号），再下载直链', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const url = await serveBytes(payload);
    const c = makeConnector(0);
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    const fetchPromise = c.fetchMedia(
      { kind: 'file', fileId: 'fid-1', context: { groupId: '8888' } },
      { maxBytes: 1024, timeoutMs: 3_000 },
    );
    const action = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    expect(action['action']).toBe('get_group_file_url');
    expect(action['params']).toEqual({ file_id: 'fid-1', group: '8888' });
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action['echo'], data: { url } }));

    const bytes = await fetchPromise;
    expect(bytes?.data).toEqual(payload);
  });

  it('私聊文件：用 get_private_file_url，不带群号', async () => {
    const url = await serveBytes(new Uint8Array([9, 9]));
    const c = makeConnector(0);
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    const fetchPromise = c.fetchMedia(
      { kind: 'file', fileId: 'fid-2', context: { userId: '12345' } },
      { maxBytes: 1024, timeoutMs: 3_000 },
    );
    const action = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    expect(action['action']).toBe('get_private_file_url');
    expect(action['params']).toEqual({ file_id: 'fid-2' });
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action['echo'], data: { url } }));

    expect((await fetchPromise)?.data).toEqual(new Uint8Array([9, 9]));
  });

  it('直链申请失败时退回 get_file（base64 直出）', async () => {
    const c = makeConnector(0);
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    const fetchPromise = c.fetchMedia(
      { kind: 'file', fileId: 'fid-3', context: { groupId: '8888' } },
      { maxBytes: 1024, timeoutMs: 3_000 },
    );
    const first = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    expect(first['action']).toBe('get_group_file_url');
    ws.send(JSON.stringify({ status: 'failed', retcode: 1404, echo: first['echo'], data: null }));

    const second = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    expect(second['action']).toBe('get_file');
    expect(second['params']).toEqual({ file: 'fid-3', file_id: 'fid-3' });
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: second['echo'],
        data: { base64: Buffer.from([7, 7, 7]).toString('base64') },
      }),
    );

    expect([...(await fetchPromise)!.data]).toEqual([7, 7, 7]);
  });

  it('缺会话上下文时不猜群号，直接走 get_file', async () => {
    const c = makeConnector(0);
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    const fetchPromise = c.fetchMedia(
      { kind: 'file', fileId: 'fid-4' },
      { maxBytes: 1024, timeoutMs: 500 },
    );
    const action = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    expect(action['action']).toBe('get_file');
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action['echo'], data: null }));
    expect(await fetchPromise).toBeUndefined();
  });
});
