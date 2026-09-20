/**
 * TokenManager 单测。
 *
 * 重点覆盖三个"看着在跑其实废掉"的坑：
 *   1. 鉴权失败时 HTTP 状态码仍是 200，必须靠 `code` 判断；
 *   2. `expires_in` 是字符串；
 *   3. 并发请求要去重，否则会撞 100001 限频。
 */

import { describe, expect, it, vi } from 'vitest';

import { describeTokenError, TokenError, TokenManager } from '../src/qq/token.js';
import { createNullLogger } from '../src/logger.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeManager(fetchImpl: typeof fetch, nowImpl?: () => number) {
  return new TokenManager({
    appId: 'app-1',
    appSecret: 'secret-1',
    apiBase: 'https://api.bot.qq.com',
    logger: createNullLogger(),
    fetchImpl,
    ...(nowImpl !== undefined ? { now: nowImpl } : {}),
  });
}

describe('TokenManager', () => {
  it('成功时解析字符串形式的 expires_in 并缓存 token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'tok-A', expires_in: '7200' }));
    const manager = makeManager(fetchImpl as unknown as typeof fetch);

    expect(await manager.get()).toBe('tok-A');
    expect(await manager.get()).toBe('tok-A');
    // 第二次应命中缓存，不再请求
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // 提前 60 秒刷新：有效期 7200s，所以剩余应约为 7140s
    const snapshot = manager.snapshot();
    expect(snapshot.hasToken).toBe(true);
    expect(snapshot.expiresInMs).toBeGreaterThan(7_000_000);
    expect(snapshot.expiresInMs).toBeLessThanOrEqual(7_140_000 + 50);
  });

  it('请求体使用 appId/clientSecret 字段名', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 't', expires_in: '7200' }));
    const manager = makeManager(fetchImpl as unknown as typeof fetch);
    await manager.get();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.bot.qq.com/app/getAppAccessToken');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ appId: 'app-1', clientSecret: 'secret-1' });
  });

  it('HTTP 200 但带非零 code 时必须判为失败', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 100007, message: 'appid invalid' }));
    const manager = makeManager(fetchImpl as unknown as typeof fetch);

    await expect(manager.get()).rejects.toBeInstanceOf(TokenError);
    await expect(manager.get()).rejects.toThrow(/AppID 无效/);
  });

  it('缺少 access_token 字段时判为失败', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0 }));
    const manager = makeManager(fetchImpl as unknown as typeof fetch);
    await expect(manager.get()).rejects.toThrow(/缺少 access_token/);
  });

  it('未过期前不重复请求；过期后自动刷新', async () => {
    let nowMs = 1_000_000;
    let counter = 0;
    const fetchImpl = vi.fn(async () => {
      counter += 1;
      return jsonResponse({ access_token: `tok-${counter}`, expires_in: '7200' });
    });
    const manager = makeManager(fetchImpl as unknown as typeof fetch, () => nowMs);

    expect(await manager.get()).toBe('tok-1');
    nowMs += 1_000_000; // 仍远未到 7140s
    expect(await manager.get()).toBe('tok-1');
    nowMs += 7_200_000; // 越过有效期
    expect(await manager.get()).toBe('tok-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('并发调用只打一次 token 请求', async () => {
    let resolveFetch!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchImpl = vi.fn(() => gate);
    const manager = makeManager(fetchImpl as unknown as typeof fetch);

    const pending = Promise.all([manager.get(), manager.get(), manager.get()]);
    resolveFetch(jsonResponse({ access_token: 'tok', expires_in: '7200' }));
    expect(await pending).toEqual(['tok', 'tok', 'tok']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh 会丢弃缓存', async () => {
    let counter = 0;
    const fetchImpl = vi.fn(async () => {
      counter += 1;
      return jsonResponse({ access_token: `tok-${counter}`, expires_in: '7200' });
    });
    const manager = makeManager(fetchImpl as unknown as typeof fetch);
    expect(await manager.get()).toBe('tok-1');
    expect(await manager.forceRefresh()).toBe('tok-2');
  });

  it('expires_in 非法时回落到 7200 秒', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'tok', expires_in: 'abc' }));
    const manager = makeManager(fetchImpl as unknown as typeof fetch);
    await manager.get();
    expect(manager.snapshot().expiresInMs).toBeGreaterThan(7_000_000);
  });
});

describe('describeTokenError', () => {
  it('把已知错误码翻译成可操作提示', () => {
    expect(describeTokenError(100001, undefined)).toMatch(/频繁/);
    expect(describeTokenError(100007, undefined)).toMatch(/AppID 无效/);
    expect(describeTokenError(100016, undefined)).toMatch(/AppSecret/);
    expect(describeTokenError(undefined, 'boom')).toMatch(/boom/);
  });
});
