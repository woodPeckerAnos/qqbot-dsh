import { describe, expect, it, vi } from 'vitest';
import type { MediaBytes, MediaFetchResult, MediaResultFetcher, Result } from '@qqbot/contracts';
import { createNullLogger } from '../../src/observability/index.js';
import { fetchMediaResult } from '../../src/media/fetch-result.js';
import { buildImageBlocks } from '../../src/media/index.js';
import { ingestFiles } from '../../src/media/index.js';
import { ManualClock } from '../helpers/task-mocks.js';

const limits = { maxBytes: 8, timeoutMs: 100 };
const remote = { url: 'https://example.invalid/media' };

describe('媒体有类型读取接缝（全部使用注入来源）', () => {
  it('兼容 Result<MediaBytes>，GET 输出与输入字节均隔离', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const result: Result<MediaBytes> = await fetchMediaResult(remote, limits, {
      fetchImpl: async () => new Response(data, { headers: { 'content-type': 'image/png; q=1' } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected successful read');
    expect([...result.value.data]).toEqual([1, 2, 3]);
    expect(result.value.mimeType).toBe('image/png');
    data.fill(9);
    expect([...result.value.data]).toEqual([1, 2, 3]);
  });

  it('空字节是成功的边界值，不与读取失败混同', async () => {
    const result = await fetchMediaResult(remote, limits, {
      fetchMedia: async () => ({ data: new Uint8Array() }),
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.data.byteLength).toBe(0);
  });

  it.each([
    { maxBytes: 0, timeoutMs: 100 },
    { maxBytes: -1, timeoutMs: 100 },
    { maxBytes: Number.NaN, timeoutMs: 100 },
    { maxBytes: 8, timeoutMs: 0 },
    { maxBytes: 8, timeoutMs: Number.POSITIVE_INFINITY },
  ])('非法限额不执行任何网络动作：%j', async (invalid) => {
    const fetchImpl = vi.fn(async () => new Response());
    const result = await fetchMediaResult(remote, invalid, { fetchImpl });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', reason: 'invalid-options', retry: 'never' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('缺失来源、默认来源不支持的平台标识及协议分别分类', async () => {
    const fetchImpl = vi.fn(async () => new Response());
    expect(await fetchMediaResult({}, limits, { fetchImpl })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND', reason: 'missing-source' },
    });
    for (const source of [
      { fileId: 'platform-only' },
      { url: 'file:///private/path' },
      { url: 'invalid-url' },
    ])
      expect(await fetchMediaResult(source, limits, { fetchImpl })).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT', reason: 'unsupported-source' },
      });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('HTTP 拒绝保留稳定分类、状态码、根因身份，无内部重试', async () => {
    const logger = createNullLogger();
    const cause = vi.spyOn(logger, 'cause').mockReturnValue('media-error-1');
    const fetchImpl = vi.fn(async () => new Response('error', { status: 503 }));
    const result = await fetchMediaResult(remote, limits, { fetchImpl, logger });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'UPSTREAM_FAILED',
        reason: 'upstream-http',
        httpStatus: 503,
        retry: 'safe',
        errorId: 'media-error-1',
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cause).toHaveBeenCalledTimes(1);
  });

  it('网络异常保留原始 cause 与关联 errorId', async () => {
    const original = new Error('private upstream diagnostic');
    const logger = createNullLogger();
    vi.spyOn(logger, 'cause').mockReturnValue('root-cause');
    const result = await fetchMediaResult(remote, limits, {
      logger,
      fetchImpl: async () => {
        throw original;
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'upstream-failed', code: 'UPSTREAM_FAILED', errorId: 'root-cause' },
    });
    if (!result.ok) expect(result.error.cause).toBe(original);
  });

  it('声明字节数和流的实际字节数都受预算约束，超额停止读取', async () => {
    const declared = await fetchMediaResult(remote, limits, {
      fetchImpl: async () => new Response('x', { headers: { 'content-length': '9' } }),
    });
    expect(declared).toMatchObject({
      ok: false,
      error: { reason: 'byte-limit', maxBytes: 8, actualBytes: 9 },
    });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(5));
      },
      cancel,
    });
    const actual = await fetchMediaResult(remote, limits, {
      fetchImpl: async () => new Response(body),
    });
    expect(actual).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', reason: 'byte-limit', source: 'network', actualBytes: 10 },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('兼容来源 undefined 与损坏结果有独立失败分类', async () => {
    expect(
      await fetchMediaResult(remote, limits, { fetchMedia: async () => undefined })
    ).toMatchObject({
      ok: false,
      error: { reason: 'missing-result', code: 'UPSTREAM_FAILED', source: 'legacy' },
    });
    const invalid = (async () => ({ data: 'not-bytes' })) as unknown as MediaResultFetcher;
    expect(await fetchMediaResult(remote, limits, { fetchResult: invalid })).toMatchObject({
      ok: false,
      error: { reason: 'invalid-result', code: 'UPSTREAM_FAILED', source: 'typed' },
    });
  });

  it('适配器与调用者不能改写固定输入限额或返回字节的内部引用', async () => {
    const input = { fileId: 'file-1', context: { groupId: 'group-1' } };
    const options = { ...limits };
    const original = new Uint8Array([1, 2]);
    let resolveBytes!: (bytes: MediaBytes) => void;
    const promise = fetchMediaResult(input, options, {
      fetchMedia: (media, fixed) => {
        media.context!.groupId = 'adapter-mutation';
        fixed.maxBytes = 999;
        return new Promise<MediaBytes>((resolve) => {
          resolveBytes = resolve;
        });
      },
    });
    input.context.groupId = 'caller-mutation';
    options.maxBytes = 1;
    resolveBytes({ data: original });
    const result = await promise;
    expect(input.context.groupId).toBe('caller-mutation');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('fixed input limit changed');
    original[0] = 8;
    expect([...result.value.data]).toEqual([1, 2]);
  });

  it('固定时钟超时会中止来源；迟到结果不再次通知或生成根因', async () => {
    const clock = new ManualClock();
    clock.time = 0;
    const logger = createNullLogger();
    const cause = vi.spyOn(logger, 'cause').mockReturnValue('timeout-cause');
    let resolveLate!: (result: MediaFetchResult) => void;
    let signal!: AbortSignal;
    const fetchResult = vi.fn((_media, _options, active: AbortSignal) => {
      signal = active;
      return new Promise<MediaFetchResult>((resolve) => {
        resolveLate = resolve;
      });
    });
    const pending = fetchMediaResult(remote, limits, { fetchResult, clock, logger });
    clock.advance(100);
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'timeout', code: 'TIMEOUT', retry: 'safe', errorId: 'timeout-cause' },
    });
    expect(signal.aborted).toBe(true);
    resolveLate({ ok: true, value: { data: new Uint8Array(100) } });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchResult).toHaveBeenCalledTimes(1);
    expect(cause).toHaveBeenCalledTimes(1);
  });

  it('有类型来源优先，保留来源失败的 errorId，图片说明不变', async () => {
    const legacy = vi.fn(async () => ({ data: new Uint8Array() }));
    const fetchResult: MediaResultFetcher = async () => ({
      ok: false,
      error: {
        code: 'TIMEOUT',
        retry: 'safe',
        reason: 'timeout',
        source: 'typed',
        errorId: 'upstream-timeout',
      },
    });
    const fetched = await fetchMediaResult(remote, limits, { fetchResult, fetchMedia: legacy });
    expect(fetched).toMatchObject({ ok: false, error: { errorId: 'upstream-timeout' } });
    const prepared = await buildImageBlocks([{ type: 'image', url: remote.url }], {
      maxImages: 1,
      maxBytes: 8,
      maxTiles: 1,
      timeoutMs: 100,
      fetchResult,
      logger: createNullLogger(),
    });
    expect(prepared.notes).toEqual(['（读取失败，未读入）']);
    expect(prepared.blocks).toEqual([]);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('文件真实字节超限仍沿用原提示，并保持 fetched/skipped 互斥', async () => {
    const config = {
      enabled: true,
      maxFileBytes: 8,
      maxFiles: 1,
      saveToInbox: false,
      inboxDir: 'inbox',
      maxExtractChars: 100,
      maxPdfPages: 1,
      extractTimeoutMs: 100,
      maxInboxAgeMs: 100,
      maxInboxBytes: 100,
      extractExtensions: ['txt'],
      retentionDays: 7,
    };
    const result = await ingestFiles({
      parts: [{ type: 'media', mediaKind: 'file', filename: 'input.txt', url: remote.url }],
      workspacePath: '/unused',
      config,
      downloadTimeoutMs: 100,
      fetchMedia: async () => ({ data: new Uint8Array(9) }),
      logger: createNullLogger(),
    });
    expect(result.notes).toEqual(['[文件: input.txt]（实际体积超过 8B 上限，未读取）']);
    expect(result.fetched).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
