/**
 * 模型 API 配置层单测（src/dsh/model-config.ts + 配置层集成）。
 *
 * 这一层守的是两类启动期故障：
 *   1. 配置写错（键名拼错、类型错、取值越界、路由名撞车）必须在 qqbot 启动期炸，
 *      而不是拖到 dsh 子进程 initialize / 首次请求才报；
 *   2. 密钥纪律：内联密钥与带密钥语义的 header 名在解析期直接拒绝——
 *      qqbot.yml 是随仓库提交的文件。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { ConfigError, describeConfig, loadConfig } from '../src/config.js';
import { parseConfigFileText } from '../src/config-file.js';
import {
  assertModelApiConfig,
  MODEL_API_PATCH_FILENAME,
  parseModelApiSection,
  renderModelApiPatch,
  resolveAuxRoute,
  writeModelApiPatch,
  type ModelApiConfig,
} from '../src/dsh/model-config.js';
import { DshRuntime } from '../src/dsh/process.js';

const baseEnv = {
  QQ_APP_ID: 'app-1',
  QQ_APP_SECRET: 'secret-1',
  DEEPSEEK_API_KEY: 'sk-test',
};

describe('parseModelApiSection', () => {
  it('解析完整的双路由族配置', () => {
    const config = parseModelApiSection(
      parseYaml(`
deepseek:
  apiKeyEnv: DEEPSEEK_API_KEY
  baseURL: https://api.deepseek.com/anthropic
  thinking: enabled
  reasoningEffort: high
  maxTokens: 256000
  defaultContextWindow: 1000000
  models:
    - id: deepseek-flash
      contextWindow: 1000000
      maxTokens: 256000
      inputModalities: [text, image]
      imagePixelBudget: 640000
      toolUpdate: in-history
  retryPolicy:
    mode: normal
    maxRetries: 3
    backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.2 }
providers:
  openai:
    apiKeyEnv: OPENAI_API_KEY
    modelOverrides:
      gpt-5: { maxTokens: 32768 }
  acme-gateway:
    displayName: Acme Gateway
    api: openai-completions
    baseURL: https://gateway.acme.example/v1
    apiKeyEnv: ACME_GATEWAY_API_KEY
    defaultContextWindow: 262144
    defaultMaxTokens: 32768
    defaultInput: [text, image]
    headers: { X-Tenant: qqbot }
    reasoning: high
    thinkingBudgets: { low: 1024, high: 8192 }
    cacheRetention: short
    transport: sse
    timeoutMs: 60000
    compat:
      thinkingFormat: deepseek
      supportsUsageInStreaming: true
      maxTokensField: max_completion_tokens
      chatTemplateKwargs: { enable_thinking: { $var: thinking.enabled, omitWhenOff: true } }
    models:
      - id: acme-think
        contextWindow: 262144
        maxTokens: 32768
        input: [text, image]
        reasoningEfforts: { off: null, high: high }
    retryPolicy: { mode: always }
`),
      'qqbot.yml: models',
    );

    expect(config.deepseek).toMatchObject({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      thinking: 'enabled',
      reasoningEffort: 'high',
      retryPolicy: { mode: 'normal', maxRetries: 3, backoff: { jitterRatio: 0.2 } },
    });
    expect(config.deepseek?.models?.[0]).toMatchObject({ id: 'deepseek-flash', imagePixelBudget: 640000 });

    const acme = config.providers['acme-gateway'];
    expect(acme).toMatchObject({
      api: 'openai-completions',
      baseURL: 'https://gateway.acme.example/v1',
      headers: { 'X-Tenant': 'qqbot' },
      cacheRetention: 'short',
      transport: 'sse',
      compat: { thinkingFormat: 'deepseek', maxTokensField: 'max_completion_tokens' },
      thinkingBudgets: { low: 1024, high: 8192 },
      retryPolicy: { mode: 'always' },
    });
    expect(acme.compat?.chatTemplateKwargs?.['enable_thinking']).toEqual({
      $var: 'thinking.enabled',
      omitWhenOff: true,
    });
    expect(acme.models?.[0]?.reasoningEfforts).toEqual({ off: null, high: 'high' });
    expect(config.providers['openai']?.modelOverrides?.['gpt-5']).toEqual({ maxTokens: 32768 });
    // modelOverrides 条目不带 id（id 在字典键里）
    expect(config.providers['openai']?.modelOverrides?.['gpt-5']).not.toHaveProperty('id');
  });

  it('拒绝未知键（每一层都拒，拼错不能静默生效）', () => {
    expect(() => parseModelApiSection(parseYaml('deeepseek: {}'), 'models')).toThrow(/不是可识别的配置项/);
    expect(() => parseModelApiSection(parseYaml('deepseek:\n  baseUrl: x'), 'models')).toThrow(/models\.deepseek\.baseUrl/);
    expect(() =>
      parseModelApiSection(parseYaml('providers:\n  openai:\n    baseUrl: x'), 'models'),
    ).toThrow(/providers\.openai\.baseUrl/);
    expect(() =>
      parseModelApiSection(parseYaml('providers:\n  openai:\n    compat:\n      thinkingformaat: deepseek'), 'models'),
    ).toThrow(/compat\.thinkingformaat/);
    expect(() =>
      parseModelApiSection(parseYaml('providers:\n  openai:\n    models:\n      - id: m\n        contextwindow: 1'), 'models'),
    ).toThrow(/models\[0\]\.contextwindow/);
  });

  it('拒绝内联密钥写法与带密钥语义的 header（密钥只允许 apiKeyEnv 引用）', () => {
    expect(() =>
      parseModelApiSection(parseYaml('providers:\n  openai:\n    apiKey: sk-live'), 'models'),
    ).toThrow(/内联密钥/);
    expect(() =>
      parseModelApiSection(parseYaml('deepseek:\n  authToken: tok'), 'models'),
    ).toThrow(/内联密钥/);
    expect(() =>
      parseModelApiSection(parseYaml('providers:\n  openai:\n    headers: { Authorization: "Bearer x" }'), 'models'),
    ).toThrow(/密钥语义/);
    expect(() =>
      parseModelApiSection(parseYaml('providers:\n  openai:\n    headers: { x-api-key: x }'), 'models'),
    ).toThrow(/密钥语义/);
  });

  it('apiKeyEnv 必须是合法的环境变量名', () => {
    expect(() =>
      parseModelApiSection(parseYaml('providers:\n  openai:\n    apiKeyEnv: "not a name!"'), 'models'),
    ).toThrow(/环境变量名/);
  });

  it('路由名必须是小写连字符标识符，且不能撞 DSH 原生路由', () => {
    expect(() => parseModelApiSection(parseYaml('providers:\n  OpenAI: {}'), 'models')).toThrow(/路由名/);
    expect(() => parseModelApiSection(parseYaml('providers:\n  deepseek-official: {}'), 'models')).toThrow(/占用/);
    expect(() => parseModelApiSection(parseYaml('providers:\n  deepseek-account: {}'), 'models')).toThrow(/占用/);
  });

  it('models 与 modelOverrides 互斥（DSH 同款规则，提前到解析期）', () => {
    expect(() =>
      parseModelApiSection(
        parseYaml('providers:\n  openai:\n    models: [{ id: a }]\n    modelOverrides: { b: {} }'),
        'models',
      ),
    ).toThrow(/不能同时配 models 与 modelOverrides/);
  });

  it('模型条目必须有 id；modelOverrides 条目不许再写 id', () => {
    expect(() =>
      parseModelApiSection(parseYaml('providers:\n  openai:\n    models: [{ name: 无名 }]'), 'models'),
    ).toThrow(/id 是必填项/);
    expect(() =>
      parseModelApiSection(parseYaml('providers:\n  openai:\n    modelOverrides: { gpt-5: { id: gpt-5 } }'), 'models'),
    ).toThrow(/不该出现在 modelOverrides/);
  });

  it('reasoningEfforts：false 合法；非 off 档必须给出线上拼写', () => {
    const parsed = parseModelApiSection(
      parseYaml('providers:\n  openai:\n    models:\n      - id: m\n        reasoningEfforts: false'),
      'models',
    );
    expect(parsed.providers['openai']?.models?.[0]?.reasoningEfforts).toBe(false);

    expect(() =>
      parseModelApiSection(
        parseYaml('providers:\n  openai:\n    models:\n      - id: m\n        reasoningEfforts: { high: null }'),
        'models',
      ),
    ).toThrow(/必须给出线上拼写/);
    expect(() =>
      parseModelApiSection(
        parseYaml('providers:\n  openai:\n    models:\n      - id: m\n        reasoningEfforts: { turbo: x }'),
        'models',
      ),
    ).toThrow(/不是可识别的思考档位/);
  });

  it('retryPolicy：always 不接受 maxRetries；退避参数越界要拒', () => {
    expect(() =>
      parseModelApiSection(parseYaml('deepseek:\n  retryPolicy: { mode: always, maxRetries: 3 }'), 'models'),
    ).toThrow(/mode: always/);
    expect(() =>
      parseModelApiSection(parseYaml('deepseek:\n  retryPolicy: { mode: normal, backoff: { jitterRatio: 2 } }'), 'models'),
    ).toThrow(/jitterRatio/);
    expect(() => parseModelApiSection(parseYaml('deepseek:\n  retryPolicy: {}'), 'models')).toThrow(/mode 是必填项/);
  });

  it('模态只接受 text / image（桥接层只会发这两种块）', () => {
    expect(() =>
      parseModelApiSection(parseYaml('providers:\n  openai:\n    models:\n      - id: m\n        input: [text, audio]'), 'models'),
    ).toThrow(/模态/);
    expect(() =>
      parseModelApiSection(parseYaml('providers:\n  openai:\n    defaultInput: []'), 'models'),
    ).toThrow(/模态/);
  });

  it('空段报错（不自定义就该整段删掉）', () => {
    expect(() => parseModelApiSection(parseYaml('{}'), 'models')).toThrow(/不能为空/);
  });

  it('deepseek 目录条目校验（imagePixelBudget / 枚举字段）', () => {
    expect(() =>
      parseModelApiSection(
        parseYaml('deepseek:\n  models:\n    - id: m\n      imagePixelBudget: huge'),
        'models',
      ),
    ).toThrow(/imagePixelBudget/);
    expect(() =>
      parseModelApiSection(
        parseYaml('deepseek:\n  models:\n    - id: m\n      toolUpdate: sometimes'),
        'models',
      ),
    ).toThrow(/toolUpdate/);
  });
});

describe('assertModelApiConfig', () => {
  const withRoute: ModelApiConfig = {
    providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } },
  };

  it('选中的 provider 必须是已声明的路由（否则运行期才炸）', () => {
    expect(() => assertModelApiConfig(withRoute, 'openai', { OPENAI_API_KEY: 'x' })).not.toThrow();
    expect(() => assertModelApiConfig(withRoute, 'deepseek-official', { OPENAI_API_KEY: 'x' })).not.toThrow();
    expect(() => assertModelApiConfig(withRoute, 'anthropic', { OPENAI_API_KEY: 'x' })).toThrow(/没有对应的模型路由配置/);
  });

  it('apiKeyEnv 引用的变量必须在环境中存在（dsh 子进程继承本进程环境）', () => {
    expect(() => assertModelApiConfig(withRoute, 'openai', {})).toThrow(/OPENAI_API_KEY/);
    expect(() => assertModelApiConfig(withRoute, 'openai', { OPENAI_API_KEY: '  ' })).toThrow(/OPENAI_API_KEY/);
    // 未配 apiKeyEnv 的路由不检查（pi-ai 环境发现兜底）
    expect(() => assertModelApiConfig({ providers: { local: {} } }, 'local', {})).not.toThrow();
  });

  it('deepseek 路由的 apiKeyEnv 同样检查', () => {
    const config: ModelApiConfig = { deepseek: { apiKeyEnv: 'MY_DS_KEY' }, providers: {} };
    expect(() => assertModelApiConfig(config, 'deepseek-official', {})).toThrow(/MY_DS_KEY/);
    expect(() => assertModelApiConfig(config, 'deepseek-official', { MY_DS_KEY: 'x' })).not.toThrow();
  });
});

describe('resolveAuxRoute（判定调用的路由解析）', () => {
  it('deepseek-official：凭证默认 DEEPSEEK_API_KEY，可被 models.deepseek.apiKeyEnv 改名', () => {
    expect(resolveAuxRoute({ providers: {} }, 'deepseek-official', 'topic.provider')).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    });
    expect(
      resolveAuxRoute({ deepseek: { apiKeyEnv: 'MY_DS_KEY' }, providers: {} }, 'deepseek-official', 'topic.provider'),
    ).toEqual({ apiKeyEnv: 'MY_DS_KEY' });
  });

  it('pi-ai 路由：带出 apiKeyEnv 与 baseURL', () => {
    const modelApi: ModelApiConfig = {
      providers: { acme: { apiKeyEnv: 'ACME_KEY', baseURL: 'https://gw.example/v1' } },
    };
    expect(resolveAuxRoute(modelApi, 'acme', 'topic.provider')).toEqual({
      apiKeyEnv: 'ACME_KEY',
      baseURL: 'https://gw.example/v1',
    });
  });

  it('未声明的路由 / 协议不兼容 / 无凭证引用：解析期拒绝', () => {
    expect(() => resolveAuxRoute({ providers: {} }, 'openai', 'topic.provider')).toThrow(/未在 models\.providers/);
    expect(() =>
      resolveAuxRoute(
        { providers: { claude: { apiKeyEnv: 'K', api: 'anthropic-messages' } } },
        'claude',
        'topic.provider',
      ),
    ).toThrow(/判定调用无法使用/);
    expect(() =>
      resolveAuxRoute({ providers: { local: { baseURL: 'http://x/v1' } } }, 'local', 'topic.provider'),
    ).toThrow(/没有 apiKeyEnv/);
  });
});

describe('renderModelApiPatch', () => {
  it('无配置时返回 undefined（启动参数保持原样）', () => {
    expect(renderModelApiPatch({ providers: {} })).toBeUndefined();
  });

  it('渲染出两个插件条目，且可被 YAML 解析回同样形状', () => {
    const text = renderModelApiPatch({
      deepseek: { reasoningEffort: 'high', maxTokens: 256000 },
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          apiKeyEnv: 'ACME_GATEWAY_API_KEY',
          compat: { thinkingFormat: 'deepseek' },
          models: [{ id: 'acme-think', contextWindow: 262144 }],
        },
      },
    });
    expect(text).toBeDefined();
    const entries = parseYaml(text as string) as Array<{ id: string; config: Record<string, unknown> }>;
    expect(entries.map((e) => e.id)).toEqual(['llm-deepseek', 'llm-pi-ai']);
    expect(entries[0]?.config).toMatchObject({ reasoningEffort: 'high', maxTokens: 256000 });
    const providers = (entries[1]?.config as { providers: Record<string, unknown> }).providers;
    expect(Object.keys(providers)).toEqual(['acme-gateway']);
    // 生成的 patch 绝不含 !!js（eval 面）与密钥字面量
    expect(text).not.toContain('!!js');
  });

  it('undefined 字段不出现在生成物里', () => {
    const text = renderModelApiPatch({ deepseek: { thinking: 'enabled' }, providers: {} }) as string;
    const entries = parseYaml(text) as Array<{ config: Record<string, unknown> }>;
    expect(entries[0]?.config).toEqual({ thinking: 'enabled' });
  });
});

describe('writeModelApiPatch', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('写入 stateDir 并返回路径；无配置返回 undefined 且不建文件', () => {
    dir = mkdtempSync(join(tmpdir(), 'qqbot-modelapi-'));
    expect(writeModelApiPatch({ providers: {} }, dir)).toBeUndefined();

    const path = writeModelApiPatch({ providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } }, dir);
    expect(path).toBe(join(dir, MODEL_API_PATCH_FILENAME));
    const entries = parseYaml(readFileSync(path as string, 'utf8')) as Array<{ id: string }>;
    expect(entries.map((e) => e.id)).toEqual(['llm-pi-ai']);
  });
});

describe('DshRuntime.buildArgs', () => {
  it('追加的 patches 按顺序排在 profilePatch 之后', () => {
    expect(DshRuntime.buildArgs({ profilePatch: '/a.yml' })).toEqual(['--profile', 'sdk', '--patch', '/a.yml']);
    expect(DshRuntime.buildArgs({ profilePatch: '/a.yml', patches: ['/b.yml', '/c.yml'] })).toEqual([
      '--profile',
      'sdk',
      '--patch',
      '/a.yml',
      '--patch',
      '/b.yml',
      '--patch',
      '/c.yml',
    ]);
  });
});

describe('配置层集成（loadConfig）', () => {
  it('models: 段从文件流入 Config.modelApi，默认配置为空层', () => {
    const bare = loadConfig(baseEnv);
    expect(bare.modelApi).toEqual({ providers: {} });

    const file = parseConfigFileText(`
models:
  providers:
    openai:
      apiKeyEnv: OPENAI_API_KEY
`);
    const config = loadConfig({ ...baseEnv, OPENAI_API_KEY: 'sk-openai' }, file);
    expect(config.modelApi.providers['openai']).toEqual({ apiKeyEnv: 'OPENAI_API_KEY' });
  });

  it('dsh.provider 指向未声明的路由 → 启动期 ConfigError', () => {
    const file = parseConfigFileText(`
dsh:
  provider: openai
models:
  providers:
    acme:
      apiKeyEnv: ACME_KEY
`);
    expect(() => loadConfig({ ...baseEnv, ACME_KEY: 'x' }, file)).toThrow(/没有对应的模型路由配置/);
  });

  it('DSH_PROVIDER 环境变量同样受校验；apiKeyEnv 缺失 → ConfigError', () => {
    const file = parseConfigFileText(`
models:
  providers:
    openai:
      apiKeyEnv: OPENAI_API_KEY
`);
    // 路由已声明但密钥变量不在环境里
    expect(() => loadConfig({ ...baseEnv, DSH_PROVIDER: 'openai' }, file)).toThrow(/OPENAI_API_KEY/);
    const ok = loadConfig({ ...baseEnv, DSH_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-o' }, file);
    expect(ok.dsh.provider).toBe('openai');
  });

  it('topic.provider 把判定调用收口到声明的路由：凭证与端点都来自 models: 段', () => {
    const file = parseConfigFileText(`
models:
  providers:
    acme:
      api: openai-completions
      baseURL: https://gw.example/v1
      apiKeyEnv: ACME_KEY
topic:
  provider: acme
  model: acme-flash
`);
    const config = loadConfig({ ...baseEnv, ACME_KEY: 'sk-acme' }, file);
    expect(config.topic.provider).toBe('acme');
    expect(config.topic.apiKey).toBe('sk-acme');
    expect(config.topic.apiKeyEnv).toBe('ACME_KEY');
    expect(config.topic.apiBase).toBe('https://gw.example/v1');
    // 写同一份显式 apiBase = 无冲突，允许（等价写法不该报错）
    const same = loadConfig(
      { ...baseEnv, ACME_KEY: 'sk-acme', BOT_TOPIC_API_BASE: 'https://gw.example/v1' },
      file,
    );
    expect(same.topic.apiBase).toBe('https://gw.example/v1');
  });

  it('路由自带 baseURL 时再显式 apiBase（不一致）→ 启动期报错，不静默跨厂商发 key', () => {
    const file = parseConfigFileText(`
models:
  providers:
    acme:
      api: openai-completions
      baseURL: https://gw.example/v1
      apiKeyEnv: ACME_KEY
topic:
  provider: acme
  apiBase: https://api.deepseek.com
`);
    expect(() => loadConfig({ ...baseEnv, ACME_KEY: 'sk-acme' }, file)).toThrow(/显式设置了 topic\.apiBase/);
  });

  it('模态只接受 text / image：video / audio 启动期报错并点名', () => {
    expect(() =>
      parseModelApiSection(parseYaml('providers:\n  acme:\n    models:\n      - id: m\n        input: [text, image, video]'), 'models'),
    ).toThrow(/不认识："video"/);
  });

  it('topic.provider 指向无 baseURL 的路由且没显式 apiBase → 启动期报错', () => {
    const file = parseConfigFileText(`
models:
  providers:
    openai:
      apiKeyEnv: OPENAI_API_KEY
topic:
  provider: openai
`);
    expect(() => loadConfig({ ...baseEnv, OPENAI_API_KEY: 'sk-o' }, file)).toThrow(/没有 baseURL/);
  });

  it('完全不依赖 DeepSeek 的部署：DEEPSEEK_API_KEY 不再必填', () => {
    const file = parseConfigFileText(`
dsh:
  provider: acme
models:
  providers:
    acme:
      api: openai-completions
      baseURL: https://gw.example/v1
      apiKeyEnv: ACME_KEY
topic:
  provider: acme
`);
    // 注意 env 里没有 DEEPSEEK_API_KEY
    const config = loadConfig({ QQ_APP_ID: 'a', QQ_APP_SECRET: 's', ACME_KEY: 'sk-acme' }, file);
    expect(config.dsh.provider).toBe('acme');
    expect(config.topic.apiKey).toBe('sk-acme');
  });

  it('主路由仍是 deepseek-official 时，即使关掉判定也仍需要其凭证变量', () => {
    const file = parseConfigFileText('topic:\n  enabled: false\n');
    expect(() => loadConfig({ QQ_APP_ID: 'a', QQ_APP_SECRET: 's' }, file)).toThrow(/DEEPSEEK_API_KEY/);
    // models.deepseek.apiKeyEnv 改名后按改名的要求
    const renamed = parseConfigFileText('topic:\n  enabled: false\nmodels:\n  deepseek:\n    apiKeyEnv: MY_DS_KEY\n');
    expect(() => loadConfig({ QQ_APP_ID: 'a', QQ_APP_SECRET: 's' }, renamed)).toThrow(/MY_DS_KEY/);
    const ok = loadConfig({ QQ_APP_ID: 'a', QQ_APP_SECRET: 's', MY_DS_KEY: 'k' }, renamed);
    expect(ok.topic.enabled).toBe(false);
    expect(ok.topic.apiKey).toBe(''); // 判定关闭：不硬要求，主动介入降级为"只听不说"
  });

  it('topic.enabled=false 且主路由收口到其他提供商时无任何 DeepSeek 依赖', () => {
    const file = parseConfigFileText(`
dsh:
  provider: acme
models:
  providers:
    acme:
      api: openai-completions
      baseURL: https://gw.example/v1
      apiKeyEnv: ACME_KEY
topic:
  enabled: false
`);
    const config = loadConfig({ QQ_APP_ID: 'a', QQ_APP_SECRET: 's', ACME_KEY: 'k' }, file);
    expect(config.topic.apiKeyEnv).toBe('DEEPSEEK_API_KEY'); // 默认引用，但不强制存在
    expect(config.topic.apiKey).toBe('');
  });

  it('describeConfig 只暴露路由名，不含任何密钥信息', () => {
    const file = parseConfigFileText(`
models:
  deepseek:
    reasoningEffort: max
  providers:
    openai:
      apiKeyEnv: OPENAI_API_KEY
`);
    const config = loadConfig({ ...baseEnv, OPENAI_API_KEY: 'sk-o' }, file);
    const summary = describeConfig(config) as unknown as { modelApi: { deepseek: string; providers: string[] } };
    expect(summary.modelApi.deepseek).toBe('customized');
    expect(summary.modelApi.providers).toEqual(['openai']);
    expect(JSON.stringify(summary)).not.toContain('sk-o');
  });
});
