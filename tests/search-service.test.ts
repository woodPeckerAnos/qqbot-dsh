import { describe, expect, it } from 'vitest';
import { createSearchProvider } from '../src/runtime/index.js';
import { createSearchService } from '../src/task/index.js';
import { createLogger } from '../src/observability/index.js';
import { BenchmarkClock } from './bench/session/clock.js';
import { deferred } from './bench/frontend-worker/harness.js';
import { recordBenchmarkEvidence } from './bench/frontend-worker/evidence.js';

const quota =
  'You have exceeded the monthly usage quota. It will reset at 2026-11-28 23:59:59 +0800 CST. We recommend upgrading your plan for more quota, or waiting for the reset.';
const success = {
  content: [
    {
      type: 'web_search_tool_result',
      content: [{ type: 'web_search_result', url: 'https://example.com/source', title: '来源' }],
    },
    {
      type: 'text',
      citations: [{ url: 'https://example.com/source', cited_text: '可以核对的正文' }],
    },
  ],
};
function setup(fetchImpl: typeof fetch) {
  const clock = new BenchmarkClock();
  const provider = createSearchProvider({
    config: {
      baseURL: 'https://search.example/v1',
      apiKeyEnv: 'OFFLINE_KEY',
      model: 'offline',
      maxTokens: 1024,
      maxUses: 2,
      timeoutMs: 30000,
    },
    apiKey: 'offline-secret',
    fetchImpl,
    clock,
    logger: createLogger({ autoTick: false, sink: () => {} }),
  });
  return { clock, provider, service: createSearchService(provider) };
}
describe('主服务搜索错误与进程内额度状态', () => {
  it('月度额度耗尽后排队和新请求复用首次错误且 HTTP 只调用一次', async () => {
    const entered = deferred<undefined>(),
      release = deferred<undefined>();
    let calls = 0;
    const h = setup(async () => {
      calls++;
      entered.resolve(undefined);
      await release.promise;
      return new Response(JSON.stringify({ error: { message: quota } }), { status: 429 });
    });
    const signal = new AbortController().signal;
    const first = h.service.search({ query: '资料' }, signal);
    const queued = h.service.search({ query: '第二个会话' }, signal);
    await entered.promise;
    release.resolve(undefined);
    const results = await Promise.all([first, queued]);
    const next = await h.service.search({ query: '新的 worker' }, signal);
    expect(calls).toBe(1);
    expect(results[0]).toMatchObject({
      ok: false,
      error: {
        code: 'UPSTREAM_FAILED',
        retry: 'after-change',
        cause: {
          kind: 'quota-exhausted',
          message: quota,
          resetAt: '2026-11-28 23:59:59 +0800 CST',
        },
      },
    });
    expect(next).toEqual(results[0]);
    expect(results[1]).toEqual(results[0]);
    expect(!next.ok && next.error).toBe(h.service.quotaFailure());
    expect(Object.isFrozen(h.service.quotaFailure())).toBe(true);
    h.clock.advance(30 * 86400000);
    expect(await h.service.search({ query: '日期已经过了重置时间' }, signal)).toEqual(next);
    expect(calls).toBe(1);
    expect(h.clock.pending).toBe(0);
    await recordBenchmarkEvidence('search-quota-cache', {
      httpRequests: calls,
      queuedAndNewErrorsEqual:
        JSON.stringify(results[0]) === JSON.stringify(results[1]) &&
        JSON.stringify(next) === JSON.stringify(results[0]),
      timers: h.clock.pending,
    });
    h.service.close();
  });
  it('普通 429 不缓存为月度耗尽，后续搜索仍请求服务', async () => {
    let calls = 0;
    const h = setup(async () =>
      ++calls === 1
        ? new Response(
            JSON.stringify({
              error: { message: 'Rate limit exceeded, retry later', type: 'rate_limit_error' },
            }),
            { status: 429 }
          )
        : new Response(JSON.stringify(success))
    );
    const signal = new AbortController().signal;
    expect(await h.service.search({ query: '资料' }, signal)).toMatchObject({
      ok: false,
      error: { cause: { kind: 'service-error', httpStatus: 429 } },
    });
    expect(h.service.quotaFailure()).toBeUndefined();
    expect(await h.service.search({ query: '资料' }, signal)).toMatchObject({
      ok: true,
      value: {
        sources: [{ url: 'https://example.com/source', title: '来源', snippet: '可以核对的正文' }],
      },
    });
    expect(calls).toBe(2);
    await recordBenchmarkEvidence('search-transient-429', {
      httpRequests: calls,
      quotaCached: !!h.service.quotaFailure(),
      timers: h.clock.pending,
    });
    h.service.close();
    expect(h.clock.pending).toBe(0);
  });
  it('HTTP 200 中明确月度额度工具错误也进入原错误流程', async () => {
    let calls = 0;
    const h = setup(async () => {
      calls++;
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'web_search_tool_result',
              content: {
                type: 'web_search_tool_result_error',
                error_code: 'monthly_quota_exceeded',
                message: quota,
              },
            },
          ],
        })
      );
    });
    const signal = new AbortController().signal;
    const first = await h.service.search({ query: '资料' }, signal);
    expect(first).toMatchObject({
      ok: false,
      error: {
        cause: { kind: 'quota-exhausted', httpStatus: 200, providerCode: 'monthly_quota_exceeded' },
      },
    });
    expect(await h.service.search({ query: '资料' }, signal)).toEqual(first);
    expect(calls).toBe(1);
    h.service.close();
  });
  it('普通工具错误不能被忽略为成功或额度耗尽', async () => {
    const h = setup(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: 'web_search_tool_result',
                content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' },
              },
            ],
          })
        )
    );
    expect(await h.service.search({ query: '资料' }, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { cause: { kind: 'service-error', providerCode: 'too_many_requests' } },
    });
    expect(h.service.quotaFailure()).toBeUndefined();
    h.service.close();
  });
  it('排队查询取消立即返回且不会产生 HTTP 请求', async () => {
    const entered = deferred<undefined>(),
      release = deferred<undefined>();
    let calls = 0;
    const h = setup(async () => {
      calls++;
      entered.resolve(undefined);
      await release.promise;
      return new Response(JSON.stringify(success));
    });
    const first = h.service.search({ query: '第一项' }, new AbortController().signal);
    await entered.promise;
    const abort = new AbortController();
    const queued = h.service.search({ query: '取消项' }, abort.signal);
    abort.abort();
    expect(await queued).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(calls).toBe(1);
    release.resolve(undefined);
    await first;
    await h.service.search({ query: '另一项' }, new AbortController().signal);
    expect(calls).toBe(2);
    h.service.close();
    expect(h.clock.pending).toBe(0);
  });
  it('关闭服务取消已发送请求并拒绝后续搜索', async () => {
    const entered = deferred<undefined>();
    const h = setup(async (_url, init) => {
      entered.resolve(undefined);
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          'abort',
          () => {
            reject(new DOMException('aborted', 'AbortError'));
          },
          {
            once: true,
          }
        );
      });
    });
    const pending = h.service.search({ query: '资料' }, new AbortController().signal);
    await entered.promise;
    h.service.close();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(await h.service.search({ query: '后来' }, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: 'CLOSED' },
    });
    expect(h.clock.pending).toBe(0);
  });
  it('服务重建清空额度状态，搜索结果响应保持有界', async () => {
    let calls = 0;
    const h = setup(async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ error: { message: quota } }), { status: 429 })
        : new Response(JSON.stringify(success));
    });
    const signal = new AbortController().signal;
    await h.service.search({ query: '资料' }, signal);
    h.service.close();
    const fresh = createSearchService(h.provider);
    expect(fresh.quotaFailure()).toBeUndefined();
    const result = await fresh.search({ query: '重启后' }, signal);
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(48 * 1024);
    expect(calls).toBe(2);
    fresh.close();
  });
  it('提供商未知形状明确失败，凭证不进入错误内容', async () => {
    const h = setup(async () => new Response('{"unexpected":true}'));
    const result = await h.service.search({ query: '资料' }, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('offline-secret');
    expect(h.service.quotaFailure()).toBeUndefined();
    h.service.close();
  });
});
