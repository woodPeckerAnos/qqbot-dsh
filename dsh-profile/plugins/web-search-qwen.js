/**
 * 千问 Token Plan 联网搜索后端（`ctx.web` 的 search provider）。
 *
 * 为什么不是复用 `web-search-deepseek`：那个后端走的是 Anthropic Messages 协议
 * （`/messages` + 服务端 `web_search_20250305` 工具）。千问 Token Plan 的模型内置
 * 工具（联网搜索）只通过 **OpenAI 兼容的 Responses API** 触发——官方文档明确写了
 * 「需通过 Responses API 调用才会自动触发；仅支持 Chat Completions 的客户端不会」。
 * 所以这里单独实现一个 provider，而不是把 Anthropic 后端的 baseURL 指过来。
 *
 * 一次搜索 = 一个 Responses 请求：
 *   POST {baseURL}/responses
 *   { model, input, tools: [{ type: 'web_search' }], reasoning: { effort }, max_output_tokens }
 *
 * 返回的 `output[]` 里：
 *   - `web_search_call.action.sources[] = { type: 'url', url }` → 结构化来源
 *     （这是唯一可信的来源列表，不从模型正文里抓 URL）；
 *   - `message.content[].text` → 模型综合搜索结果写的回答，作为 `content` 交给
 *     `web_search` 工具（上游会先打「外部内容、不可当指令」的提示）。
 *
 * 失败语义（与 dsh-web-search-deepseek 对齐）：
 *   - 缺凭证 → WEB_PROVIDER_CREDENTIAL_MISSING
 *   - 调用方取消 → WEB_ABORTED
 *   - HTTP/超时/响应体不可解析/没有触发搜索 → WEB_PROVIDER_ERROR
 * 错误信息里刻意带上端点，方便区分「搜索端点配错」和「模型不支持内置工具」。
 *
 * 配置由 dsh-profile/cordis.patch.yml 静态插入（本文件以相对路径被引用，路径以
 * patch 文件为基准解析）；models.webSearch 存在时，qqbot 生成的第二个 patch 会
 * 覆盖下面的 config。密钥只从环境变量读，绝不写进配置文件/日志。
 *
 * @typedef {object} WebSearchQwenConfig
 * @property {string} [apiKeyEnv] 凭证引用（环境变量名），默认 QWEN_TOKEN_PLAN_API_KEY
 * @property {string} [baseURL] OpenAI 兼容基址，默认千问AI平台 Token Plan
 * @property {string} [model] 搜索模型，默认 qwen3.7-plus
 * @property {number} [maxOutputTokens] 输出上限（含思考 token），默认 2048
 * @property {number} [timeoutMs] 单次搜索超时，默认 60000
 */

import { WebError } from '@deepseek-ai/dsh-web';

export const name = 'web-search-qwen';

/** 这个 provider 只用 ctx.web 这一个服务；web 缺失时插件保持 pending。 */
export const inject = ['web'];

/** 向 ctx.web 注册的 provider id（models.webSearch 会把 searchProvider 钉到它）。 */
const PROVIDER_ID = 'qwen';

const DEFAULT_API_KEY_ENV = 'QWEN_TOKEN_PLAN_API_KEY';
const DEFAULT_BASE_URL = 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3.7-plus';
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 搜索是"检索 + 总结"，不需要 xhigh 那档思考；medium 在延迟/质量/积分之间折中。
 * 注意 Responses API 的思考参数是 `reasoning.effort`，不是 Chat Completions 的
 * `enable_thinking` / `reasoning_effort`。
 */
const REASONING_EFFORT = 'medium';

/** 归属标识；出问题时服务端日志能看出是哪个客户端发的。 */
const USER_AGENT = 'qqbot-dsh/web-search-qwen';

/** 环境变量名语法（apiKeyEnv 是引用，不是值）。 */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 读非空字符串配置项；undefined/null 用默认值，其他类型直接报配置错误。 */
function readString(raw, key, fallback, label) {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name}: ${label || key} 必须是非空字符串，收到 ${describe(value)}`);
  }
  return value.trim();
}

/** 读正整数配置项；undefined/null 用默认值。 */
function readInt(raw, key, fallback, min, max) {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    const span = max === undefined ? `≥ ${min}` : `在 [${min}, ${max}] 之间`;
    throw new Error(`${name}: ${key} 必须是${span}的整数，收到 ${describe(value)}`);
  }
  return value;
}

/**
 * 把 patch 里的 config 归一化成运行期参数，并在启动期校验（拼错要炸在 boot，
 * 不要拖到第一次搜索）。导出给单测用。
 *
 * @param {WebSearchQwenConfig} [raw]
 * @returns {{apiKeyEnv: string, baseURL: string, model: string, maxOutputTokens: number, timeoutMs: number}}
 */
export function normalizeConfig(raw = {}) {
  if (!isPlainObject(raw)) {
    throw new Error(`${name}: config 必须是映射，收到 ${describe(raw)}`);
  }
  const apiKeyEnv = readString(raw, 'apiKeyEnv', DEFAULT_API_KEY_ENV);
  if (!ENV_NAME_PATTERN.test(apiKeyEnv)) {
    throw new Error(
      `${name}: apiKeyEnv 必须是合法的环境变量名（它是引用而不是密钥本身），收到 ${describe(apiKeyEnv)}`,
    );
  }
  const baseURL = readString(raw, 'baseURL', DEFAULT_BASE_URL).replace(/\/+$/u, '');
  let parsed;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error(`${name}: baseURL 不是合法 URL，收到 ${describe(baseURL)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${name}: baseURL 必须是 http(s) 地址，收到 ${describe(baseURL)}`);
  }
  const model = readString(raw, 'model', DEFAULT_MODEL);
  const maxOutputTokens = readInt(raw, 'maxOutputTokens', DEFAULT_MAX_OUTPUT_TOKENS, 16);
  const timeoutMs = readInt(raw, 'timeoutMs', DEFAULT_TIMEOUT_MS, 1_000, 300_000);
  return { apiKeyEnv, baseURL, model, maxOutputTokens, timeoutMs };
}

/** 结构化来源：先收集 web_search_call，再用 message 上的 citation 补标题。 */
function collectSources(output) {
  /** @type {Map<string, {url: string, title?: string}>} */
  const byUrl = new Map();
  const add = (url, title) => {
    if (typeof url !== 'string' || url.length === 0) return;
    const existing = byUrl.get(url);
    const cleanTitle = typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined;
    if (existing === undefined) {
      byUrl.set(url, cleanTitle === undefined ? { url } : { url, title: cleanTitle });
      return;
    }
    // 后到的 citation 通常带标题；只补空缺，不改已有值。
    if (existing.title === undefined && cleanTitle !== undefined) existing.title = cleanTitle;
  };

  for (const item of Array.isArray(output) ? output : []) {
    if (!isPlainObject(item)) continue;
    if (item.type === 'web_search_call') {
      for (const source of Array.isArray(item.action?.sources) ? item.action.sources : []) {
        if (typeof source === 'string') add(source);
        else if (isPlainObject(source)) add(source.url, source.title);
      }
    }
  }
  // 引用（annotations）一般是空数组；有就用来补标题/兜底来源。
  for (const item of Array.isArray(output) ? output : []) {
    if (!isPlainObject(item) || item.type !== 'message') continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (!isPlainObject(part)) continue;
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (isPlainObject(annotation)) add(annotation.url, annotation.title);
      }
    }
  }
  return [...byUrl.values()];
}

/** 模型综合搜索结果写的最终回答；只取 message 里的 output_text。 */
function collectAnswer(output) {
  const parts = [];
  for (const item of Array.isArray(output) ? output : []) {
    if (!isPlainObject(item) || item.type !== 'message') continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (isPlainObject(part) && part.type === 'output_text' && typeof part.text === 'string' && part.text.trim() !== '') {
        parts.push(part.text.trim());
      }
    }
  }
  return parts.join('\n\n');
}

/**
 * 把 Responses API 的响应体映射成 `ctx.web` 的 WebSearchResult，失败抛 WebError。
 * 导出给单测用（纯函数，不碰网络）。
 *
 * @param {unknown} body 已解析的 JSON
 * @returns {{content?: string, sources: Array<{url: string, title?: string}>, truncated: boolean}}
 */
export function mapSearchResponse(body) {
  if (!isPlainObject(body)) {
    throw new WebError(`千问 Responses API 返回的不是 JSON 对象：${describe(body).slice(0, 200)}`, 'WEB_PROVIDER_ERROR');
  }
  if (body.status === 'failed' || isPlainObject(body.error)) {
    const code = typeof body.error?.code === 'string' ? body.error.code : undefined;
    const message = typeof body.error?.message === 'string' ? body.error.message : '未知错误';
    throw new WebError(
      `千问联网搜索失败${code === undefined ? '' : `（${code}）`}：${message}`,
      'WEB_PROVIDER_ERROR',
    );
  }
  const output = Array.isArray(body.output) ? body.output : [];
  const searched = output.some((item) => isPlainObject(item) && item.type === 'web_search_call');
  if (!searched) {
    throw new WebError(
      '千问 Responses API 没有返回 web_search_call：模型没有触发内置联网搜索。' +
        '检查 webSearch.model 是否为 Token Plan 支持内置工具的模型（qwen3.8-max / qwen3.7-max / qwen3.7-plus）',
      'WEB_PROVIDER_ERROR',
    );
  }
  const sources = collectSources(output);
  const content = collectAnswer(output);
  return {
    ...(content === '' ? {} : { content }),
    sources,
    truncated: false,
  };
}

/** 从 HTTP 错误响应里尽量提取可读信息，绝不回显请求头/密钥。 */
async function readHttpErrorDetail(response) {
  const text = await response.text().catch(() => '');
  if (text === '') return '';
  try {
    const parsed = JSON.parse(text);
    const code = typeof parsed?.code === 'string' ? parsed.code : '';
    const message = typeof parsed?.message === 'string'
      ? parsed.message
      : typeof parsed?.error?.message === 'string'
        ? parsed.error.message
        : '';
    const detail = [code, message].filter((value) => value !== '').join(': ');
    return detail === '' ? text.slice(0, 300) : detail;
  } catch {
    return text.slice(0, 300);
  }
}

/** 判断已取消/超时，给出稳定的 WebError code。 */
function abortError(signal, timeoutSignal, timeoutMs, error) {
  if (signal?.aborted === true) {
    return new WebError('千问联网搜索已取消', 'WEB_ABORTED', { cause: error });
  }
  if (timeoutSignal.aborted === true) {
    return new WebError(`千问联网搜索超时（${timeoutMs}ms）`, 'WEB_PROVIDER_ERROR', { cause: error });
  }
  return undefined;
}

/**
 * 每次搜索都重新解析凭证：环境变量优先，其次 credentials 服务（与
 * dsh-web-search-deepseek 同一条纪律——不把密钥缓存在 provider 上）。
 */
async function resolveApiKey(ctx, apiKeyEnv) {
  const fromEnv = process.env[apiKeyEnv];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  const credentials = ctx.get('credentials');
  if (credentials === undefined) return undefined;
  let resolved;
  try {
    resolved = await credentials.resolve(apiKeyEnv);
  } catch (error) {
    throw new WebError(`千问联网搜索凭证解析失败（${apiKeyEnv}）：${String(error)}`, 'WEB_PROVIDER_ERROR', {
      cause: error,
    });
  }
  const value = resolved?.value;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 注册 provider。`available()` 只做本地判断（不联网）：环境里有凭证即可用。
 * 凭证只存在 credentials 服务里时 available() 看不到——本部署的 .env 会整份
 * 注入 dsh 子进程，因此以环境变量为准。
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config);

  const available = () => {
    const key = process.env[settings.apiKeyEnv];
    return typeof key === 'string' && key.trim() !== '';
  };

  const provider = {
    id: PROVIDER_ID,
    available,
    async search(request, signal) {
      const apiKey = await resolveApiKey(ctx, settings.apiKeyEnv);
      if (apiKey === undefined) {
        throw new WebError(
          `千问联网搜索缺少凭证：环境变量 ${settings.apiKeyEnv} 为空。` +
            '把 Token Plan API Key（sk-sp- 开头）写进 .env，或删掉 models.webSearch 回退到方舟搜索。',
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        );
      }
      if (signal?.aborted === true) {
        throw new WebError('千问联网搜索已取消', 'WEB_ABORTED');
      }

      const endpoint = `${settings.baseURL}/responses`;
      const timeoutSignal = AbortSignal.timeout(settings.timeoutMs);
      const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      const body = {
        model: settings.model,
        // 明确要求执行一次搜索，而不是让模型自己决定要不要联网。
        input: `Perform a web search for the query: ${request.query}`,
        tools: [{ type: 'web_search' }],
        reasoning: { effort: REASONING_EFFORT },
        max_output_tokens: settings.maxOutputTokens,
      };

      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (error) {
        const aborted = abortError(signal, timeoutSignal, settings.timeoutMs, error);
        if (aborted !== undefined) throw aborted;
        throw new WebError(
          `千问联网搜索请求失败：${String(error)}\n端点：${endpoint}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        );
      }

      if (!response.ok) {
        const detail = await readHttpErrorDetail(response);
        throw new WebError(
          `千问联网搜索 HTTP ${response.status}${detail === '' ? '' : `：${detail}`}\n端点：${endpoint}`,
          'WEB_PROVIDER_ERROR',
        );
      }

      let parsed;
      try {
        parsed = await response.json();
      } catch (error) {
        const aborted = abortError(signal, timeoutSignal, settings.timeoutMs, error);
        if (aborted !== undefined) throw aborted;
        throw new WebError(`千问联网搜索返回了无法解析的响应体（端点：${endpoint}）`, 'WEB_PROVIDER_ERROR', {
          cause: error,
        });
      }
      return mapSearchResponse(parsed);
    },
  };

  ctx.web.registerSearchProvider(provider);

  // DSH 的 stdout 是 JSON-RPC 专用通道，日志只能走 stderr（与 auto-approve 一致）。
  // 不打印密钥，只打印"是否已配置"。
  process.stderr.write(
    `${JSON.stringify({
      level: 'info',
      time: Date.now(),
      plugin: name,
      message: 'plugin mounted',
      model: settings.model,
      baseURL: settings.baseURL,
      apiKeyEnv: settings.apiKeyEnv,
      keyConfigured: available(),
    })}\n`,
  );
}
