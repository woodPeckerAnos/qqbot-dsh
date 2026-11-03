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
export declare class TokenError extends Error {
    readonly code?: number | undefined;
    constructor(message: string, code?: number | undefined);
}
export type createTokenErrorFactory = (message: string, code?: number) => TokenError;
/** 把 QQ 的鉴权错误码翻译成可操作的提示 */
export type describeTokenError = (code: number | undefined, message: string | undefined) => string;
export interface TokenManager {
    /** 取一个可用的 token（必要时刷新）。 */
    get(): Promise<string>;
    /** 强制刷新（例如遇到 401 时）。 */
    forceRefresh(): Promise<string>;
    /** 供 health 展示 */
    snapshot(): {
        hasToken: boolean;
        expiresInMs: number;
    };
}
export type createTokenManagerFactory = (options: TokenManagerOptions) => TokenManager;
