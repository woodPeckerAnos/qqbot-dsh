/**
 * 千问 Token Plan 联网搜索插件的单测。
 *
 * 这一层守的是"解析"与"失败语义"两件事：
 *   - Responses API 的 output[] 必须只从 web_search_call.action.sources 取来源，
 *     不能从模型正文里抓 URL；失败状态要转成带 code 的 WebError；
 *   - 配置拼错要在 boot 期炸，搜索请求的端点/工具/模型要可断言。
 * 全部离线：fetch 由测试注入，不触网。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  apply,
  mapSearchResponse,
  normalizeConfig,
} from '../dsh-profile/plugins/web-search-qwen.js';

const ENV_NAME = 'QQBOT_TEST_QWEN_KEY';

afterEach(() => {
  delete process.env[ENV_NAME];
});

describe('normalizeConfig', () => {
  it('缺省值可直接运行；末尾斜杠会被去掉', () => {
    const settings = normalizeConfig({});
    expect(settings).toEqual({
      apiKeyEnv: 'QWEN_TOKEN_PLAN_API_KEY',
      baseURL: 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
      model: 'qwen3.7-plus',
      maxOutputTokens: 2048,
      timeoutMs: 60_000,
    });
    expect(normalizeConfig({ baseURL: 'https://example.test/v1///' }).baseURL).toBe('https://example.test/v1');
  });

  it('apiKeyEnv 是引用不是密钥：非法变量名直接拒绝', () => {
    expect(() => normalizeConfig({ apiKeyEnv: 'sk-sp-literal-key' })).toThrow(/环境变量名/);
    expect(() => normalizeConfig({ apiKeyEnv: '1BAD' })).toThrow(/环境变量名/);
  });

  it('baseURL / 数值项启动期校验', () => {
    expect(() => normalizeConfig({ baseURL: 'not a url' })).toThrow(/不是合法 URL/);
    expect(() => normalizeConfig({ baseURL: 'file:///tmp/x' })).toThrow(/http\(s\)/);
    expect(() => normalizeConfig({ maxOutputTokens: 15 })).toThrow(/maxOutputTokens/);
    expect(() => normalizeConfig({ timeoutMs: 999 })).toThrow(/timeoutMs/);
    expect(() => normalizeConfig({ model: '  ' })).toThrow(/model/);
  });
});

describe('mapSearchResponse', () => {
  const body = {
    id: 'resp-1',
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '思考中' }] },
      {
        type: 'web_search_call',
        status: 'completed',
        action: {
          query: '杭州天气',
          type: 'search',
          sources: [
            { type: 'url', url: 'https://a.example/news' },
            { type: 'url', url: 'https://b.example/weather' },
          ],
        },
      },
      {
        // 同一 URL 在多轮搜索里重复出现：按 URL 去重
        type: 'web_search_call',
        action: { sources: ['https://a.example/news', { url: 'https://c.example/z', title: 'C 站' }] },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: '今天杭州多云转晴，最高 26℃。',
            // 引用一般有空数组；有就用来补标题
            annotations: [{ type: 'url_citation', url: 'https://a.example/news', title: 'A 站新闻' }],
          },
        ],
      },
    ],
  };

  it('来源只来自 web_search_call（去重、可补标题），回答来自 message', () => {
    const result = mapSearchResponse(body);
    expect(result.content).toBe('今天杭州多云转晴，最高 26℃。');
    expect(result.truncated).toBe(false);
    expect(result.sources).toEqual([
      { url: 'https://a.example/news', title: 'A 站新闻' },
      { url: 'https://b.example/weather' },
      { url: 'https://c.example/z', title: 'C 站' },
    ]);
  });

  it('HTTP 200 但 status=failed（限流等）→ WEB_PROVIDER_ERROR', () => {
    let caught: unknown;
    try {
      mapSearchResponse({ status: 'failed', error: { code: 'server_error', message: 'rate limit' } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
    expect(String(caught)).toContain('rate limit');
  });

  it('没有 web_search_call（模型没触发内置工具）→ 明确报错，不降级成空结果', () => {
    expect(() =>
      mapSearchResponse({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '我直接回答了' }] }],
      }),
    ).toThrow(/没有返回 web_search_call/);
  });

  it('响应体不是对象 → WEB_PROVIDER_ERROR', () => {
    expect(() => mapSearchResponse('oops')).toThrow(/不是 JSON 对象/);
  });
});

describe('apply / search（注入 fetch，不触网）', () => {
  /** 最小 ctx：只实现插件用到的两个入口。 */
  function fakeCtx(credentials) {
    const providers = [];
    const ctx = {
      web: { registerSearchProvider: (provider) => providers.push(provider) },
      get: (name) => (name === 'credentials' ? credentials : undefined),
    };
    return { ctx, providers };
  }

  function responseBody() {
    return {
      status: 'completed',
      output: [
        {
          type: 'web_search_call',
          action: { sources: [{ type: 'url', url: 'https://example.com/result' }] },
        },
        {
          type: 'message',
          content: [{ type: 'output_text', text: '结果摘要' }],
        },
      ],
    };
  }

  it('注册为 qwen provider；available() 只看本地环境变量', () => {
    const { ctx, providers } = fakeCtx(undefined);
    apply(ctx, { apiKeyEnv: ENV_NAME });
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe('qwen');
    expect(providers[0].available()).toBe(false);
    process.env[ENV_NAME] = 'sk-sp-test';
    expect(providers[0].available()).toBe(true);
  });

  it('缺凭证 → WEB_PROVIDER_CREDENTIAL_MISSING（不发请求）', async () => {
    const { ctx, providers } = fakeCtx(undefined);
    apply(ctx, { apiKeyEnv: ENV_NAME });
    await expect(providers[0].search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    });
  });

  it('按 Responses API 发请求，并把 output 映射成 sources/content', async () => {
    process.env[ENV_NAME] = 'sk-sp-test';
    const { ctx, providers } = fakeCtx(undefined);
    apply(ctx, { apiKeyEnv: ENV_NAME, baseURL: 'https://qwen.example/v1' });

    const originalFetch = globalThis.fetch;
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify(responseBody()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const result = await providers[0].search({ query: '杭州天气' });
      expect(seen.url).toBe('https://qwen.example/v1/responses');
      expect(new Headers(seen.init.headers).get('authorization')).toBe('Bearer sk-sp-test');
      const request = JSON.parse(seen.init.body);
      expect(request.model).toBe('qwen3.7-plus');
      expect(request.input).toContain('杭州天气');
      expect(request.tools).toEqual([{ type: 'web_search' }]);
      expect(request.reasoning).toEqual({ effort: 'medium' });
      expect(result.sources).toEqual([{ url: 'https://example.com/result' }]);
      expect(result.content).toBe('结果摘要');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('HTTP 4xx 带上状态与端点，便于区分 key/端点配错', async () => {
    process.env[ENV_NAME] = 'sk-sp-test';
    const { ctx, providers } = fakeCtx(undefined);
    apply(ctx, { apiKeyEnv: ENV_NAME, baseURL: 'https://qwen.example/v1' });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 'InvalidApiKey', message: 'Invalid API-key provided.' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    try {
      await expect(providers[0].search({ query: 'x' })).rejects.toThrow(/HTTP 401.*InvalidApiKey/s);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
