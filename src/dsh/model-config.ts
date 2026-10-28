/**
 * 模型 API 配置层（配置文件的 `models:` 段；推荐 config/local/models.yml）。
 *
 * 职责：把 DSH 允许的全部"模型提供商"配置能力透传给 dsh 子进程，同时守住
 * qqbot 自己的两条纪律：
 *
 *   1. **密钥绝不进配置文件**：DSH 的凭证模型是 `apiKeyEnv`（环境变量名引用，
 *      按请求解析），本层只允许这种引用形式；`apiKey` / `authToken` 这类内联
 *      密钥键、以及 `Authorization` 等带密钥语义的 header 名，在解析期直接拒绝。
 *   2. **拼错要在启动期炸**：每个层级都拒绝未知键，取值枚举在能确定的地方
 *      就地校验；只有词汇表归 pi-ai 所有的字段（`api` 协议名等）才透传给
 *      DSH 的启动校验去判。
 *
 * 两个路由族（与 DSH base bundle 里已挂载的两个插件一一对应）：
 *
 *   - `models.deepseek` → `- id: llm-deepseek`（`@deepseek-ai/dsh-llm-deepseek-api-key`，
 *     原生 DeepSeek 路由 `deepseek-official`）；
 *   - `models.providers.<路由名>` → `- id: llm-pi-ai` 的 `providers` 字典
 *     （`@deepseek-ai/dsh-llm-pi-ai`，pi-ai 多提供商适配器；目录内路由如 openai /
 *     anthropic 只需补 `apiKeyEnv`，目录外的自建网关必须给 `api` + `baseURL` +
 *     非空 `models`）。
 *
 * 产出物是一份**生成的 patch 文件**（`writeModelApiPatch`），在启动时作为第二个
 * `--patch` 叠加在 dsh-profile/cordis.patch.yml 之后——dsh CLI 的 `--patch` 可重复、
 * 按 argv 顺序应用，所以不需要改动随镜像提供的 profile patch。
 *
 * 字段语义以 DSH 的配置目录为准（docs/config-catalog.md 的
 * `@deepseek-ai/dsh-llm-deepseek-api-key` 与 `@deepseek-ai/dsh-llm-pi-ai` 两节）；
 * 本模块的注释只记 qqbot 侧加的约束，不复述 DSH 的字段文档。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { ConfigError } from '../config-error.js';

// ---------------------------------------------------------------------------
// 类型（与 DSH 配置面一一对应；全部可选，缺省 = 用 DSH 自己的默认）
// ---------------------------------------------------------------------------

/** 重试退避（dsh-llm 的 BackoffConfig）。 */
export interface RetryBackoffConfig {
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** 围绕 1 的对称随机抖动幅度（0–1） */
  jitterRatio?: number;
}

/**
 * 提供商级重试策略（dsh-llm 的 RetryPolicyConfig）。
 * normal = 只重试可重试错误码，有次数上限；always = 直到成功/取消/关闭。
 */
export interface RetryPolicyConfig {
  mode: 'normal' | 'always';
  /** 仅 normal：首次请求之后最多再试几次（默认 5） */
  maxRetries?: number;
  /** 仅 normal：可重试的稳定错误码列表 */
  retryableCodes?: string[];
  backoff?: RetryBackoffConfig;
}

/** 原生 DeepSeek 路由的目录条目（llm-deepseek 的 catalogModel）。 */
export interface DeepSeekCatalogModelConfig {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** 该模型接受的请求模态（llm-deepseek 只认 text / image） */
  inputModalities?: Array<'text' | 'image'>;
  imagePixelBudget?: number | 'low';
  imageMaxBytes?: number;
  systemPromptUpdate?: 'in-history';
  toolUpdate?: 'in-history' | 'addition-only';
}

/**
 * 原生 DeepSeek 路由（`deepseek-official`）的配置，对应
 * `@deepseek-ai/dsh-llm-deepseek-api-key` 的 Config（= llm-deepseek 的
 * ProtocolConfig + `apiKeyEnv`）。
 */
export interface DeepSeekRouteConfig {
  /** 凭证引用（环境变量名），默认 DEEPSEEK_API_KEY；按请求解析 */
  apiKeyEnv?: string;
  /** Messages 端点基址；缺省读 $DEEPSEEK_BASE_URL，再退到官方公开 API */
  baseURL?: string;
  /** 部署级 thinking 策略；disabled = 所有请求强制 off */
  thinking?: 'enabled' | 'disabled';
  /** 默认 thinking 档位（默认 high） */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max';
  /** 每次请求的输出上限默认值（模型自己的上限与显式请求值优先） */
  maxTokens?: number;
  /** 模型无精确值时的上下文容量兜底 */
  defaultContextWindow?: number;
  /** 该路由的模型目录（整份替换默认目录） */
  models?: DeepSeekCatalogModelConfig[];
  streamIdleTimeoutMs?: number;
  maxRequestFilesBytes?: number;
  maxInlineRequestImageBytes?: number;
  maxImagesPerRequest?: number;
  imageOffloadByteQuantum?: number;
  inlineImageOffloadByteQuantum?: number;
  imageOffloadCountQuantum?: number;
  filesApiTimeoutMs?: number;
  fileExpiresAfterSeconds?: number;
  fileRefreshMarginSeconds?: number;
  fileQuotaCleanupBatch?: number;
  retryPolicy?: RetryPolicyConfig;
}

/** pi-ai 的思考档位（ModelThinkingLevel）。 */
export type PiAiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * 可选思考档位表：键是选择面提供的档位，值是发到线上的拼写；
 * `off` 的值可以为 null（"不思考"对多数提供商就是参数缺省）。
 */
export type PiAiReasoningEfforts = Partial<Record<PiAiThinkingLevel, string | null>>;

/**
 * pi-ai 线兼容开关（PiAiCompatProfile）。逐字段语义见 DSH 配置目录；
 * 这里只做形状与取值校验，是否适用于路由上模型的协议由 DSH 启动校验判定。
 */
export interface PiAiCompatConfig {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsFinishReason?: boolean;
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?:
    | 'openai'
    | 'openrouter'
    | 'deepseek'
    | 'together'
    | 'baseten'
    | 'zai'
    | 'qwen'
    | 'chat-template'
    | 'qwen-chat-template'
    | 'string-thinking'
    | 'ant-ling';
  chatTemplateKwargs?: Record<string, PiAiTemplateArg>;
  chatTemplateArgs?: Record<string, PiAiTemplateArg>;
  supportsThinkingTokenBudget?: boolean;
  thinkingTokenBudgetField?: 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens';
  vllmPriority?: number;
  supportsMaxOutputTokens?: boolean;
  supportsStrictMode?: boolean;
  cacheControlFormat?: 'anthropic';
  supportsLongCacheRetention?: boolean;
  supportsEagerToolInputStreaming?: boolean;
  supportsCacheControlOnTools?: boolean;
  supportsTemperature?: boolean;
  forceAdaptiveThinking?: boolean;
  allowEmptySignature?: boolean;
  supportsStrictTools?: boolean;
}

/** chat_template_kwargs / args 的取值：字面量或 pi 控制的 $var 引用。 */
export type PiAiTemplateArg =
  | string
  | number
  | boolean
  | null
  | { $var: 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean };

/** pi-ai 路由上的一个模型条目（PiAiModelProfile）。 */
export interface PiAiModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  /** 配了它同时也是该模型的每请求默认输出上限 */
  maxTokens?: number;
  /** 该模型接受的请求模态；缺省继承目录条目，再退到路由的 defaultInput */
  input?: Array<'text' | 'image'>;
  /** false = 声明该模型不思考；字典 = 可选档位与线上拼写 */
  reasoningEfforts?: false | PiAiReasoningEfforts;
  compat?: PiAiCompatConfig;
}

/** modelOverrides 的条目：与 PiAiModelConfig 同字段，id 由字典键提供。 */
export type PiAiModelOverride = Omit<PiAiModelConfig, 'id'>;

/** 思考档位对应的 token 预算（支持预算的推理提供商用）。 */
export interface PiAiThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

/** 一条 pi-ai 提供商路由（PiAiProviderProfile）；`providers` 字典的键就是路由名。 */
export interface PiAiProviderConfig {
  /** 凭证引用（环境变量名），按请求经 DSH 凭证缝解析；缺省走 pi-ai 环境发现 */
  apiKeyEnv?: string;
  displayName?: string;
  /** 线上协议；目录内路由可省略，目录外路由必填（如 openai-completions） */
  api?: string;
  baseURL?: string;
  /** 整份替换该路由的目录；目录外路由必须非空 */
  models?: PiAiModelConfig[];
  /** 只改目录内个别模型（与 models 互斥，且仅目录内路由可用） */
  modelOverrides?: Record<string, PiAiModelOverride>;
  compat?: PiAiCompatConfig;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
  defaultInput?: Array<'text' | 'image'>;
  /** 提供商请求头；带密钥语义的名称（Authorization 等）被拒，见 SECRET_HEADER_NAMES */
  headers?: Record<string, string>;
  reasoning?: PiAiThinkingLevel;
  thinkingBudgets?: PiAiThinkingBudgets;
  cacheRetention?: 'none' | 'short' | 'long';
  transport?: 'sse' | 'websocket' | 'websocket-cached' | 'auto';
  timeoutMs?: number;
  websocketConnectTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxRequestImageBytes?: number;
  requestImagePixelBudget?: number;
  requestImageMaxBytes?: number;
  retryPolicy?: RetryPolicyConfig;
}

/** 配置文件 `models:` 段解析后的形状（也是 Config.modelApi 的类型）。 */
export interface ModelApiConfig {
  /** 原生 DeepSeek 路由（provider = deepseek-official）的配置 */
  deepseek?: DeepSeekRouteConfig;
  /** pi-ai 多提供商路由，键即 provider 路由名 */
  providers: Record<string, PiAiProviderConfig>;
}

/** 原生 DeepSeek 路由名（llm-deepseek-api-key 插件注册的路由）。 */
export const DEEPSEEK_OFFICIAL_PROVIDER = 'deepseek-official';

/**
 * qqbot 不能占用的路由名：这两个由 base bundle 的原生插件注册，
 * 在 llm-pi-ai 的 providers 里同名声明会让插件加载直接失败
 * （"registering a route another adapter already owns fails plugin loading"）。
 */
const RESERVED_PROVIDER_IDS = new Set([DEEPSEEK_OFFICIAL_PROVIDER, 'deepseek-account']);

/**
 * 路由名语法：小写连字符标识符。与 DSH 凭证记录语法对齐（超出该语法的自建路由
 * 无法走凭证存储登录，只能 apiKeyEnv——qqbot 场景本来也只支持 apiKeyEnv，
 * 干脆在解析期就限死，免得配出一个"能跑但不能管"的路由）。
 */
const PROVIDER_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 环境变量名语法（apiKeyEnv 是引用，不是值）。 */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 带密钥语义、因此禁止出现在 headers 里的 header 名（大小写不敏感）。
 * 这些头的值就是凭证本身，写进配置文件违反"密钥不进配置文件"的纪律；
 * 正确做法是用 apiKeyEnv 让适配器自己带上认证头。
 */
const SECRET_HEADER_NAMES = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token)$/i;

/**
 * models: 段任何层级都不允许出现的键（内联密钥）。
 * DSH 自己的配置源校验也拒绝这些键的内联值（verify-config-source-ownership 的
 * INLINE_DENY），qqbot 在配置解析期就拒，报错离出错行更近。
 */
const FORBIDDEN_SECRET_KEYS = new Set(['apikey', 'authtoken', 'apisecret', 'secretkey', 'password', 'token']);

// ---------------------------------------------------------------------------
// 形状校验小工具（与 config-file.ts 同款风格：报错带 YAML 路径与可照做的提示）
// ---------------------------------------------------------------------------

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `数组 [${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  if (isPlainObject(value)) return `映射 {${Object.keys(value).join(', ')}}`;
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) {
      throw new ConfigError(`${path}.${key} 是内联密钥写法，配置层不接受`, [
        '密钥只允许以"环境变量名引用"的形式出现：用 apiKeyEnv: <变量名>，变量值写在 .env 里',
        '配置文件会随仓库提交或进入本机配置，内联密钥都可能泄露',
      ]);
    }
    if (!allowed.includes(key)) {
      throw new ConfigError(`${path}.${key} 不是可识别的配置项`, [`可用项：${allowed.join('、')}`]);
    }
  }
}

function readString(raw: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${path}.${key} 必须是非空字符串，收到 ${describeValue(value)}`);
  }
  return value;
}

function readInt(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  range: { min: number; max?: number },
): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ConfigError(`${path}.${key} 必须是整数，收到 ${describeValue(value)}`, [
      'YAML 里直接写数字，不要加引号',
    ]);
  }
  if (value < range.min || (range.max !== undefined && value > range.max)) {
    const span = range.max === undefined ? `≥ ${range.min}` : `在 [${range.min}, ${range.max}] 之间`;
    throw new ConfigError(`${path}.${key} 必须${span}，收到 ${value}`);
  }
  return value;
}

function readBool(raw: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${path}.${key} 必须是 true / false，收到 ${describeValue(value)}`);
  }
  return value;
}

function readEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
): T | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ConfigError(`${path}.${key} 只能是 ${allowed.join(' | ')}，收到 ${describeValue(value)}`);
  }
  return value as T;
}

function readStringList(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): string[] | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ConfigError(`${path}.${key} 必须是字符串数组，收到 ${describeValue(value)}`);
  }
  return value as string[];
}

const MODALITIES = ['text', 'image'] as const;

function readModalities(raw: Record<string, unknown>, key: string, path: string): Array<'text' | 'image'> | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || !(MODALITIES as readonly string[]).includes(item))
  ) {
    throw new ConfigError(`${path}.${key} 必须是非空的模态数组，收到 ${describeValue(value)}`, [
      '可用值：text、image（本桥接层只会向模型发送文本与图片两种块）',
    ]);
  }
  return [...new Set(value as Array<'text' | 'image'>)];
}

// ---------------------------------------------------------------------------
// retryPolicy / compat / 模型条目
// ---------------------------------------------------------------------------

const RETRY_POLICY_KEYS = ['mode', 'maxRetries', 'retryableCodes', 'backoff'] as const;
const RETRY_BACKOFF_KEYS = ['initialDelayMs', 'maxDelayMs', 'jitterRatio'] as const;

function readRetryPolicy(raw: unknown, path: string): RetryPolicyConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} 必须是映射（key: value），收到 ${describeValue(raw)}`);
  }
  assertNoUnknownKeys(raw, RETRY_POLICY_KEYS, path);
  const mode = readEnum(raw, 'mode', path, ['normal', 'always'] as const);
  if (mode === undefined) {
    throw new ConfigError(`${path}.mode 是必填项`, ['取值：normal（有界重试）| always（直到成功/取消）']);
  }
  const policy: RetryPolicyConfig = { mode };
  if (mode === 'normal') {
    policy.maxRetries = readInt(raw, 'maxRetries', path, { min: 0 });
    policy.retryableCodes = readStringList(raw, 'retryableCodes', path);
  } else if (raw['maxRetries'] !== undefined || raw['retryableCodes'] !== undefined) {
    throw new ConfigError(`${path}：mode: always 不接受 maxRetries / retryableCodes`, [
      'always 模式对每个失败都重试，这两个键只在 mode: normal 下有意义',
    ]);
  }
  const backoffRaw = raw['backoff'];
  if (backoffRaw !== undefined && backoffRaw !== null) {
    if (!isPlainObject(backoffRaw)) {
      throw new ConfigError(`${path}.backoff 必须是映射，收到 ${describeValue(backoffRaw)}`);
    }
    assertNoUnknownKeys(backoffRaw, RETRY_BACKOFF_KEYS, `${path}.backoff`);
    const backoff: RetryBackoffConfig = {};
    backoff.initialDelayMs = readInt(backoffRaw, 'initialDelayMs', `${path}.backoff`, { min: 0 });
    backoff.maxDelayMs = readInt(backoffRaw, 'maxDelayMs', `${path}.backoff`, { min: 0 });
    const jitterRaw = backoffRaw['jitterRatio'];
    if (jitterRaw !== undefined && jitterRaw !== null) {
      if (typeof jitterRaw !== 'number' || jitterRaw < 0 || jitterRaw > 1) {
        throw new ConfigError(`${path}.backoff.jitterRatio 必须是 [0, 1] 之间的数字，收到 ${describeValue(jitterRaw)}`);
      }
      backoff.jitterRatio = jitterRaw;
    }
    policy.backoff = backoff;
  }
  return policy;
}

const COMPAT_BOOL_KEYS = [
  'supportsStore',
  'supportsDeveloperRole',
  'supportsReasoningEffort',
  'supportsUsageInStreaming',
  'supportsFinishReason',
  'requiresToolResultName',
  'requiresAssistantAfterToolResult',
  'requiresThinkingAsText',
  'requiresReasoningContentOnAssistantMessages',
  'supportsThinkingTokenBudget',
  'supportsMaxOutputTokens',
  'supportsStrictMode',
  'supportsLongCacheRetention',
  'supportsEagerToolInputStreaming',
  'supportsCacheControlOnTools',
  'supportsTemperature',
  'forceAdaptiveThinking',
  'allowEmptySignature',
  'supportsStrictTools',
] as const;

const COMPAT_KEYS = [
  ...COMPAT_BOOL_KEYS,
  'maxTokensField',
  'thinkingFormat',
  'chatTemplateKwargs',
  'chatTemplateArgs',
  'thinkingTokenBudgetField',
  'vllmPriority',
  'cacheControlFormat',
] as const;

const THINKING_FORMATS = [
  'openai',
  'openrouter',
  'deepseek',
  'together',
  'baseten',
  'zai',
  'qwen',
  'chat-template',
  'qwen-chat-template',
  'string-thinking',
  'ant-ling',
] as const;

const TEMPLATE_VARS = ['thinking.enabled', 'thinking.effort', 'thinking.budget'] as const;

function readTemplateArgs(raw: unknown, path: string): Record<string, PiAiTemplateArg> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} 必须是映射，收到 ${describeValue(raw)}`);
  }
  const out: Record<string, PiAiTemplateArg> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = value as PiAiTemplateArg;
      continue;
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      const varName = value['$var'];
      const omitWhenOff = value['omitWhenOff'];
      if (
        keys.every((k) => k === '$var' || k === 'omitWhenOff') &&
        typeof varName === 'string' &&
        (TEMPLATE_VARS as readonly string[]).includes(varName) &&
        (omitWhenOff === undefined || typeof omitWhenOff === 'boolean')
      ) {
        out[key] = {
          $var: varName as (typeof TEMPLATE_VARS)[number],
          ...(omitWhenOff === undefined ? {} : { omitWhenOff }),
        };
        continue;
      }
    }
    throw new ConfigError(`${path}.${key} 取值非法：${describeValue(value)}`, [
      '允许字符串 / 数字 / 布尔 / null，或 $var 引用：{ $var: thinking.enabled | thinking.effort | thinking.budget, omitWhenOff?: bool }',
    ]);
  }
  return out;
}

function readCompat(raw: unknown, path: string): PiAiCompatConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} 必须是映射（key: value），收到 ${describeValue(raw)}`);
  }
  assertNoUnknownKeys(raw, COMPAT_KEYS, path);
  const compat: PiAiCompatConfig = {};
  for (const key of COMPAT_BOOL_KEYS) {
    const value = readBool(raw, key, path);
    if (value !== undefined) (compat as Record<string, unknown>)[key] = value;
  }
  compat.maxTokensField = readEnum(raw, 'maxTokensField', path, ['max_completion_tokens', 'max_tokens'] as const);
  compat.thinkingFormat = readEnum(raw, 'thinkingFormat', path, THINKING_FORMATS);
  compat.thinkingTokenBudgetField = readEnum(raw, 'thinkingTokenBudgetField', path, [
    'thinking_token_budget',
    'thinking_budget',
    'thinking_budget_tokens',
  ] as const);
  compat.cacheControlFormat = readEnum(raw, 'cacheControlFormat', path, ['anthropic'] as const);
  compat.vllmPriority = readInt(raw, 'vllmPriority', path, { min: 0 });
  compat.chatTemplateKwargs = readTemplateArgs(raw['chatTemplateKwargs'], `${path}.chatTemplateKwargs`);
  compat.chatTemplateArgs = readTemplateArgs(raw['chatTemplateArgs'], `${path}.chatTemplateArgs`);
  return compat;
}

const PI_AI_MODEL_KEYS = ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'] as const;
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function readReasoningEfforts(raw: unknown, path: string): false | PiAiReasoningEfforts | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === false) return false;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} 必须是 false 或映射（档位: 线上拼写），收到 ${describeValue(raw)}`);
  }
  const out: PiAiReasoningEfforts = {};
  for (const [level, wire] of Object.entries(raw)) {
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
      throw new ConfigError(`${path}.${level} 不是可识别的思考档位`, [
        `可用档位：${THINKING_LEVELS.join('、')}`,
      ]);
    }
    if (wire !== null && typeof wire !== 'string') {
      throw new ConfigError(`${path}.${level} 的值必须是字符串或 null，收到 ${describeValue(wire)}`);
    }
    if (level !== 'off' && (wire === null || wire === '')) {
      throw new ConfigError(`${path}.${level} 必须给出线上拼写`, [
        '只有 off 档可以为空（"不思考"对多数提供商就是参数缺省）；其他档位必须写明发到什么值',
      ]);
    }
    out[level as PiAiThinkingLevel] = wire;
  }
  return out;
}

/** 读一个 pi-ai 模型条目；`idInKey` 为 true 时是 modelOverrides 条目（id 由键提供，条目里不许再写）。 */
function readPiAiModel(raw: unknown, path: string, idInKey: boolean): PiAiModelConfig | PiAiModelOverride {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} 必须是映射（key: value），收到 ${describeValue(raw)}`);
  }
  assertNoUnknownKeys(raw, PI_AI_MODEL_KEYS, path);
  const id = readString(raw, 'id', path);
  if (!idInKey && id === undefined) {
    throw new ConfigError(`${path}.id 是必填项`, ['每个模型条目都必须有 id（发给提供商的模型标识）']);
  }
  if (idInKey && id !== undefined) {
    throw new ConfigError(`${path}.id 不该出现在 modelOverrides 条目里`, [
      'modelOverrides 的模型 id 由字典键提供：modelOverrides: { <模型id>: { ... } }',
    ]);
  }
  const shared = stripUndefined({
    name: readString(raw, 'name', path),
    contextWindow: readInt(raw, 'contextWindow', path, { min: 1 }),
    maxTokens: readInt(raw, 'maxTokens', path, { min: 1 }),
    input: readModalities(raw, 'input', path),
    reasoningEfforts: readReasoningEfforts(raw['reasoningEfforts'], `${path}.reasoningEfforts`),
    compat: readCompat(raw['compat'], `${path}.compat`),
  });
  return idInKey ? shared : { id: id as string, ...shared };
}

// ---------------------------------------------------------------------------
// deepseek 路由
// ---------------------------------------------------------------------------

const DEEPSEEK_ROUTE_KEYS = [
  'apiKeyEnv',
  'baseURL',
  'thinking',
  'reasoningEffort',
  'maxTokens',
  'defaultContextWindow',
  'models',
  'streamIdleTimeoutMs',
  'maxRequestFilesBytes',
  'maxInlineRequestImageBytes',
  'maxImagesPerRequest',
  'imageOffloadByteQuantum',
  'inlineImageOffloadByteQuantum',
  'imageOffloadCountQuantum',
  'filesApiTimeoutMs',
  'fileExpiresAfterSeconds',
  'fileRefreshMarginSeconds',
  'fileQuotaCleanupBatch',
  'retryPolicy',
] as const;

const DEEPSEEK_MODEL_KEYS = [
  'id',
  'name',
  'description',
  'contextWindow',
  'maxTokens',
  'inputModalities',
  'imagePixelBudget',
  'imageMaxBytes',
  'systemPromptUpdate',
  'toolUpdate',
] as const;

function readDeepSeekCatalogModel(raw: unknown, path: string): DeepSeekCatalogModelConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} 必须是映射（key: value），收到 ${describeValue(raw)}`);
  }
  assertNoUnknownKeys(raw, DEEPSEEK_MODEL_KEYS, path);
  const id = readString(raw, 'id', path);
  if (id === undefined) {
    throw new ConfigError(`${path}.id 是必填项`, ['目录条目必须带模型 id']);
  }
  const imagePixelBudgetRaw = raw['imagePixelBudget'];
  let imagePixelBudget: number | 'low' | undefined;
  if (imagePixelBudgetRaw !== undefined && imagePixelBudgetRaw !== null) {
    if (imagePixelBudgetRaw === 'low') {
      imagePixelBudget = 'low';
    } else if (typeof imagePixelBudgetRaw === 'number' && Number.isInteger(imagePixelBudgetRaw) && imagePixelBudgetRaw >= 1) {
      imagePixelBudget = imagePixelBudgetRaw;
    } else {
      throw new ConfigError(`${path}.imagePixelBudget 必须是正整数或 "low"，收到 ${describeValue(imagePixelBudgetRaw)}`);
    }
  }
  return stripUndefined({
    id,
    name: readString(raw, 'name', path),
    description: readString(raw, 'description', path),
    contextWindow: readInt(raw, 'contextWindow', path, { min: 1 }),
    maxTokens: readInt(raw, 'maxTokens', path, { min: 1 }),
    inputModalities: readModalities(raw, 'inputModalities', path),
    imagePixelBudget,
    imageMaxBytes: readInt(raw, 'imageMaxBytes', path, { min: 1 }),
    systemPromptUpdate: readEnum(raw, 'systemPromptUpdate', path, ['in-history'] as const),
    toolUpdate: readEnum(raw, 'toolUpdate', path, ['in-history', 'addition-only'] as const),
  });
}

function readDeepSeekRoute(raw: unknown, path: string): DeepSeekRouteConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} 必须是映射（key: value），收到 ${describeValue(raw)}`);
  }
  assertNoUnknownKeys(raw, DEEPSEEK_ROUTE_KEYS, path);
  const modelsRaw = raw['models'];
  let models: DeepSeekCatalogModelConfig[] | undefined;
  if (modelsRaw !== undefined && modelsRaw !== null) {
    if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
      throw new ConfigError(`${path}.models 必须是非空数组（整份替换默认目录），收到 ${describeValue(modelsRaw)}`);
    }
    models = modelsRaw.map((entry, index) => readDeepSeekCatalogModel(entry, `${path}.models[${index}]`));
  }
  return stripUndefined({
    apiKeyEnv: readApiKeyEnv(raw, path),
    baseURL: readString(raw, 'baseURL', path),
    thinking: readEnum(raw, 'thinking', path, ['enabled', 'disabled'] as const),
    reasoningEffort: readEnum(raw, 'reasoningEffort', path, ['off', 'low', 'high', 'max'] as const),
    maxTokens: readInt(raw, 'maxTokens', path, { min: 1 }),
    defaultContextWindow: readInt(raw, 'defaultContextWindow', path, { min: 1 }),
    models,
    streamIdleTimeoutMs: readInt(raw, 'streamIdleTimeoutMs', path, { min: 1 }),
    maxRequestFilesBytes: readInt(raw, 'maxRequestFilesBytes', path, { min: 1 }),
    maxInlineRequestImageBytes: readInt(raw, 'maxInlineRequestImageBytes', path, { min: 1 }),
    maxImagesPerRequest: readInt(raw, 'maxImagesPerRequest', path, { min: 1 }),
    imageOffloadByteQuantum: readInt(raw, 'imageOffloadByteQuantum', path, { min: 1 }),
    inlineImageOffloadByteQuantum: readInt(raw, 'inlineImageOffloadByteQuantum', path, { min: 1 }),
    imageOffloadCountQuantum: readInt(raw, 'imageOffloadCountQuantum', path, { min: 1 }),
    filesApiTimeoutMs: readInt(raw, 'filesApiTimeoutMs', path, { min: 1 }),
    // 与 llm-deepseek 的 schema 同界：1 小时到 30 天
    fileExpiresAfterSeconds: readInt(raw, 'fileExpiresAfterSeconds', path, { min: 3_600, max: 2_592_000 }),
    fileRefreshMarginSeconds: readInt(raw, 'fileRefreshMarginSeconds', path, { min: 0 }),
    fileQuotaCleanupBatch: readInt(raw, 'fileQuotaCleanupBatch', path, { min: 1, max: 1_000 }),
    retryPolicy: readRetryPolicy(raw['retryPolicy'], `${path}.retryPolicy`),
  });
}

// ---------------------------------------------------------------------------
// pi-ai 路由
// ---------------------------------------------------------------------------

const PI_AI_PROVIDER_KEYS = [
  'apiKeyEnv',
  'displayName',
  'api',
  'baseURL',
  'models',
  'modelOverrides',
  'compat',
  'defaultContextWindow',
  'defaultMaxTokens',
  'defaultInput',
  'headers',
  'reasoning',
  'thinkingBudgets',
  'cacheRetention',
  'transport',
  'timeoutMs',
  'websocketConnectTimeoutMs',
  'streamIdleTimeoutMs',
  'maxRequestImageBytes',
  'requestImagePixelBudget',
  'requestImageMaxBytes',
  'retryPolicy',
] as const;

function readApiKeyEnv(raw: Record<string, unknown>, path: string): string | undefined {
  const value = readString(raw, 'apiKeyEnv', path);
  if (value !== undefined && !ENV_NAME_PATTERN.test(value)) {
    throw new ConfigError(`${path}.apiKeyEnv 必须是合法的环境变量名，收到 ${JSON.stringify(value)}`, [
      '它是"变量名引用"而不是密钥本身：写 apiKeyEnv: OPENAI_API_KEY，把值放进 .env',
    ]);
  }
  return value;
}

function readHeaders(raw: unknown, path: string): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} 必须是映射（头名: 值），收到 ${describeValue(raw)}`);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (SECRET_HEADER_NAMES.test(name)) {
      throw new ConfigError(`${path}.${name} 是带密钥语义的头，不允许写在配置文件里`, [
        '认证头由适配器根据 apiKeyEnv 自动携带；把密钥写进 header 等于把密钥写进仓库',
      ]);
    }
    if (typeof value !== 'string') {
      throw new ConfigError(`${path}.${name} 的值必须是字符串，收到 ${describeValue(value)}`);
    }
    out[name] = value;
  }
  return out;
}

function readThinkingBudgets(raw: unknown, path: string): PiAiThinkingBudgets | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} 必须是映射（档位: token 预算），收到 ${describeValue(raw)}`);
  }
  const allowed = ['minimal', 'low', 'medium', 'high'] as const;
  assertNoUnknownKeys(raw, allowed, path);
  const out: PiAiThinkingBudgets = {};
  for (const key of allowed) {
    const value = readInt(raw, key, path, { min: 1 });
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function readPiAiProvider(raw: unknown, path: string): PiAiProviderConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} 必须是映射（key: value），收到 ${describeValue(raw)}`);
  }
  assertNoUnknownKeys(raw, PI_AI_PROVIDER_KEYS, path);

  const modelsRaw = raw['models'];
  let models: PiAiModelConfig[] | undefined;
  if (modelsRaw !== undefined && modelsRaw !== null) {
    if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
      throw new ConfigError(`${path}.models 必须是非空数组（整份替换目录），收到 ${describeValue(modelsRaw)}`);
    }
    models = modelsRaw.map((entry, index) => readPiAiModel(entry, `${path}.models[${index}]`, false) as PiAiModelConfig);
  }

  const overridesRaw = raw['modelOverrides'];
  let modelOverrides: Record<string, PiAiModelOverride> | undefined;
  if (overridesRaw !== undefined && overridesRaw !== null) {
    if (!isPlainObject(overridesRaw) || Object.keys(overridesRaw).length === 0) {
      throw new ConfigError(`${path}.modelOverrides 必须是非空映射（模型 id: 覆写项），收到 ${describeValue(overridesRaw)}`);
    }
    modelOverrides = {};
    for (const [modelId, entry] of Object.entries(overridesRaw)) {
      modelOverrides[modelId] = readPiAiModel(entry, `${path}.modelOverrides.${modelId}`, true) as PiAiModelOverride;
    }
  }
  // DSH 侧的同一条规则：models 已经整份替换目录，再配覆写必有一个被静默忽略
  if (models !== undefined && modelOverrides !== undefined) {
    throw new ConfigError(`${path} 不能同时配 models 与 modelOverrides`, [
      'models 是整份替换目录；modelOverrides 是只改目录内个别模型——二者互斥',
    ]);
  }

  return stripUndefined({
    apiKeyEnv: readApiKeyEnv(raw, path),
    displayName: readString(raw, 'displayName', path),
    api: readString(raw, 'api', path),
    baseURL: readString(raw, 'baseURL', path),
    models,
    modelOverrides,
    compat: readCompat(raw['compat'], `${path}.compat`),
    defaultContextWindow: readInt(raw, 'defaultContextWindow', path, { min: 1 }),
    defaultMaxTokens: readInt(raw, 'defaultMaxTokens', path, { min: 1 }),
    defaultInput: readModalities(raw, 'defaultInput', path),
    headers: readHeaders(raw['headers'], `${path}.headers`),
    reasoning: readEnum(raw, 'reasoning', path, THINKING_LEVELS),
    thinkingBudgets: readThinkingBudgets(raw['thinkingBudgets'], `${path}.thinkingBudgets`),
    cacheRetention: readEnum(raw, 'cacheRetention', path, ['none', 'short', 'long'] as const),
    transport: readEnum(raw, 'transport', path, ['sse', 'websocket', 'websocket-cached', 'auto'] as const),
    timeoutMs: readInt(raw, 'timeoutMs', path, { min: 1 }),
    websocketConnectTimeoutMs: readInt(raw, 'websocketConnectTimeoutMs', path, { min: 1 }),
    streamIdleTimeoutMs: readInt(raw, 'streamIdleTimeoutMs', path, { min: 1 }),
    maxRequestImageBytes: readInt(raw, 'maxRequestImageBytes', path, { min: 1 }),
    requestImagePixelBudget: readInt(raw, 'requestImagePixelBudget', path, { min: 1 }),
    requestImageMaxBytes: readInt(raw, 'requestImageMaxBytes', path, { min: 1 }),
    retryPolicy: readRetryPolicy(raw['retryPolicy'], `${path}.retryPolicy`),
  });
}

// ---------------------------------------------------------------------------
// 顶层解析
// ---------------------------------------------------------------------------

/**
 * 解析配置文件的 `models:` 段（纯函数，供 config-file.ts 调用）。
 *
 * 只做形状/类型/取值校验与密钥卫生；语义校验（选中的 provider 是否已声明、
 * apiKeyEnv 引用的变量是否存在）在 config.ts 合并完 env 之后做。
 */
export function parseModelApiSection(raw: unknown, path: string): ModelApiConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} 必须是映射（key: value），收到 ${describeValue(raw)}`);
  }
  assertNoUnknownKeys(raw, ['deepseek', 'providers'], path);

  const deepseekRaw = raw['deepseek'];
  const deepseek = deepseekRaw === undefined || deepseekRaw === null
    ? undefined
    : readDeepSeekRoute(deepseekRaw, `${path}.deepseek`);

  const providersRaw = raw['providers'];
  const providers: Record<string, PiAiProviderConfig> = {};
  if (providersRaw !== undefined && providersRaw !== null) {
    if (!isPlainObject(providersRaw)) {
      throw new ConfigError(`${path}.providers 必须是映射（路由名: 路由配置），收到 ${describeValue(providersRaw)}`);
    }
    for (const [id, entry] of Object.entries(providersRaw)) {
      if (!PROVIDER_ID_PATTERN.test(id)) {
        throw new ConfigError(`${path}.providers.${id}：路由名必须是小写连字符标识符`, [
          '正确示例：openai、anthropic、acme-gateway（小写字母/数字/中划线，不以中划线开头结尾）',
        ]);
      }
      if (RESERVED_PROVIDER_IDS.has(id)) {
        throw new ConfigError(`${path}.providers.${id}：路由名 ${id} 已被 DSH 原生插件占用`, [
          id === DEEPSEEK_OFFICIAL_PROVIDER
            ? '原生 DeepSeek 路由请配置在 models.deepseek 下'
            : 'deepseek-account 是账号登录路由，qqbot 场景不可用',
        ]);
      }
      providers[id] = readPiAiProvider(entry, `${path}.providers.${id}`);
    }
  }

  if (deepseek === undefined && Object.keys(providers).length === 0) {
    throw new ConfigError(`${path} 段不能为空`, [
      '至少配置 models.deepseek 或 models.providers 中的一项；不需要自定义就把整段删掉',
    ]);
  }
  return { ...(deepseek === undefined ? {} : { deepseek }), providers };
}

// ---------------------------------------------------------------------------
// 语义校验（config.ts 在合并完 env 之后调用）
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

/**
 * 合并后的语义校验：
 *   1. `dsh.provider` 选中的路由必须真实存在（原生 deepseek-official，或
 *      models.providers 里声明过的 pi-ai 路由）——否则 runtime 每次 initialize
 *      才报 UNKNOWN_MODEL/未知 provider，把配置错误拖成运行期故障；
 *   2. 每个 apiKeyEnv 引用的环境变量必须在进程环境里非空——dsh 子进程继承本进程
 *      环境（src/dsh/process.ts），缺了它 DSH 会在首次请求时以 MISSING_CREDENTIAL
 *      失败，同样该在启动期就拦住。
 */
export function assertModelApiConfig(modelApi: ModelApiConfig, selectedProvider: string, env: Env): void {
  const declaredRoutes = Object.keys(modelApi.providers);
  if (selectedProvider !== DEEPSEEK_OFFICIAL_PROVIDER && !declaredRoutes.includes(selectedProvider)) {
    throw new ConfigError(
      `dsh.provider 选中的提供商 ${JSON.stringify(selectedProvider)} 没有对应的模型路由配置`, [
        `可用路由：${[DEEPSEEK_OFFICIAL_PROVIDER, ...declaredRoutes].join('、')}`,
        `在 config/local/models.yml（或声明 models 的模块）的 models.providers.${selectedProvider} 下声明它，或把 dsh.provider 改回已声明的路由`,
      ],
    );
  }
  const refs: Array<{ route: string; envName: string }> = [];
  if (modelApi.deepseek?.apiKeyEnv !== undefined) {
    refs.push({ route: DEEPSEEK_OFFICIAL_PROVIDER, envName: modelApi.deepseek.apiKeyEnv });
  }
  for (const [id, provider] of Object.entries(modelApi.providers)) {
    if (provider.apiKeyEnv !== undefined) refs.push({ route: id, envName: provider.apiKeyEnv });
  }
  for (const { route, envName } of refs) {
    const value = env[envName];
    if (value === undefined || value.trim() === '') {
      throw new ConfigError(`模型路由 ${route} 引用的凭证变量 ${envName} 在环境中不存在`, [
        `在 .env 里加一行：${envName}=<密钥>（.env 会整份注入容器，dsh 子进程继承本进程环境）`,
        'apiKeyEnv 是按请求解析的引用；也可以删掉该键让 pi-ai 走自己的环境发现（qqbot 容器内通常没有可用来源）',
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// 辅助调用（不经 DSH 的直调：话题判定 / 主动介入判定）的路由解析
// ---------------------------------------------------------------------------

/**
 * 一条路由给"辅助调用"提供的东西：凭证引用 + chat-completions 端点。
 *
 * 判定客户端（pipeline/topic-judge.ts、proactive/judge/chat-client.ts）只会说
 * OpenAI 兼容的 `/chat/completions`——这是它自己能成立的前提，所以：
 *   - 显式声明了 `api` 且不是 openai-completions 的路由，解析期拒绝；
 *   - 路由没给 baseURL 时返回 undefined，由调用方决定是否还有显式 apiBase
 *     兜底（都没有才报错——报错文案在 config.ts，因为那里才知道是哪个消费者）。
 */
export interface AuxRouteResolution {
  /** 凭证变量名（调用方负责从环境解析并校验非空） */
  apiKeyEnv: string;
  /** 路由自带的端点；没有则 undefined */
  baseURL?: string;
}

/**
 * 把路由名解析成辅助调用可用的凭证与端点。
 *
 * @param provider `topic.provider` 等配置里写的路由名
 * @param path     报错用的 YAML 路径（如 `topic.provider`）
 */
export function resolveAuxRoute(
  modelApi: ModelApiConfig,
  provider: string,
  path: string,
): AuxRouteResolution {
  if (provider === DEEPSEEK_OFFICIAL_PROVIDER) {
    // 注意：llm-deepseek 的 baseURL 是 Anthropic Messages 端点（…/anthropic），
    // 不是 chat-completions——判定调用不能用它，端点必须由 topic.apiBase 提供
    // （缺省 https://api.deepseek.com 正好就是官方兼容端点）。
    return { apiKeyEnv: modelApi.deepseek?.apiKeyEnv ?? 'DEEPSEEK_API_KEY' };
  }
  const route = modelApi.providers[provider];
  if (route === undefined) {
    throw new ConfigError(`${path} 指定的模型路由 ${JSON.stringify(provider)} 未在 models.providers 里声明`, [
      `已声明的路由：${[DEEPSEEK_OFFICIAL_PROVIDER, ...Object.keys(modelApi.providers)].join('、')}`,
    ]);
  }
  if (route.api !== undefined && route.api !== 'openai-completions') {
    throw new ConfigError(`${path} 指向的路由 ${provider} 声明了 api: ${route.api}，判定调用无法使用`, [
      '话题/介入判定是不经 DSH 的直调，只会说 OpenAI 兼容的 /chat/completions',
      '换一条 openai-completions 路由，或不给该路由显式声明 api（目录默认协议可兼容时）',
    ]);
  }
  if (route.apiKeyEnv === undefined) {
    throw new ConfigError(`${path} 指向的路由 ${provider} 没有 apiKeyEnv，判定调用拿不到凭证`, [
      '判定是 qqbot 进程内的直调，pi-ai 的"环境发现"在这里不存在；请给该路由配 apiKeyEnv',
    ]);
  }
  return { apiKeyEnv: route.apiKeyEnv, ...(route.baseURL === undefined ? {} : { baseURL: route.baseURL }) };
}

// ---------------------------------------------------------------------------
// patch 生成与落盘
// ---------------------------------------------------------------------------

/** 生成的 patch 文件名（落在 stateDir 下）。 */
export const MODEL_API_PATCH_FILENAME = 'model-api.patch.yml';

/** 去掉值为 undefined 的键，让生成的 YAML 只含用户显式配置的项。 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/**
 * 把 models: 段渲染成 dsh 的 patch 文本（纯函数）。
 *
 * 没有配置任何路由时返回 undefined——此时启动参数与现状完全一致（不加第二个
 * --patch），保证未使用本功能的部署零变化。
 */
export function renderModelApiPatch(modelApi: ModelApiConfig): string | undefined {
  const entries: unknown[] = [];
  if (modelApi.deepseek !== undefined) {
    entries.push({ id: 'llm-deepseek', config: modelApi.deepseek });
  }
  if (Object.keys(modelApi.providers).length > 0) {
    entries.push({ id: 'llm-pi-ai', config: { providers: modelApi.providers } });
  }
  if (entries.length === 0) return undefined;
  return (
    '# 本文件由 qqbot 启动时根据配置文件的 models: 段生成——不要手改，重启会被覆盖。\n' +
    '# 密钥不在此文件里：apiKeyEnv 只是环境变量名引用，值在 .env。\n' +
    stringifyYaml(entries)
  );
}

/**
 * 渲染并写入 stateDir，返回文件路径；无配置时返回 undefined（并清掉旧文件残留
 * 之外不做任何事——旧文件没人引用，留着无害，刻意不删以保留排障现场）。
 */
export function writeModelApiPatch(modelApi: ModelApiConfig, stateDir: string): string | undefined {
  const text = renderModelApiPatch(modelApi);
  if (text === undefined) return undefined;
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, MODEL_API_PATCH_FILENAME);
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
  return path;
}
