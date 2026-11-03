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
  | {
      $var: 'thinking.enabled' | 'thinking.effort' | 'thinking.budget';
      omitWhenOff?: boolean;
    };
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
 * 解析配置文件的 `models:` 段（纯函数，供 config-file.ts 调用）。
 *
 * 只做形状/类型/取值校验与密钥卫生；语义校验（选中的 provider 是否已声明、
 * apiKeyEnv 引用的变量是否存在）在 config.ts 合并完 env 之后做。
 */
export type parseModelApiSection = (raw: unknown, path: string) => ModelApiConfig;
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
export type assertModelApiConfig = (
  modelApi: ModelApiConfig,
  selectedProvider: string,
  env: Env,
  selectionKey?: string
) => void;
/**
 * 快 lane 固定请求 off。显式 models 目录中的所选模型必须声明 off 和至少一个
 * 非 off 档位；显式 reasoningEfforts=false 或不含 off 的覆写同样拒绝。
 * 未覆写能力的 modelOverrides、仅继承 DSH 目录及带外路由留给 DSH 校验。
 * 校验合并 env 后的最终 provider/model，失败抛 ConfigError，不推断线上能力。
 */
export type assertFastLaneModelConfig = (
  modelApi: ModelApiConfig,
  selectedProvider: string,
  selectedModel: string
) => void;
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
export type resolveAuxRoute = (
  modelApi: ModelApiConfig,
  provider: string,
  path: string
) => AuxRouteResolution;
/** 生成的 patch 文件名（落在 stateDir 下）。 */
export const MODEL_API_PATCH_FILENAME = 'model-api.patch.yml';
/**
 * 把 models: 段渲染成 dsh 的 patch 文本（纯函数）。
 *
 * 没有配置任何路由时返回 undefined——此时启动参数与现状完全一致（不加第二个
 * --patch），保证未使用本功能的部署零变化。
 */
export type renderModelApiPatch = (modelApi: ModelApiConfig) => string | undefined;
/**
 * 渲染并写入 stateDir，返回文件路径；无配置时返回 undefined（并清掉旧文件残留
 * 之外不做任何事——旧文件没人引用，留着无害，刻意不删以保留排障现场）。
 */
export type writeModelApiPatch = (modelApi: ModelApiConfig, stateDir: string) => string | undefined;
export {};
