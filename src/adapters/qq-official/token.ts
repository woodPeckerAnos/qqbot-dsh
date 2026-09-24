/**
 * App Access Token 管理。
 *
 * 实况文档要点（全都在这里落地，因为踩错任一条都会让机器人"看着在跑其实是废的"）：
 *
 *   1. `POST {apiBase}/app/getAppAccessToken`，body `{appId, clientSecret}`；
 *   2. **失败时 HTTP 状态码仍是 200**，必须靠响应体里的 `code` 判断。
 *      典型码：100007 appid 无效 / 机器人被封或已删除、100016 appid 或 secret 错误、
 *      100001 请求过于频繁；
 *   3. `expires_in` 是**字符串**（例如 "7200"），不是数字；
 *   4. 默认有效期 7200 秒；同一 token 在有效期内重复请求会返回**同一个** token，
 *      临近过期 60 秒内会返回新 token 且旧 token 仍可再用 60 秒；
 *   5. 调用 OpenAPI 时用 `Authorization: QQBot <access_token>`。
 *      注意不是 `Bot <appid>.<token>`——那是旧文档里的写法，会 401。
 */

import type { Logger } from '../../logger.js';
import type { AppAccessTokenResponse } from './types.js';

export interface TokenManagerOptions {
  appId: string;
  appSecret: string;
  apiBase: string;
  logger: Logger;
  /** 提前刷新窗口，默认 60 秒（与官方"临近过期 60 秒返回新 token"对齐） */
  refreshAheadMs?: number;
  /** 注入 fetch，便于单测 */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

/** 把 QQ 的鉴权错误码翻译成可操作的提示 */
export function describeTokenError(code: number | undefined, message: string | undefined): string {
  const suffix = message !== undefined && message !== '' ? `（平台返回：${message}）` : '';
  switch (code) {
    case 100001:
      return `请求过于频繁，请稍后再试${suffix}`;
    case 100007:
      return `AppID 无效，或该机器人已被封禁/删除${suffix}`;
    case 100016:
      return `AppID 或 AppSecret 不正确${suffix}`;
    case 10004:
      return `机器人不存在${suffix}`;
    default:
      return `获取 access_token 失败${code !== undefined ? `（code=${code}）` : ''}${suffix}`;
  }
}

export class TokenManager {
  private token: string | undefined;
  private expiresAt = 0;
  /** 同一个刷新请求的并发去重：避免同时打多个 token 请求触发 100001 限频 */
  private inflight: Promise<string> | undefined;

  constructor(private readonly options: TokenManagerOptions) {}

  /** 取一个可用的 token（必要时刷新）。 */
  async get(): Promise<string> {
    const now = this.now();
    if (this.token !== undefined && now < this.expiresAt) return this.token;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** 强制刷新（例如遇到 401 时）。 */
  async forceRefresh(): Promise<string> {
    this.token = undefined;
    this.expiresAt = 0;
    return this.get();
  }

  /** 供 health 展示 */
  snapshot(): { hasToken: boolean; expiresInMs: number } {
    const now = this.now();
    return {
      hasToken: this.token !== undefined,
      expiresInMs: this.token === undefined ? 0 : Math.max(0, this.expiresAt - now),
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async refresh(): Promise<string> {
    const { appId, appSecret, apiBase, logger } = this.options;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = `${apiBase.replace(/\/+$/, '')}/app/getAppAccessToken`;

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
    });

    // 注意：失败也是 200，所以这里不能按 response.ok 判断
    if (!response.ok) {
      throw new TokenError(`获取 access_token 时 HTTP 状态异常：${response.status}`);
    }

    let body: AppAccessTokenResponse;
    try {
      body = (await response.json()) as AppAccessTokenResponse;
    } catch (error) {
      throw new TokenError(
        `access_token 响应体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (body.code !== undefined && body.code !== 0) {
      throw new TokenError(describeTokenError(body.code, body.message), body.code);
    }
    if (typeof body.access_token !== 'string' || body.access_token.trim() === '') {
      throw new TokenError(
        `access_token 响应缺少 access_token 字段（body=${JSON.stringify(body).slice(0, 200)}）`,
      );
    }

    // expires_in 是字符串；容错处理数字形式与非法值
    const expiresInSec = Number(body.expires_in);
    const ttlMs =
      Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec * 1000 : 7200 * 1000;
    const refreshAheadMs = this.options.refreshAheadMs ?? 60_000;

    this.token = body.access_token;
    this.expiresAt = this.now() + Math.max(1_000, ttlMs - refreshAheadMs);
    logger.info('已获取 access_token', {
      expiresInSec: Math.round(ttlMs / 1000),
      refreshAheadSec: Math.round(refreshAheadMs / 1000),
    });
    return this.token;
  }
}
