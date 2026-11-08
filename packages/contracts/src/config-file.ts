/**
 * 配置文件层（`qqbot.yml` 入口 + `config/*.yml` 模块）。
 *
 * 为什么要拆出这一层：`.env` 里塞了 39 个变量，里面**真正敏感的只有 4 个**
 * （QQ_APP_ID / QQ_APP_SECRET / DEEPSEEK_API_KEY / ONEBOT_ACCESS_TOKEN），
 * 其余 35 个是行为参数。混在一起的结果是"重要信息被稀释"——翻半天才找到要改的那行。
 *
 * 配置本身又进一步拆成模块（tsconfig 式 include）：
 *   - `qqbot.yml` 是入口，只声明 include 清单与模块控制；
 *   - `config/*.yml` 各管一块，详细注释跟着模块走；
 *   - `config/local/*.yml` 放本机配置（模型路由等），不进 git。
 *
 * 职责划分：
 *   1. 找到入口文件（QQ_CONFIG_FILE，默认 ./qqbot.yml）并读出 YAML；
 *   2. 展开 include（config-includes.ts），每个文件先独立校验再深合并；
 *   3. 校验形状与类型，拒绝拼错的键名，产出**带类型的 FileConfig**；
 *   4. 语义校验（取值范围、窗口重叠…）留给 config.ts，因为它要在合并 env 之后再判。
 *
 * 优先级：env > 配置文件合并结果 > 代码内置默认。模块之间按 include 顺序，
 * 后加载覆盖先加载；入口文件自己的配置最后合并。之所以让 env 仍然优先，
 * 一是既有部署零破坏（.env 里写着的值照旧生效），二是临时覆盖不用改文件。
 *
 * 本模块**不做**任何 env 合并，也不读 process.env 之外的全局状态：
 * `parseConfigFileText` / `parseConfigDocument` 仍是纯函数，可以直接单测；
 * 只有 `loadConfigFile` 会碰文件系统。
 */
/**
 * 配置文件层（`qqbot.yml` 入口 + `config/*.yml` 模块）。
 *
 * 为什么要拆出这一层：`.env` 里塞了 39 个变量，里面**真正敏感的只有 4 个**
 * （QQ_APP_ID / QQ_APP_SECRET / DEEPSEEK_API_KEY / ONEBOT_ACCESS_TOKEN），
 * 其余 35 个是行为参数。混在一起的结果是"重要信息被稀释"——翻半天才找到要改的那行。
 *
 * 配置本身又进一步拆成模块（tsconfig 式 include）：
 *   - `qqbot.yml` 是入口，只声明 include 清单与模块控制；
 *   - `config/*.yml` 各管一块，详细注释跟着模块走；
 *   - `config/local/*.yml` 放本机配置（模型路由等），不进 git。
 *
 * 职责划分：
 *   1. 找到入口文件（QQ_CONFIG_FILE，默认 ./qqbot.yml）并读出 YAML；
 *   2. 展开 include（config-includes.ts），每个文件先独立校验再深合并；
 *   3. 校验形状与类型，拒绝拼错的键名，产出**带类型的 FileConfig**；
 *   4. 语义校验（取值范围、窗口重叠…）留给 config.ts，因为它要在合并 env 之后再判。
 *
 * 优先级：env > 配置文件合并结果 > 代码内置默认。模块之间按 include 顺序，
 * 后加载覆盖先加载；入口文件自己的配置最后合并。之所以让 env 仍然优先，
 * 一是既有部署零破坏（.env 里写着的值照旧生效），二是临时覆盖不用改文件。
 *
 * 本模块**不做**任何 env 合并，也不读 process.env 之外的全局状态：
 * `parseConfigFileText` / `parseConfigDocument` 仍是纯函数，可以直接单测；
 * 只有 `loadConfigFile` 会碰文件系统。
 */
import type { ParsedConfigDocument } from './config-includes.js';
import type { ModelApiConfig } from './dsh/model-config.js';
/** 未设置 QQ_CONFIG_FILE 时默认读的文件（相对进程 CWD）。 */
export const DEFAULT_CONFIG_FILE = 'qqbot.yml';
export interface QqOfficialFileConfig {
  apiBase?: string;
  intents?: number;
  msgType?: number;
  maxChars?: number;
  maxRepliesPerMsg?: number;
  progressMax?: number;
  progressAfterMs?: number;
  progressIntervalMs?: number;
  turnTimeoutMs?: number;
  c2c?: {
    enabled?: boolean;
    maxRepliesPerMsg?: number;
    progressMax?: number;
  };
}
export interface OnebotFileConfig {
  host?: string;
  port?: number;
  c2cEnabled?: boolean;
  autoAcceptFriend?: boolean;
  autoAcceptGroupInvite?: boolean;
  fileTransport?: string;
  maxChars?: number;
  maxRepliesPerMsg?: number;
  progressMax?: number;
  progressAfterMs?: number;
  progressIntervalMs?: number;
  turnTimeoutMs?: number;
}
export interface DshFileConfig {
  provider?: string;
  model?: string;
  profilePatch?: string;
  bin?: string;
  startTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
export interface TasksFileConfig {
  fastTimeoutMs?: number;
  slowTimeoutMs?: number;
  fastProvider?: string;
  fastModel?: string;
  slowProvider?: string;
  slowModel?: string;
  fastRuntimes?: number;
  slowRuntimes?: number;
  maxPerSession?: number;
  maxGlobal?: number;
  retentionMs?: number;
  reminderMs?: number;
}
export interface PoolFileConfig {
  maxConcurrentTurns?: number;
  maxRuntimes?: number;
  runtimeIdleMs?: number;
  replayTurns?: number;
}
/** 话题判定（LLM 判断新消息与既有话题是否相关，见 pipeline/topic-judge.ts）。 */
export interface TopicFileConfig {
  enabled?: boolean;
  /** 判定调用走的模型路由名（models: 段声明的路由）；不配 = 直连 apiBase + DEEPSEEK_API_KEY */
  provider?: string;
  apiBase?: string;
  model?: string;
  timeoutMs?: number;
  contextTurns?: number;
}
export interface PathsFileConfig {
  dshHome?: string;
  workspacesRoot?: string;
  stateDir?: string;
}
export interface OffpeakFileConfig {
  enabled?: boolean;
  /** 谷时段窗口：写成逗号分隔的字符串，或 YAML 数组（两种都会归一成一个 spec 串） */
  windows?: string;
  timeZone?: string;
  modelPattern?: string;
  weekendsAllDay?: boolean;
  holidays?: string[];
}
export interface HealthFileConfig {
  port?: number;
}
/** 预设风格前台（`personas:` 段）：/persona 命令可切换的每会话人设。 */
export interface PersonasFileConfig {
  /** 预设目录（每个 `<名>.md` 是一个可选人设） */
  dir?: string;
}
/** 长任务提示注入（`hints.longTask`，见 pipeline/hints.ts）。 */
export interface LongTaskHintFileConfig {
  enabled?: boolean;
  /** 命中这些子串的消息，prompt 里追加"耗时任务请后台派发"提示 */
  patterns?: string[];
  /** 自定义提示文本（默认文本见 pipeline/hints.ts） */
  text?: string;
}
export interface HintsFileConfig {
  longTask?: LongTaskHintFileConfig;
}
/**
 * 主动发言的配置面（`proactive:` 段）。
 *
 * `interests` 是**场景 5 兴趣池**：整份内容会进 prompt，因此文件本身另存
 * （`proactive.interestsFile`），不塞进本配置文件——它有自己的 schema 与校验
 * （见 `pipeline/proactive/interests/pool.ts`）。
 */
export interface ProactiveFileConfig {
  enabled?: boolean;
  /** 灰度观察：判定照跑、不真发言（默认 true） */
  dryRun?: boolean;
  interestsEnabled?: boolean;
  interestsFile?: string;
  /** bot 在本群的别名（场景 4 指代检测用），如 ["小助手", "助手酱"] */
  botAliases?: string[];
  /** 话题滚动周期：每多少条旁听消息收敛一次（场景 2/5 的入口） */
  topicRollMessages?: number;
  /** 话题滚动周期：多少毫秒无仲裁则收敛一次 */
  topicRollMs?: number;
  /** 问题挂起多久后探针（场景 3 的答案窗口） */
  questionProbeMs?: number;
  /**
   * 每个挂起问题最多"让路"几次（默认 1）。硬上限 3——超出按 3 处理并 warn，
   * 因为"让路只能让一次"是**代码级**约束，不是 prompt 里的请求。
   */
  maxWaitPerItem?: number;
  /** "让路"理由的等待时长（毫秒；默认 45000，范围 15000–120000） */
  waitYieldMs?: number;
  /**
   * 一个话题 session 内允许的主动发言条数（默认 2）。硬上限 5——配得更大按 5
   * 处理并 warn，因为"少说两句"是产品决策，不该被一行配置改回去。
   */
  sessionBudget?: number;
  /** 静默多久自动关闭 session（毫秒；默认 600000，范围 60000–3600000） */
  sessionIdleMs?: number;
  /** 同一 session 内两次发言的最小间隔（毫秒；默认 45000，范围 10000–300000） */
  sessionMinGapMs?: number;
  /** 判定调用超时（毫秒）；与 topic.timeoutMs 分开，见 config.ts 的说明 */
  judgeTimeoutMs?: number;
  /** 发言生成（措辞轮次）超时（毫秒；默认 120000，范围 30000–300000） */
  speakTimeoutMs?: number;
  /** 旁听缓冲上限（条）与最长保留时长（毫秒） */
  bufferMaxMessages?: number;
  bufferMaxAgeMs?: number;
}
/** 观察窗口（旁听滚窗）的配置面（`observation:` 段）。 */
export interface ObservationFileConfig {
  /** 每会话保留的消息条数上限（默认 200） */
  maxMessages?: number;
  /** 每条消息的最长保留时长（毫秒；默认 1800000 = 30 分钟） */
  maxAgeMs?: number;
  /**
   * 注入给**被动唤醒**（被 @）的窗口宽度（毫秒；默认 600000 = 10 分钟）。
   *
   * 窄于保留期是有意的：留 30 分钟是为了让判定能回看，回答当下这问题时把半小时前
   * 另一个话题的内容灌进去只会稀释注意力。
   */
  injectWindowMs?: number;
  /**
   * 被 @ 时最多内联几张上下文里的图片（默认 2；0 = 不内联，只留 `[图片]` 占位）。
   *
   * 上下文里的图在窗口里只有占位文本，没有这个配额就永远看不到——"群里先发图、
   * 再 @ bot 问这是什么"因此必然失败（见 `store/window.ts` 的 `ObservationMedia`）。
   */
  injectImages?: number;
  /** 被 @ 时最多摄取几个上下文里的文件（默认 1；0 = 不摄取） */
  injectFiles?: number;
}
/** 富媒体输入配额（与平台无关，官方/OneBot 共用）。 */
export interface AttachmentsFileConfig {
  enabled?: boolean;
  maxImages?: number;
  maxImageBytes?: number;
  maxImageTiles?: number;
  downloadTimeoutMs?: number;
  forward?: AttachmentsForwardFileConfig;
  files?: AttachmentsFilesFileConfig;
}
/** 转发消息块配额（`attachments.forward`）。 */
export interface AttachmentsForwardFileConfig {
  enabled?: boolean;
  maxNodes?: number;
  maxNodeChars?: number;
  maxChars?: number;
  maxDepth?: number;
  timeoutMs?: number;
}
/** 文件下载与解析配额（`attachments.files`）。 */
export interface AttachmentsFilesFileConfig {
  enabled?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  maxExtractChars?: number;
  maxPdfPages?: number;
  extractTimeoutMs?: number;
  saveToInbox?: boolean;
  inboxDir?: string;
  retentionDays?: number;
  maxInboxMB?: number;
  extractExtensions?: string[];
}
/** 富媒体出站（agent 产物回发，与平台无关）。 */
export interface MediaFileConfig {
  enabled?: boolean;
  maxFileMB?: number;
  maxAttachmentsPerMsg?: number;
  imageExtensions?: string[];
  outboxDir?: string;
}
/** 配置文件里允许出现的全部内容（每项都可选）。 */
export interface LoggingFileConfig {
  maxRecordBytes?: number;
  maxQueuedBytes?: number;
  agentDetailLimit?: number;
  dedupeWindowMs?: number;
  diagnosticTraceIds?: string[];
  diagnosticSessionKeys?: string[];
  diagnosticTtlMs?: number;
  flushTimeoutMs?: number;
}
export interface FileConfig {
  sessionContext?: Partial<import('./session/context.js').SessionContextSettings>;
  logging?: LoggingFileConfig;
  connectors?: string[];
  qqOfficial?: QqOfficialFileConfig;
  onebot?: OnebotFileConfig;
  dsh?: DshFileConfig;
  /**
   * 模型 API 配置层（`models:` 段）。结构与 DSH 的提供商配置面一一对应
   * （透传 + 严格形状校验），解析与校验见 dsh/model-config.ts。
   * 该段是结构化嵌套配置，不走上面的标量 spec 机制。
   */
  models?: ModelApiConfig;
  pool?: PoolFileConfig;
  tasks?: TasksFileConfig;
  topic?: TopicFileConfig;
  paths?: PathsFileConfig;
  offpeak?: OffpeakFileConfig;
  attachments?: AttachmentsFileConfig;
  media?: MediaFileConfig;
  health?: HealthFileConfig;
  proactive?: ProactiveFileConfig;
  observation?: ObservationFileConfig;
  personas?: PersonasFileConfig;
  hints?: HintsFileConfig;
  logLevel?: string;
}
/**
 * 解析一份配置文件：取出 `include` 清单，并校验本文件自己的配置。
 *
 * 这是给 `loadConfigGraph` 用的回调：图遍历负责读其他文件、循环检测与合并，
 * 这里只关心"这一份文件写了什么"。
 */
export type parseConfigDocument = (
  text: string,
  source?: string
) => ParsedConfigDocument<FileConfig>;
/**
 * 解析单份 YAML 文本为 FileConfig（纯函数，便于单测）。
 *
 * 不含 include 展开：需要模块能力时用 `loadConfigFile`（正常启动路径）。
 * 这里遇到 include 会明确报错，避免调用方以为模块被加载了、实际却被静默忽略。
 *
 * @param source 出错信息里显示的文件名
 */
export type parseConfigFileText = (text: string, source?: string) => FileConfig;
/** 解析配置文件的路径。`explicit` 表示是用户显式设的（决定文件缺失时是否报错）。 */
export type resolveConfigFilePath = (env: Record<string, string | undefined>) => {
  path: string;
  explicit: boolean;
};
/** `loadConfigFile` 的结果：实际用到的文件路径 + 解析出来的配置。 */
export interface LoadedConfigFile {
  /** 入口文件路径；没使用配置文件时为 undefined */
  path?: string;
  config: FileConfig;
  /**
   * 实际加载的全部文件（按加载顺序，入口文件在最后）。
   *
   * 只有真正读到了入口文件才存在；默认路径下文件不存在时返回空配置，不带此字段。
   * 启动日志用它回答排障第一个问题："这次到底读了哪几份配置"。
   */
  files?: string[];
}
/**
 * 读取并解析配置文件。
 *
 * 缺文件的策略：
 *   - QQ_CONFIG_FILE 显式设了 → 文件必须存在，缺失直接报错（免得静默跑在默认值上）；
 *   - 没设（用的是默认路径）→ 文件不存在视为"没有配置文件"，返回空配置。
 *
 * 另外防一个 Docker 特有的坑：bind mount 的宿主文件不存在时，Docker 会**自动建一个
 * 同名目录**，于是容器里那个路径是个目录。这种情况给出可操作的提示，而不是含糊的
 * EISDIR。
 */
export type loadConfigFile = (env?: Record<string, string | undefined>) => LoadedConfigFile;
