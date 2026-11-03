import { DEFAULT_OFFPEAK_WINDOWS } from '@qqbot/contracts';
import type { ConnectorName, Config } from '@qqbot/contracts';
/**
 * 配置层：env（密钥）+ 配置文件（qqbot.yml 入口 + config/ 模块）+ 代码内置默认，
 * 三层合并 + 启动期快速失败。
 *
 * 为什么要分层（而不是全塞 .env）：
 *   `.env` 里 39 个变量中真正敏感的只有 4 个（QQ_APP_ID / QQ_APP_SECRET /
 *   DEEPSEEK_API_KEY / ONEBOT_ACCESS_TOKEN），其余都是行为参数。混在一起的结果是
 *   重要信息被稀释——想改个端口要在一堆参数里翻。所以：
 *
 *     .env        只放密钥（以及 docker-compose 传递的少数几个）
 *     qqbot.yml   配置入口（include 清单）；其余行为参数在 config/*.yml
 *                  （随仓库提供，带注释，就是默认配置）
 *
 * 取值优先级：**env > 配置文件合并结果 > 内置默认**。模块之间后加载覆盖先加载，
 * 入口自己的配置最后合并；映射深合并，数组/标量整体替换。
 * 让 env 仍然优先有两个理由：既有部署的 .env 零破坏；临时覆盖不用改文件。
 * 密钥类（appId/appSecret/apiKey/accessToken）**只能**来自 env——它们绝不写进配置文件。
 *
 * 设计原则：
 *   - 所有可调参数集中在这里，其余模块不直接读 process.env 或读配置文件；
 *   - 必填项缺失/范围越界立刻抛错并说清怎么修，不等到运行中途才发现；
 *   - 配置文件只做形状与类型校验（见 config-file.ts），语义校验（取值范围、
 *     配额不变量、窗口重叠…）在这里做，因为要等 env 合并完才能判。
 */
import { Intent, DEFAULT_INTENTS } from '@qqbot/contracts';
import { describeIntents } from './connectors/index.js';
import { assertModelApiConfig, resolveAuxRoute } from './dsh/model-config.js';
import { DEEPSEEK_OFFICIAL_PROVIDER } from '@qqbot/contracts';
import type { ModelApiConfig } from '@qqbot/contracts';
import { QQ_OFFICIAL_PLATFORM } from '@qqbot/contracts';
import { ONEBOT_PLATFORM } from '@qqbot/contracts';
import { ConfigError } from '@qqbot/contracts';
import type { FileConfig, ObservationFileConfig, ProactiveFileConfig } from '@qqbot/contracts';
import { DEFAULT_LONG_TASK_HINT_TEXT, DEFAULT_LONG_TASK_PATTERNS } from '@qqbot/contracts';
import type { LongTaskHintConfig } from '@qqbot/contracts';
import { DEFAULT_ACTIVITY_WINDOW_MS } from '@qqbot/contracts';
import {
  DEFAULT_OBSERVATION_INJECT_FILES,
  DEFAULT_OBSERVATION_INJECT_IMAGES,
  DEFAULT_OBSERVATION_MAX_AGE_MS,
  DEFAULT_OBSERVATION_MAX_MESSAGES,
} from '@qqbot/contracts';
import {
  DEFAULT_MAX_WAIT_PER_ITEM,
  DEFAULT_SESSION_BUDGET,
  DEFAULT_SESSION_IDLE_MS,
  DEFAULT_SESSION_MIN_GAP_MS,
  MAX_SESSION_BUDGET_CAP,
  MAX_WAIT_PER_ITEM_CAP,
  SESSION_IDLE_MS_MAX,
  SESSION_IDLE_MS_MIN,
  SESSION_MIN_GAP_MS_MAX,
  SESSION_MIN_GAP_MS_MIN,
  DEFAULT_WAIT_YIELD_MS,
  WAIT_YIELD_MS_MAX,
  WAIT_YIELD_MS_MIN,
} from '@qqbot/contracts';
import {
  formatWindows,
  isValidDateString,
  isValidTimeZone,
  parseWindowsSpec,
} from './offpeak/index.js';
import { OffpeakConfigError } from '@qqbot/contracts';
import type { OffpeakWindow } from '@qqbot/contracts';

import { loggingSettings } from './observability/index.js';
import type { LoggingSettings } from '@qqbot/contracts';

export { ConfigError } from './config-error.js';

export type { ConnectorName } from '@qqbot/contracts';

/**
 * 内置的默认谷时段窗口：北京时间 00:00-09:00、12:00-14:00、18:00-24:00。
 * 窗口之外（09:00-12:00、14:00-18:00）是正价时段。
 */
export { DEFAULT_OFFPEAK_WINDOWS } from '@qqbot/contracts';

export type { Config } from '@qqbot/contracts';

/** 观察窗口配置（见 Config.observation）。 */
export type { ObservationConfig } from '@qqbot/contracts';

/** 富媒体出站配置（见 Config.media）。 */
export type { MediaConfig } from '@qqbot/contracts';

/** 富媒体输入配额（见 Config.attachments）。 */
export type { AttachmentsConfig } from '@qqbot/contracts';

/**
 * 转发消息块的配额（见 Config.attachments.forward）。
 *
 * 四重上限刻意都保守：一个转发块动辄上百条，全量展开既烧 token 也把真正的问题
 * 淹掉。超限**不是错误**，是渲染成"仅展开以上条目"的显式说明。
 */
export type { ForwardConfig } from '@qqbot/contracts';

/**
 * 文件（PDF 等）的下载与解析配额（见 Config.attachments.files）。
 *
 * 与图片配额分开的原因：文件的"读入成本"比图片高一个量级（下载 + 落盘 + 解析
 * 子进程 + 可能两三万字的正文），共用一套数值会逼着两件事中的一个妥协。
 */
export type { FilesConfig } from '@qqbot/contracts';

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// 三层取值：env > 配置文件 > 内置默认
//
// 错误信息刻意区分两种来源：env 分支沿用原来的变量名（既有排障习惯与测试不变），
// 文件分支带上 YAML 路径（如 onebot.port），这样"到底该改哪儿"一眼可见。
// ---------------------------------------------------------------------------

function envRaw(env: Env, key: string): string | undefined {
  const raw = env[key];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

function pickString(
  env: Env,
  envKey: string,
  fileValue: string | undefined,
  fallback: string
): string {
  return envRaw(env, envKey) ?? fileValue ?? fallback;
}

/**
 * 校验"会拼进会话工作区路径的目录名"。
 *
 * 为什么单独抽一个函数：这个校验有两处调用（`media.outboxDir` 与
 * `attachments.files.inboxDir`），而它守的是一条安全不变量——目录必须是
 * 工作区**之内**的一个普通子目录。四处踩过的坑：
 *
 *   - 空串：`envRaw() ?? fileValue ?? fallback` 里**空串不是 nullish**，
 *     所以 `inboxDir: ""` 会一路通过；而 `path.join(ws, '')` 恰好等于工作区根，
 *     于是落盘落在工作区根、清理把 `AGENTS.md` 与 agent 产物当垃圾删。
 *     这类"配置写空"在 YAML 里极其常见（改配置时清空忘了填）。
 *   - 分隔符与 `.` / `..`：能指向工作区之外的任意路径。
 *
 * 注释里写清楚，是因为下一个人很容易把它当成"格式检查"而顺手放宽。
 */
function workspaceSubdirReason(value: string): string | undefined {
  if (value === '') return '不能为空（空串会让它退化成工作区根目录）';
  if (value.includes('/') || value.includes('\\')) return '不能含路径分隔符';
  if (value === '.' || value === '..') return '不能是 . 或 ..';
  return undefined;
}

function assertWorkspaceSubdirName(value: string, label: string, hints: string[]): void {
  const reason = workspaceSubdirReason(value);
  if (reason === undefined) return;
  throw new ConfigError(
    `${label} 必须是工作区内的纯子目录名：${reason}，收到 ${JSON.stringify(value)}`,
    hints
  );
}

function pickInt(
  env: Env,
  envKey: string,
  fileValue: number | undefined,
  fallback: number,
  range: { min: number; max: number },
  filePath: string
): number {
  const raw = envRaw(env, envKey);
  let value: number;
  if (raw !== undefined) {
    value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new ConfigError(`${envKey} 必须是整数，收到 ${JSON.stringify(raw)}`);
    }
    if (value < range.min || value > range.max) {
      throw new ConfigError(`${envKey} 必须在 [${range.min}, ${range.max}] 之间，收到 ${value}`);
    }
    return value;
  }
  if (fileValue !== undefined) {
    if (fileValue < range.min || fileValue > range.max) {
      throw new ConfigError(
        `配置文件里的 ${filePath} 必须在 [${range.min}, ${range.max}] 之间，收到 ${fileValue}`
      );
    }
    return fileValue;
  }
  return fallback;
}

function pickBool(
  env: Env,
  envKey: string,
  fileValue: boolean | undefined,
  fallback: boolean
): boolean {
  const raw = envRaw(env, envKey);
  if (raw === undefined) return fileValue ?? fallback;
  const value = raw.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`${envKey} 只能是 true/false（也接受 1/0），收到 ${JSON.stringify(raw)}`);
}

function pickEnum<T extends string>(
  env: Env,
  envKey: string,
  fileValue: string | undefined,
  allowed: readonly T[],
  fallback: T,
  filePath: string
): T {
  const raw = envRaw(env, envKey);
  if (raw !== undefined) {
    if (!allowed.includes(raw as T)) {
      throw new ConfigError(`${envKey} 只能是 ${allowed.join(' | ')}，收到 ${JSON.stringify(raw)}`);
    }
    return raw as T;
  }
  if (fileValue !== undefined) {
    if (!allowed.includes(fileValue as T)) {
      throw new ConfigError(
        `配置文件里的 ${filePath} 只能是 ${allowed.join(' | ')}，收到 ${JSON.stringify(fileValue)}`
      );
    }
    return fileValue as T;
  }
  return fallback;
}

/**
 * 主动发言配置（`Config.proactive`）。
 *
 * 这里**只做配置合并与形状校验**：兴趣池文件的内容校验归
 * `pipeline/proactive/interests/pool.ts`（它有自己的 schema 与报错文案），
 * 由组装层在需要时读取——本函数不碰磁盘。
 *
 * 默认值刻意保守：
 *   - `enabled` 缺省 **false**（fail-closed，不配就不主动开口）；
 *   - `topicRollMessages` 30（比既有采样口径 `evaluateEvery=6` 更保守：
 *     弱信号场景每 30 条才有一次机会，见架构方案 §6 的成本模型）；
 *   - `topicRollMs` 5 分钟（消息少但话题在延续时的兜底收敛）。
 */
function buildProactiveConfig(
  env: Env,
  file: ProactiveFileConfig | undefined
): Config['proactive'] {
  const aliases = pickList(env, 'BOT_BOT_ALIASES', file?.botAliases);
  if (aliases.length > 5) {
    throw new ConfigError(`bot 别名最多 5 个，收到 ${aliases.length} 个`, [
      'BOT_BOT_ALIASES / proactive.botAliases；别名会进判定 prompt，太多会稀释判据',
    ]);
  }
  for (const alias of aliases) {
    if (alias.length < 2) {
      throw new ConfigError(`bot 别名「${alias}」太短（少于 2 字）`, [
        '单字别名会在群里到处误命中（例如"助"），宁可用完整叫法',
      ]);
    }
  }

  // 白名单只认 env（个人标识不进配置文件）；条目必须含 `:`，否则是写错了平台前缀
  const whitelistGroups = pickList(env, 'BOT_LISTEN_GROUPS', undefined);
  for (const item of whitelistGroups) {
    if (!item.includes(':')) {
      throw new ConfigError(`BOT_LISTEN_GROUPS 条目缺少平台前缀：${item}`, [
        '正确写法：onebot:123456 或 ob11:g123456（平台标识:群号）',
      ]);
    }
  }

  return {
    enabled: pickBool(env, 'BOT_PROACTIVE_ENABLED', file?.enabled, false),
    // ⚠️ 灰度默认**开**：即使有人手滑把总开关打开，也不会立刻在群里说话，
    // 而是先记录"本应发言"。观察一到两周确认判据准了再显式关掉它。
    dryRun: pickBool(env, 'BOT_PROACTIVE_DRY_RUN', file?.dryRun, true),
    interestsEnabled: pickBool(env, 'BOT_PROACTIVE_INTERESTS', file?.interestsEnabled, true),
    interestsFile: pickString(env, 'QQ_INTERESTS_FILE', file?.interestsFile, 'interests.yml'),
    // 真实取值由组装层读文件后回填（见 main.ts）；配置层只知道路径。
    interestsLoaded: false,
    interestsCount: 0,
    whitelistGroups,
    botAliases: aliases,
    topicRollMessages: pickInt(
      env,
      'BOT_TOPIC_ROLL_MESSAGES',
      file?.topicRollMessages,
      30,
      { min: 3, max: 500 },
      'proactive.topicRollMessages'
    ),
    topicRollMs: pickInt(
      env,
      'BOT_TOPIC_ROLL_MS',
      file?.topicRollMs,
      300_000,
      { min: 10_000, max: 3_600_000 },
      'proactive.topicRollMs'
    ),
    questionProbeMs: pickInt(
      env,
      'BOT_PROACTIVE_QUESTION_PROBE_MS',
      file?.questionProbeMs,
      90_000,
      { min: 10_000, max: 3_600_000 },
      'proactive.questionProbeMs'
    ),
    // 让路预算：默认 1（让路只能让一次）。
    //
    // ⚠️ 这里的 `max` 刻意**不是**硬上限（3）：配成 5 时正确的行为是
    // "按 3 处理并 warn"（需求边界表），而不是启动失败。校验范围只挡明显
    // 越界的值，真正的硬上限由 `effectiveMaxWaitPerItem` 在 watcher 层执行
    // ——"上限必须活在模型之下"，而且是**运行期**的约束。
    maxWaitPerItem: pickInt(
      env,
      'BOT_PROACTIVE_MAX_WAIT_PER_ITEM',
      file?.maxWaitPerItem,
      DEFAULT_MAX_WAIT_PER_ITEM,
      { min: 0, max: MAX_WAIT_PER_ITEM_CAP * 10 },
      'proactive.maxWaitPerItem'
    ),
    waitYieldMs: pickInt(
      env,
      'BOT_PROACTIVE_WAIT_YIELD_MS',
      file?.waitYieldMs,
      DEFAULT_WAIT_YIELD_MS,
      { min: WAIT_YIELD_MS_MIN, max: WAIT_YIELD_MS_MAX },
      'proactive.waitYieldMs'
    ),
    // 话题 session（主动发言的唯一放行闸门）：
    //
    // ⚠️ `sessionBudget` 的 `max` 刻意**不是**硬上限（5）：配成 9 时正确的行为是
    // "按 5 处理并 warn"（验收 9），而不是启动失败——与 `maxWaitPerItem` 同一口径。
    // 真正的硬上限由 `effectiveSessionBudget` 在 watcher 层执行。
    sessionBudget: pickInt(
      env,
      'BOT_PROACTIVE_SESSION_BUDGET',
      file?.sessionBudget,
      DEFAULT_SESSION_BUDGET,
      { min: 1, max: MAX_SESSION_BUDGET_CAP * 20 },
      'proactive.sessionBudget'
    ),
    sessionIdleMs: pickInt(
      env,
      'BOT_PROACTIVE_SESSION_IDLE_MS',
      file?.sessionIdleMs,
      DEFAULT_SESSION_IDLE_MS,
      { min: SESSION_IDLE_MS_MIN, max: SESSION_IDLE_MS_MAX },
      'proactive.sessionIdleMs'
    ),
    sessionMinGapMs: pickInt(
      env,
      'BOT_PROACTIVE_SESSION_MIN_GAP_MS',
      file?.sessionMinGapMs,
      DEFAULT_SESSION_MIN_GAP_MS,
      { min: SESSION_MIN_GAP_MS_MIN, max: SESSION_MIN_GAP_MS_MAX },
      'proactive.sessionMinGapMs'
    ),
    // 判定超时比话题判定宽一倍：输出是多段 JSON 而不是一个布尔值
    judgeTimeoutMs: pickInt(
      env,
      'BOT_PROACTIVE_JUDGE_TIMEOUT_MS',
      file?.judgeTimeoutMs,
      20_000,
      { min: 1_000, max: 120_000 },
      'proactive.judgeTimeoutMs'
    ),
    // 发言生成（措辞轮次）超时：是"插一句话"不是"跑一个任务"，
    // 上限刻意低于被动轮次——超时的表现是本次不发言，不是报错。
    speakTimeoutMs: pickInt(
      env,
      'BOT_PROACTIVE_SPEAK_TIMEOUT_MS',
      file?.speakTimeoutMs,
      120_000,
      { min: 30_000, max: 300_000 },
      'proactive.speakTimeoutMs'
    ),
    // 旁听缓冲的两个限制：**取值搬到 `observation.*`**（滚窗不再属于介入层，
    // 见 Config.observation 的说明），这里只保留**旧键的读取**（`undefined` = 用户
    // 没配），由 `buildObservationConfig` 决定优先级并 warn。保留旧键的理由很实际：
    // 随仓库提供的默认配置里写的就是旧键名——静默失效
    // 比报错更糟。
    bufferMaxMessages: pickOptionalInt(
      env,
      'BOT_PROACTIVE_BUFFER_MAX_MESSAGES',
      file?.bufferMaxMessages,
      { min: 10, max: 10_000 },
      'proactive.bufferMaxMessages'
    ),
    bufferMaxAgeMs: pickOptionalInt(
      env,
      'BOT_PROACTIVE_BUFFER_MAX_AGE_MS',
      file?.bufferMaxAgeMs,
      { min: 60_000, max: 72 * 3_600_000 },
      'proactive.bufferMaxAgeMs'
    ),
  };
}

/**
 * 与 `pickInt` 同款，但**没有缺省值**：两处都没配时返回 `undefined`。
 *
 * 存在理由只有一个：让"用户到底配没配这个键"可判。用来读取那些**已迁移但必须
 * 兼容**的旧键（读写两侧都要知道"这是用户显式写的，还是搬运期留下的默认值"）。
 */
function pickOptionalInt(
  env: Env,
  envKey: string,
  fileValue: number | undefined,
  range: { min: number; max: number },
  filePath: string
): number | undefined {
  const raw = envRaw(env, envKey);
  if (raw === undefined && fileValue === undefined) return undefined;
  if (raw !== undefined) {
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new ConfigError(`${envKey} 必须是整数，收到 ${JSON.stringify(raw)}`);
    }
    if (value < range.min || value > range.max) {
      throw new ConfigError(`${envKey} 必须在 [${range.min}, ${range.max}] 之间，收到 ${value}`);
    }
    return value;
  }
  const value = fileValue as number;
  if (value < range.min || value > range.max) {
    throw new ConfigError(
      `配置文件里的 ${filePath} 必须在 [${range.min}, ${range.max}] 之间，收到 ${value}`
    );
  }
  return value;
}

/**
 * 观察窗口（滚窗）配置。
 *
 * 四件事在这里定下来：
 *   1. **范围** = `BOT_LISTEN_GROUPS`，与介入层**共用同一个变量**（见 ObservationConfig）；
 *   2. **保留期**（`maxMessages` / `maxAgeMs`）与**注入宽度**（`injectWindowMs`）
 *      是两件事：前者是"记得多久"，后者是"被 @ 时给多少"；
 *   3. **媒体配额**（`injectImages` / `injectFiles`）：窗口里留下的媒体引用要在
 *      注入时才会被取字节（见 `store/window.ts`），这两个数就是那道闸；
 *   4. **旧键兼容**：`proactive.bufferMaxMessages` / `proactive.bufferMaxAgeMs` /
 *      `BOT_PROACTIVE_BUFFER_MAX_*` 仍然生效，但 `observation.*` 优先并 warn
 *      ——默认配置文件里本来就是旧键，硬切会让所有人的记忆长度悄悄回到默认值。
 */
function buildObservationConfig(
  env: Env,
  file: ObservationFileConfig | undefined,
  proactive: { bufferMaxMessages?: number; bufferMaxAgeMs?: number }
): Config['observation'] {
  const maxMessages = pickInt(
    env,
    'BOT_OBSERVATION_MAX_MESSAGES',
    file?.maxMessages,
    proactive.bufferMaxMessages ?? DEFAULT_OBSERVATION_MAX_MESSAGES,
    { min: 10, max: 10_000 },
    'observation.maxMessages'
  );
  const maxAgeMs = pickInt(
    env,
    'BOT_OBSERVATION_MAX_AGE_MS',
    file?.maxAgeMs,
    proactive.bufferMaxAgeMs ?? DEFAULT_OBSERVATION_MAX_AGE_MS,
    { min: 60_000, max: 72 * 3_600_000 },
    'observation.maxAgeMs'
  );
  // 配置层**不持有 logger**（它比日志先构造，报错走 stderr + exit 2）。所以旧键
  // 这件事只在这里生成一句提示，由启动摘要打出来——比在 config.ts 里造一个
  // "日志"要诚实得多。
  const deprecations: string[] = [];
  if (proactive.bufferMaxMessages !== undefined) {
    deprecations.push(
      `proactive.bufferMaxMessages → observation.maxMessages（当前生效：${maxMessages}）`
    );
  }
  if (proactive.bufferMaxAgeMs !== undefined) {
    deprecations.push(`proactive.bufferMaxAgeMs → observation.maxAgeMs（当前生效：${maxAgeMs}）`);
  }

  // 注入宽度与活动窗口同值：判定层已经定义过"当前话题有多长"（活动窗口），
  // 被 @ 时注入的上下文用同一个口径，不另造一个数字。
  const injectWindowMs = pickInt(
    env,
    'BOT_OBSERVATION_INJECT_WINDOW_MS',
    file?.injectWindowMs,
    DEFAULT_ACTIVITY_WINDOW_MS,
    { min: 60_000, max: 3_600_000 },
    'observation.injectWindowMs'
  );

  // 上下文里的媒体配额：**刻意小于 `attachments.maxImages` / `files.maxFiles`**。
  // 那两份配额回答的是"用户这次发来的东西最多读多少"，而这两份回答的是"为了听懂
  // 他在说什么，最多额外翻多少背景资料"——后者是背景，不该压过前者，更不该因为
  // 群里刷了一晚上图就让每一次 @ 都拖着一串图片进 prompt（token 是这么烧掉的）。
  const injectImages = pickInt(
    env,
    'BOT_OBSERVATION_INJECT_IMAGES',
    file?.injectImages,
    DEFAULT_OBSERVATION_INJECT_IMAGES,
    { min: 0, max: 20 },
    'observation.injectImages'
  );
  const injectFiles = pickInt(
    env,
    'BOT_OBSERVATION_INJECT_FILES',
    file?.injectFiles,
    DEFAULT_OBSERVATION_INJECT_FILES,
    { min: 0, max: 10 },
    'observation.injectFiles'
  );

  return {
    // 白名单只认 env（个人标识不进配置文件），与介入层读的是同一个变量
    allowlist: pickList(env, 'BOT_LISTEN_GROUPS', undefined),
    maxMessages,
    maxAgeMs,
    injectWindowMs,
    injectImages,
    injectFiles,
    deprecations,
  };
}

/** 列表：env 用逗号分隔，配置文件用 YAML 数组；env 非空时以 env 为准。 */ function pickList(
  env: Env,
  envKey: string,
  fileValue: string[] | undefined
): string[] {
  const raw = envRaw(env, envKey);
  if (raw !== undefined) {
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  return fileValue ?? [];
}

/** 密钥类必填项：只认 env，绝不从配置文件取。 */
function requiredSecret(env: Env, key: string, hints: string[] = []): string {
  const raw = envRaw(env, key);
  if (raw === undefined) {
    throw new ConfigError(`缺少必需环境变量 ${key}`, hints);
  }
  return raw;
}

export function loadConfig(env: Env = process.env, file: FileConfig = {}): Config {
  const hints = ['请复制 .env.example 为 .env 并填写后重试'];

  // --- 接入平台选择 ---------------------------------------------------------
  const connectorsRaw = pickList(env, 'BOT_CONNECTORS', file.connectors);
  const connectors: ConnectorName[] =
    connectorsRaw.length === 0
      ? [QQ_OFFICIAL_PLATFORM]
      : connectorsRaw.map((name) => {
          if (name !== QQ_OFFICIAL_PLATFORM && name !== ONEBOT_PLATFORM) {
            throw new ConfigError(
              `接入平台（BOT_CONNECTORS / connectors）含未知平台：${JSON.stringify(name)}`,
              [`可选值：${QQ_OFFICIAL_PLATFORM} | ${ONEBOT_PLATFORM}（逗号分隔可并存）`]
            );
          }
          return name;
        });
  // 去重，避免重复启动同一个接入
  const enabledConnectors = [...new Set(connectors)];
  const officialEnabled = enabledConnectors.includes(QQ_OFFICIAL_PLATFORM);
  const onebotEnabled = enabledConnectors.includes(ONEBOT_PLATFORM);

  // --- 官方开放平台（仅启用时校验必填项与配额不变量） ------------------------
  // appId/appSecret 是密钥，只能来自 env：仅启用官方接入时必填。
  const appId = officialEnabled
    ? requiredSecret(env, 'QQ_APP_ID', hints)
    : (envRaw(env, 'QQ_APP_ID') ?? '');
  const appSecret = officialEnabled
    ? requiredSecret(env, 'QQ_APP_SECRET', hints)
    : (envRaw(env, 'QQ_APP_SECRET') ?? '');

  // 注意：DEEPSEEK_API_KEY **不再在这里无条件必填**——它在下方按"实际引用"归集
  // （主路由是 deepseek-official、或判定调用解析到它时才需要）。密钥只能来自
  // env 的纪律不变：dsh 子进程继承本进程环境（src/dsh/process.ts），写进
  // 配置文件它读不到。

  const qqFile = file.qqOfficial ?? {};
  const intents = pickInt(
    env,
    'QQ_INTENTS',
    qqFile.intents,
    DEFAULT_INTENTS,
    { min: 1, max: 0x7fffffff },
    'qq-official.intents'
  );
  if (officialEnabled && (intents & Intent.GROUP_AND_C2C_EVENT) === 0) {
    // GROUP_AND_C2C_EVENT(1<<25) 是收群聊/单聊消息的最低要求。缺了它机器人会连着但收不到
    // 消息，属于"看起来正常其实废掉"的配置错误，直接快速失败。
    throw new ConfigError(
      `QQ_INTENTS=${intents} 未包含 GROUP_AND_C2C_EVENT(1<<25)=33554432，将收不到任何群聊/单聊消息`,
      [
        `正确示例：QQ_INTENTS=${DEFAULT_INTENTS}（= ${describeIntents(DEFAULT_INTENTS).join(' | ')}）`,
      ]
    );
  }

  const maxRepliesPerMsg = pickInt(
    env,
    'QQ_MAX_REPLIES_PER_MSG',
    qqFile.maxRepliesPerMsg,
    4,
    { min: 1, max: 5 },
    'qq-official.maxRepliesPerMsg'
  );
  const progressMax = pickInt(
    env,
    'QQ_PROGRESS_MAX',
    qqFile.progressMax,
    3,
    { min: 0, max: 5 },
    'qq-official.progressMax'
  );

  // 单聊：官方上限是 4 次（群聊是 5），所以单独校验，不能共用群聊的上限。
  const qqC2cFile = qqFile.c2c ?? {};
  const c2cMaxReplies = pickInt(
    env,
    'QQ_C2C_MAX_REPLIES_PER_MSG',
    qqC2cFile.maxRepliesPerMsg,
    4,
    { min: 1, max: 4 },
    'qq-official.c2c.maxRepliesPerMsg'
  );
  const c2cProgressMax = pickInt(
    env,
    'QQ_C2C_PROGRESS_MAX',
    qqC2cFile.progressMax,
    2,
    { min: 0, max: 4 },
    'qq-official.c2c.progressMax'
  );

  const msgTypeRaw = pickInt(
    env,
    'QQ_MSG_TYPE',
    qqFile.msgType,
    0,
    { min: 0, max: 7 },
    'qq-official.msgType'
  );
  if (msgTypeRaw !== 0 && msgTypeRaw !== 2) {
    throw new ConfigError(
      `QQ_MSG_TYPE 本 MVP 只支持 0(纯文本) 或 2(markdown)，收到 ${msgTypeRaw}`,
      ['6(input_notify 打字状态)只有单聊支持，且本 MVP 不发送打字状态']
    );
  }

  // 群被动回复窗口 5 分钟（官方硬约束）。单轮超时必须**小于**该窗口，
  // 否则超时后那条"任务已中断"的回复本身也会因为窗口过期而发送失败。
  // 默认 4 分钟：留出 1 分钟做收尾和发送。
  //
  // 单聊的被动窗口更宽（官方文档为 60 分钟），这里**故意共用**同一个更保守的
  // 上限：更容易配错也更难排查的是"超时提示发不出去"，而不是任务跑得不够久。
  const turnTimeoutMs = pickInt(
    env,
    'QQ_TURN_TIMEOUT_MS',
    qqFile.turnTimeoutMs,
    240_000,
    { min: 5_000, max: 295_000 },
    'qq-official.turnTimeoutMs'
  );

  const progressAfterMs = pickInt(
    env,
    'QQ_PROGRESS_AFTER_MS',
    qqFile.progressAfterMs,
    90_000,
    { min: 1_000, max: 280_000 },
    'qq-official.progressAfterMs'
  );

  // --- OneBot（社区框架；无被动窗口，配额只是防失控的安全阀） ----------------
  // access token 是密钥：只认 env，启用 onebot 时必填。
  const onebotAccessToken = onebotEnabled
    ? requiredSecret(env, 'ONEBOT_ACCESS_TOKEN', [
        'onebot 接入以 WS server 形式暴露端口，没有 token 等于把 agent 控制权交给能连上端口的任何人',
      ])
    : (envRaw(env, 'ONEBOT_ACCESS_TOKEN') ?? '');
  const obFile = file.onebot ?? {};
  const onebotMaxReplies = pickInt(
    env,
    'ONEBOT_MAX_REPLIES_PER_MSG',
    obFile.maxRepliesPerMsg,
    10,
    { min: 1, max: 50 },
    'onebot.maxRepliesPerMsg'
  );
  const onebotProgressMax = pickInt(
    env,
    'ONEBOT_PROGRESS_MAX',
    obFile.progressMax,
    3,
    { min: 0, max: 49 },
    'onebot.progressMax'
  );
  const onebotTurnTimeoutMs = pickInt(
    env,
    'ONEBOT_TURN_TIMEOUT_MS',
    obFile.turnTimeoutMs,
    600_000,
    { min: 5_000, max: 3_600_000 },
    'onebot.turnTimeoutMs'
  );
  const onebotProgressAfterMs = pickInt(
    env,
    'ONEBOT_PROGRESS_AFTER_MS',
    obFile.progressAfterMs,
    90_000,
    { min: 1_000, max: 600_000 },
    'onebot.progressAfterMs'
  );

  // --- 管理员白名单：platform:senderId，只认 env ----------------------------
  // 不读配置文件：那里是真实 QQ 号/openid，属于个人标识（见 Config.admins 注释）。
  // 配置文件里写了 admins 会被 parseConfigFileText 明确拒绝并给出迁移提示。
  const admins = [...pickList(env, 'BOT_ADMINS', undefined)];
  for (const legacy of pickList(env, 'QQ_ADMIN_OPENIDS', undefined)) {
    // 裸 openid 一律按官方平台解释（该变量本来的语义）
    admins.push(legacy.includes(':') ? legacy : `${QQ_OFFICIAL_PLATFORM}:${legacy}`);
  }

  // --- 谷时段闸：格式错误在启动期爆出来，不等到拦截时才发觉配错 -------------
  // 一天内可以有多个谷时段窗口，三层来源：
  //   QQ_OFFPEAK_WINDOWS（env）> offpeak.windows（文件）> 内置默认
  //   兼容旧配置：只设了 QQ_OFFPEAK_START / QQ_OFFPEAK_END 时，按单窗口处理。
  const legacyStartRaw = envRaw(env, 'QQ_OFFPEAK_START');
  const legacyEndRaw = envRaw(env, 'QQ_OFFPEAK_END');
  const hasLegacyWindow = legacyStartRaw !== undefined || legacyEndRaw !== undefined;
  const offpeakWindowsSpec =
    envRaw(env, 'QQ_OFFPEAK_WINDOWS') ??
    (hasLegacyWindow
      ? `${legacyStartRaw ?? '00:30'}-${legacyEndRaw ?? '08:30'}`
      : (file.offpeak?.windows ?? DEFAULT_OFFPEAK_WINDOWS));
  const offpeakTimeZone = pickString(env, 'QQ_OFFPEAK_TZ', file.offpeak?.timeZone, 'Asia/Shanghai');
  let offpeakWindows: OffpeakWindow[];
  try {
    offpeakWindows = parseWindowsSpec(offpeakWindowsSpec);
  } catch (error) {
    if (error instanceof OffpeakConfigError) {
      throw new ConfigError(`谷时段窗口配置无效：${error.message}`, [
        `格式为逗号分隔的 HH:MM-HH:MM，例如 QQ_OFFPEAK_WINDOWS=${DEFAULT_OFFPEAK_WINDOWS}`,
        '结束时间可写 24:00 表示当天结束；也支持跨零点（如 22:00-06:00）；窗口之间不能重叠',
        '旧写法 QQ_OFFPEAK_START / QQ_OFFPEAK_END 仍可用，但它只能表达单个窗口',
      ]);
    }
    throw error;
  }
  if (!isValidTimeZone(offpeakTimeZone)) {
    throw new ConfigError(`谷时段时区不是有效时区：${JSON.stringify(offpeakTimeZone)}`, [
      '使用 IANA 时区名，例如 Asia/Shanghai、UTC',
    ]);
  }
  const offpeakHolidays = pickList(env, 'QQ_OFFPEAK_HOLIDAYS', file.offpeak?.holidays);
  for (const date of offpeakHolidays) {
    if (!isValidDateString(date)) {
      throw new ConfigError(`谷时段节假日含无效日期：${JSON.stringify(date)}`, [
        '格式为 YYYY-MM-DD，例如 offpeak.holidays: ["2027-01-01"]',
        '内置已含 2026 年官方节假日（国办发明电〔2025〕7 号），这里只需追加跨年或临时日期',
      ]);
    }
  }

  const dshFile = file.dsh ?? {};
  // 模型 API 配置层：选中的 provider 必须先定下来，才能校验它指向的路由已声明；
  // 同时在这里核对所有 apiKeyEnv 引用在环境中真实存在（dsh 子进程继承本进程环境）。
  //
  // ⚠️ 校验是 **opt-in** 的：只有配了 models: 段才执行。没配时 dsh.provider 可以是
  // 任意字符串——路由也可能由 DSH 自己的 settings 层带外提供（$DSH_HOME 下的
  // settings 文档直接喂 llm-pi-ai），qqbot 不该对自己看不见的集合断言。
  // 一旦用户启用了本层，"选中的路由必须已声明"就该在启动期守住。
  const dshProvider = pickString(env, 'DSH_PROVIDER', dshFile.provider, DEEPSEEK_OFFICIAL_PROVIDER);
  const taskFile = file.tasks ?? {};
  const fastProvider = pickString(env, 'BOT_FAST_PROVIDER', taskFile.fastProvider, dshProvider);
  const slowProvider = pickString(env, 'BOT_SLOW_PROVIDER', taskFile.slowProvider, dshProvider);
  const modelApi: ModelApiConfig = file.models ?? { providers: {} };
  if (file.models !== undefined) {
    assertModelApiConfig(modelApi, dshProvider, env);
    assertModelApiConfig(modelApi, fastProvider, env, 'tasks.fastProvider');
    assertModelApiConfig(modelApi, slowProvider, env, 'tasks.slowProvider');
  }

  // --- 判定调用的路由解析（话题判定 + 主动介入判定共用同一端点与凭证） --------
  //
  // 不配 topic.provider = 历史默认：直连 topic.apiBase（默认 https://api.deepseek.com）
  // + DEEPSEEK_API_KEY，既有部署零变化。配了就把凭证与端点收口到 models: 段：
  //   凭证   = 路由的 apiKeyEnv 引用（值仍在 env 里，下面统一检查存在性）；
  //   端点   = 显式 topic.apiBase > 路由的 baseURL > 官方默认（仅 deepseek-official）。
  const topicEnabled = pickBool(env, 'BOT_TOPIC_ENABLED', file.topic?.enabled, true);
  const topicProvider = envRaw(env, 'BOT_TOPIC_PROVIDER') ?? file.topic?.provider;
  let topicApiKeyEnv = 'DEEPSEEK_API_KEY';
  let topicApiBaseFallback = 'https://api.deepseek.com';
  if (topicProvider !== undefined && topicProvider !== '') {
    const route = resolveAuxRoute(modelApi, topicProvider, 'topic.provider');
    topicApiKeyEnv = route.apiKeyEnv;
    const explicitApiBase = envRaw(env, 'BOT_TOPIC_API_BASE') ?? file.topic?.apiBase;
    if (route.baseURL !== undefined) {
      topicApiBaseFallback = route.baseURL;
    } else if (topicProvider !== DEEPSEEK_OFFICIAL_PROVIDER && explicitApiBase === undefined) {
      throw new ConfigError(
        `topic.provider 指向的路由 ${topicProvider} 没有 baseURL，判定调用不知道往哪里发`,
        [
          '给该路由配 baseURL，或显式设置 topic.apiBase（chat-completions 基址，不含 /chat/completions 后缀）',
        ]
      );
    }
  }

  // --- 密钥必填项按"实际引用"归集 ------------------------------------------------
  // DEEPSEEK_API_KEY 不再无条件必填：主路由与判定都收口到其他提供商时，部署里可以
  // 完全没有它。只来自 env 的纪律不变（requiredSecret 不读配置文件）。
  const requiredSecrets = new Set<string>();
  if ([dshProvider, fastProvider, slowProvider].includes(DEEPSEEK_OFFICIAL_PROVIDER)) {
    // 原生路由的凭证引用（models.deepseek.apiKeyEnv 改名后按改名的来）
    requiredSecrets.add(modelApi.deepseek?.apiKeyEnv ?? 'DEEPSEEK_API_KEY');
  }
  if (topicEnabled) {
    requiredSecrets.add(topicApiKeyEnv);
  }
  // 主动介入判定复用同一凭证：topic 关掉时不硬失败，缺 key 的表现是"只听不说"
  // （main.ts 打 warn）——保持既有语义。
  for (const name of requiredSecrets) {
    requiredSecret(env, name, hints);
  }
  const topicApiKey = envRaw(env, topicApiKeyEnv) ?? '';

  const poolFile = file.pool ?? {};
  const hardRuntimes = pickInt(
    env,
    'QQ_MAX_RUNTIMES',
    poolFile.maxRuntimes,
    8,
    { min: 2, max: 128 },
    'pool.maxRuntimes'
  );
  const fastRuntimes = pickInt(
    env,
    'BOT_FAST_RUNTIMES',
    taskFile.fastRuntimes,
    Math.min(4, Math.floor(hardRuntimes / 2)),
    { min: 1, max: 127 },
    'tasks.fastRuntimes'
  );
  const slowRuntimes = pickInt(
    env,
    'BOT_SLOW_RUNTIMES',
    taskFile.slowRuntimes,
    Math.min(4, hardRuntimes - fastRuntimes),
    { min: 1, max: 127 },
    'tasks.slowRuntimes'
  );
  if (fastRuntimes + slowRuntimes > hardRuntimes)
    throw new ConfigError('tasks.fastRuntimes + tasks.slowRuntimes 不得超过 pool.maxRuntimes');

  const pathsFile = file.paths ?? {};
  const attachmentsFile = file.attachments ?? {};
  const mediaFile = file.media ?? {};

  // outboxDir 会拼进每个会话的工作区路径，必须是纯目录名（不含分隔符、不是 . / ..），
  // 否则"产物只能落在会话工作区内"这条安全不变量就被配置自己打破了。
  const mediaOutboxDir = pickString(env, 'BOT_MEDIA_OUTBOX_DIR', mediaFile.outboxDir, 'outbox');
  assertWorkspaceSubdirName(mediaOutboxDir, 'media 的 outboxDir', [
    '正确示例：outbox、deliverables',
  ]);

  const mediaImageExtensionsRaw = pickList(
    env,
    'BOT_MEDIA_IMAGE_EXTENSIONS',
    mediaFile.imageExtensions
  );
  const mediaImageExtensions = (
    mediaImageExtensionsRaw.length > 0 ? mediaImageExtensionsRaw : ['png', 'jpg', 'jpeg', 'gif']
  ).map((ext) => ext.trim().toLowerCase().replace(/^\./, ''));

  // inbox 与 outbox 同款校验、同样的理由：目录名会拼进工作区路径。
  // 两者语义相反（outbox = 发回用户，inbox = 用户发来的），**绝不可配成同一个名字**
  // ——那会让用户发来的文件被 egress 立刻回声回去。
  const attachmentInboxDir = pickString(
    env,
    'BOT_ATTACHMENT_INBOX_DIR',
    attachmentsFile.files?.inboxDir,
    'inbox'
  );
  assertWorkspaceSubdirName(attachmentInboxDir, 'attachments.files.inboxDir', [
    '正确示例：inbox、uploads',
  ]);
  if (attachmentInboxDir === mediaOutboxDir) {
    throw new ConfigError(
      `attachments.files.inboxDir 与 media.outboxDir 不能同名（都是 ${JSON.stringify(attachmentInboxDir)}）`,
      ['inbox 放用户发来的文件、outbox 放要发回用户的产物；同名会让用户发来的文件被立刻回发给自己']
    );
  }

  const attachmentExtensionsRaw = pickList(
    env,
    'BOT_ATTACHMENT_FILE_EXTENSIONS',
    attachmentsFile.files?.extractExtensions
  );
  const attachmentExtensions = (
    attachmentExtensionsRaw.length > 0
      ? attachmentExtensionsRaw
      : ['pdf', 'txt', 'md', 'csv', 'json', 'yaml', 'yml', 'log', 'xml', 'html']
  )
    .map((ext) => ext.trim().toLowerCase().replace(/^\./, ''))
    // 空串会被 extensionOf('') 之外的调用方当成"任意无扩展名文件都命中白名单"
    .filter((ext) => ext !== '');

  // 先构造 proactive：观察窗口要读它读出来的**旧键**（`bufferMax*`）做兼容
  const proactiveConfig = buildProactiveConfig(env, file.proactive);
  const observationConfig = buildObservationConfig(env, file.observation, {
    ...(proactiveConfig.bufferMaxMessages === undefined
      ? {}
      : { bufferMaxMessages: proactiveConfig.bufferMaxMessages }),
    ...(proactiveConfig.bufferMaxAgeMs === undefined
      ? {}
      : { bufferMaxAgeMs: proactiveConfig.bufferMaxAgeMs }),
  });

  // ⚠️ 隐形耦合检查：判定层的"活动窗口计数"（条数/人头）读的是**观察窗口里的条目**。
  // 如果窗口保留期比活动窗口还短，那些计数会**静默少算**——窗口里已经没有的条目
  // 不会被统计，而判据仍以为自己看的是完整窗口。不是致命错误（判定照跑），
  // 但必须让人知道，所以在这里出声而不是等线上发现判据偏了。
  if (observationConfig.maxAgeMs < DEFAULT_ACTIVITY_WINDOW_MS) {
    process.stderr.write(
      `\n配置提示：observation.maxAgeMs（${observationConfig.maxAgeMs}ms）比判定层的活动窗口` +
        `（${DEFAULT_ACTIVITY_WINDOW_MS}ms）还短，\n` +
        '  判定看到的条数/人数会少算。建议 maxAgeMs ≥ 活动窗口，或把 proactive 的\n' +
        '  活动窗口一并调小（ConversationStateOptions.activityWindowMs）。\n\n'
    );
  }

  return {
    connectors: enabledConnectors,
    admins,
    qq: {
      appId,
      appSecret,
      apiBase: pickString(env, 'QQ_API_BASE', qqFile.apiBase, 'https://api.bot.qq.com'),
      intents,
      msgType: msgTypeRaw,
      maxChars: pickInt(
        env,
        'QQ_MAX_CHARS',
        qqFile.maxChars,
        1500,
        { min: 100, max: 4000 },
        'qq-official.maxChars'
      ),
      maxRepliesPerMsg,
      progressAfterMs,
      progressIntervalMs: pickInt(
        env,
        'QQ_PROGRESS_INTERVAL_MS',
        qqFile.progressIntervalMs,
        90_000,
        { min: 1_000, max: 280_000 },
        'qq-official.progressIntervalMs'
      ),
      progressMax,
      turnTimeoutMs,
      c2c: {
        enabled: pickBool(env, 'QQ_C2C_ENABLED', qqC2cFile.enabled, true),
        maxRepliesPerMsg: c2cMaxReplies,
        progressMax: c2cProgressMax,
      },
    },
    onebot: {
      host: pickString(env, 'ONEBOT_WS_HOST', obFile.host, '0.0.0.0'),
      port: pickInt(
        env,
        'ONEBOT_WS_PORT',
        obFile.port,
        6700,
        { min: 0, max: 65_535 },
        'onebot.port'
      ),
      accessToken: onebotAccessToken,
      c2cEnabled: pickBool(env, 'ONEBOT_C2C_ENABLED', obFile.c2cEnabled, true),
      maxChars: pickInt(
        env,
        'ONEBOT_MAX_CHARS',
        obFile.maxChars,
        1500,
        { min: 100, max: 4500 },
        'onebot.maxChars'
      ),
      maxRepliesPerMsg: onebotMaxReplies,
      progressMax: onebotProgressMax,
      progressAfterMs: onebotProgressAfterMs,
      progressIntervalMs: pickInt(
        env,
        'ONEBOT_PROGRESS_INTERVAL_MS',
        obFile.progressIntervalMs,
        90_000,
        { min: 1_000, max: 600_000 },
        'onebot.progressIntervalMs'
      ),
      turnTimeoutMs: onebotTurnTimeoutMs,
      autoAcceptFriend: pickBool(env, 'ONEBOT_AUTO_ACCEPT_FRIEND', obFile.autoAcceptFriend, true),
      autoAcceptGroupInvite: pickBool(
        env,
        'ONEBOT_AUTO_ACCEPT_GROUP_INVITE',
        obFile.autoAcceptGroupInvite,
        false
      ),
      fileTransport: pickEnum(
        env,
        'ONEBOT_FILE_TRANSPORT',
        obFile.fileTransport,
        ['base64', 'path'] as const,
        'base64',
        'onebot.fileTransport'
      ),
    },
    dsh: {
      provider: dshProvider,
      model: pickString(env, 'DSH_MODEL', dshFile.model, 'deepseek-flash'),
      profilePatch: pickString(
        env,
        'QQ_DSH_PROFILE_PATCH',
        dshFile.profilePatch,
        '/app/dsh-profile/cordis.patch.yml'
      ),
      bin: pickString(env, 'QQ_DSH_BIN', dshFile.bin, 'dsh'),
      runtimeStartTimeoutMs: pickInt(
        env,
        'QQ_DSH_START_TIMEOUT_MS',
        dshFile.startTimeoutMs,
        60_000,
        { min: 5_000, max: 300_000 },
        'dsh.startTimeoutMs'
      ),
      runtimeShutdownTimeoutMs: pickInt(
        env,
        'QQ_DSH_SHUTDOWN_TIMEOUT_MS',
        dshFile.shutdownTimeoutMs,
        15_000,
        { min: 2_000, max: 120_000 },
        'dsh.shutdownTimeoutMs'
      ),
    },
    modelApi,
    tasks: {
      fastTimeoutMs: pickInt(
        env,
        'BOT_FAST_TIMEOUT_MS',
        taskFile.fastTimeoutMs,
        30_000,
        { min: 100, max: 3_600_000 },
        'tasks.fastTimeoutMs'
      ),
      slowTimeoutMs: pickInt(
        env,
        'BOT_SLOW_TIMEOUT_MS',
        taskFile.slowTimeoutMs,
        1_800_000,
        { min: 100, max: 86_400_000 },
        'tasks.slowTimeoutMs'
      ),
      fastProvider,
      fastModel: pickString(
        env,
        'BOT_FAST_MODEL',
        taskFile.fastModel,
        pickString(env, 'DSH_MODEL', dshFile.model, 'deepseek-flash')
      ),
      slowProvider,
      slowModel: pickString(
        env,
        'BOT_SLOW_MODEL',
        taskFile.slowModel,
        pickString(env, 'DSH_MODEL', dshFile.model, 'deepseek-flash')
      ),
      fastRuntimes,
      slowRuntimes,
      maxPerSession: pickInt(
        env,
        'BOT_TASKS_PER_SESSION',
        taskFile.maxPerSession,
        32,
        { min: 1, max: 1024 },
        'tasks.maxPerSession'
      ),
      maxGlobal: pickInt(
        env,
        'BOT_TASKS_GLOBAL',
        taskFile.maxGlobal,
        128,
        { min: 1, max: 65536 },
        'tasks.maxGlobal'
      ),
      retentionMs: pickInt(
        env,
        'BOT_TASK_RETENTION_MS',
        taskFile.retentionMs,
        7 * 86400_000,
        { min: 1, max: 365 * 86400_000 },
        'tasks.retentionMs'
      ),
      reminderMs: pickInt(
        env,
        'BOT_TASK_REMINDER_MS',
        taskFile.reminderMs,
        300_000,
        { min: 300_000, max: 86400_000 },
        'tasks.reminderMs'
      ),
    },
    pool: {
      maxConcurrentTurns: pickInt(
        env,
        'QQ_MAX_CONCURRENT_TURNS',
        poolFile.maxConcurrentTurns,
        4,
        { min: 1, max: 64 },
        'pool.maxConcurrentTurns'
      ),
      maxRuntimes: hardRuntimes,
      runtimeIdleMs: pickInt(
        env,
        'QQ_RUNTIME_IDLE_MS',
        poolFile.runtimeIdleMs,
        1_800_000,
        { min: 0, max: 86_400_000 },
        'pool.runtimeIdleMs'
      ),
      replayTurns: pickInt(
        env,
        'QQ_REPLAY_TURNS',
        poolFile.replayTurns,
        12,
        { min: 0, max: 200 },
        'pool.replayTurns'
      ),
    },
    topic: {
      enabled: topicEnabled,
      ...(topicProvider === undefined || topicProvider === '' ? {} : { provider: topicProvider }),
      apiKeyEnv: topicApiKeyEnv,
      apiKey: topicApiKey,
      apiBase: pickString(env, 'BOT_TOPIC_API_BASE', file.topic?.apiBase, topicApiBaseFallback),
      model: pickString(env, 'BOT_TOPIC_MODEL', file.topic?.model, 'deepseek-flash'),
      timeoutMs: pickInt(
        env,
        'BOT_TOPIC_TIMEOUT_MS',
        file.topic?.timeoutMs,
        10_000,
        { min: 1_000, max: 60_000 },
        'topic.timeoutMs'
      ),
      contextTurns: pickInt(
        env,
        'BOT_TOPIC_CONTEXT_TURNS',
        file.topic?.contextTurns,
        10,
        { min: 1, max: 50 },
        'topic.contextTurns'
      ),
    },
    paths: {
      dshHome: pickString(env, 'DSH_HOME', pathsFile.dshHome, '/data/dsh'),
      workspacesRoot: pickString(
        env,
        'QQ_WORKSPACES_ROOT',
        pathsFile.workspacesRoot,
        '/data/workspaces'
      ),
      stateDir: pickString(env, 'QQ_STATE_DIR', pathsFile.stateDir, '/data/bot'),
    },
    offpeak: {
      enabled: pickBool(env, 'QQ_OFFPEAK_ENABLED', file.offpeak?.enabled, false),
      windows: offpeakWindows,
      timeZone: offpeakTimeZone,
      modelPattern: pickString(
        env,
        'QQ_OFFPEAK_MODEL_PATTERN',
        file.offpeak?.modelPattern,
        'deepseek'
      ),
      weekendsAllDay: pickBool(env, 'QQ_OFFPEAK_WEEKENDS', file.offpeak?.weekendsAllDay, true),
      holidays: offpeakHolidays,
    },
    attachments: {
      enabled: pickBool(env, 'BOT_ATTACHMENT_ENABLED', attachmentsFile.enabled, true),
      // 上限都刻意保守：一条消息塞十几张图既烧 token 又压不住延迟，
      // 而 QQ 单图硬上限是 200MB，绝不能照抄。
      maxImages: pickInt(
        env,
        'BOT_ATTACHMENT_MAX_IMAGES',
        attachmentsFile.maxImages,
        4,
        { min: 0, max: 20 },
        'attachments.maxImages'
      ),
      maxImageBytes: pickInt(
        env,
        'BOT_ATTACHMENT_MAX_BYTES',
        attachmentsFile.maxImageBytes,
        8 * 1024 * 1024,
        { min: 1024, max: 200 * 1024 * 1024 },
        'attachments.maxImageBytes'
      ),
      // 长截图只有切成小块才读得清：模型对**每张图**只有 64 万像素的预算
      // （deepseek-flash 的 imagePixelBudget），整张缩下去文字就糊成一团。
      // 12 块 ≈ 一张 1080×7100 的聊天记录，token 代价约 1 万；上限 20 是 runtime
      // 单条 prompt 的图片张数上限，不能越过。
      maxImageTiles: pickInt(
        env,
        'BOT_ATTACHMENT_MAX_IMAGE_TILES',
        attachmentsFile.maxImageTiles,
        12,
        { min: 1, max: 20 },
        'attachments.maxImageTiles'
      ),
      downloadTimeoutMs: pickInt(
        env,
        'BOT_ATTACHMENT_TIMEOUT_MS',
        attachmentsFile.downloadTimeoutMs,
        15_000,
        { min: 1_000, max: 120_000 },
        'attachments.downloadTimeoutMs'
      ),
      forward: {
        enabled: pickBool(
          env,
          'BOT_ATTACHMENT_FORWARD_ENABLED',
          attachmentsFile.forward?.enabled,
          true
        ),
        // 20 条 ≈ 群里一次"爬楼"转发的常见规模；再多模型也读不完，只是烧 token。
        maxNodes: pickInt(
          env,
          'BOT_ATTACHMENT_FORWARD_MAX_NODES',
          attachmentsFile.forward?.maxNodes,
          20,
          { min: 1, max: 100 },
          'attachments.forward.maxNodes'
        ),
        maxNodeChars: pickInt(
          env,
          'BOT_ATTACHMENT_FORWARD_MAX_NODE_CHARS',
          attachmentsFile.forward?.maxNodeChars,
          500,
          { min: 50, max: 5_000 },
          'attachments.forward.maxNodeChars'
        ),
        // 总字符上限：4000 字 ≈ 一篇长文，足够读懂"这捆记录在聊什么"。
        maxChars: pickInt(
          env,
          'BOT_ATTACHMENT_FORWARD_MAX_CHARS',
          attachmentsFile.forward?.maxChars,
          4_000,
          { min: 200, max: 40_000 },
          'attachments.forward.maxChars'
        ),
        maxDepth: pickInt(
          env,
          'BOT_ATTACHMENT_FORWARD_MAX_DEPTH',
          attachmentsFile.forward?.maxDepth,
          2,
          { min: 0, max: 5 },
          'attachments.forward.maxDepth'
        ),
        timeoutMs: pickInt(
          env,
          'BOT_ATTACHMENT_FORWARD_TIMEOUT_MS',
          attachmentsFile.forward?.timeoutMs,
          10_000,
          { min: 1_000, max: 60_000 },
          'attachments.forward.timeoutMs'
        ),
      },
      files: {
        enabled: pickBool(env, 'BOT_ATTACHMENT_FILE_ENABLED', attachmentsFile.files?.enabled, true),
        maxFiles: pickInt(
          env,
          'BOT_ATTACHMENT_FILE_MAX_FILES',
          attachmentsFile.files?.maxFiles,
          2,
          { min: 0, max: 10 },
          'attachments.files.maxFiles'
        ),
        // 16MB：够放下常规 PDF/报表，又不至于让下载+落盘+解析把一轮拖垮。
        maxFileBytes: pickInt(
          env,
          'BOT_ATTACHMENT_FILE_MAX_BYTES',
          attachmentsFile.files?.maxFileBytes,
          16 * 1024 * 1024,
          { min: 1024, max: 200 * 1024 * 1024 },
          'attachments.files.maxFileBytes'
        ),
        // 20000 字 ≈ 30 页纯文字 PDF，是"能读懂"与"不撑爆 prompt"的分界。
        maxExtractChars: pickInt(
          env,
          'BOT_ATTACHMENT_FILE_MAX_CHARS',
          attachmentsFile.files?.maxExtractChars,
          20_000,
          { min: 200, max: 200_000 },
          'attachments.files.maxExtractChars'
        ),
        maxPdfPages: pickInt(
          env,
          'BOT_ATTACHMENT_FILE_MAX_PDF_PAGES',
          attachmentsFile.files?.maxPdfPages,
          30,
          { min: 1, max: 500 },
          'attachments.files.maxPdfPages'
        ),
        extractTimeoutMs: pickInt(
          env,
          'BOT_ATTACHMENT_FILE_TIMEOUT_MS',
          attachmentsFile.files?.extractTimeoutMs,
          10_000,
          { min: 1_000, max: 120_000 },
          'attachments.files.extractTimeoutMs'
        ),
        saveToInbox: pickBool(
          env,
          'BOT_ATTACHMENT_FILE_SAVE',
          attachmentsFile.files?.saveToInbox,
          true
        ),
        inboxDir: attachmentInboxDir,
        // 0 = 永不清理；默认 7 天，让"上周发的那份 PDF"还找得到。
        retentionDays: pickInt(
          env,
          'BOT_ATTACHMENT_INBOX_RETENTION_DAYS',
          attachmentsFile.files?.retentionDays,
          7,
          { min: 0, max: 365 },
          'attachments.files.retentionDays'
        ),
        // 单会话 200MB 上限；与 media.maxFileMB 一样用 MB —— 这是运维旋钮，
        // 不需要字节级精度（单文件上限才是安全边界，用字节）。
        maxInboxBytes:
          pickInt(
            env,
            'BOT_ATTACHMENT_INBOX_MAX_MB',
            attachmentsFile.files?.maxInboxMB,
            200,
            { min: 1, max: 5_000 },
            'attachments.files.maxInboxMB'
          ) *
          1024 *
          1024,
        extractExtensions: attachmentExtensions,
      },
    },
    media: {
      enabled: pickBool(env, 'BOT_MEDIA_ENABLED', mediaFile.enabled, true),
      // 默认 20MB：base64 传输膨胀 +33%，再大既拖慢发送也容易撞上平台/框架的上限
      maxFileBytes:
        pickInt(
          env,
          'BOT_MEDIA_MAX_FILE_MB',
          mediaFile.maxFileMB,
          20,
          { min: 1, max: 100 },
          'media.maxFileMB'
        ) *
        1024 *
        1024,
      maxAttachmentsPerMsg: pickInt(
        env,
        'BOT_MEDIA_MAX_ATTACHMENTS',
        mediaFile.maxAttachmentsPerMsg,
        4,
        { min: 1, max: 10 },
        'media.maxAttachmentsPerMsg'
      ),
      imageExtensions: mediaImageExtensions,
      outboxDir: mediaOutboxDir,
    },
    health: {
      port: pickInt(
        env,
        'QQ_HEALTH_PORT',
        file.health?.port,
        8080,
        { min: 0, max: 65_535 },
        'health.port'
      ),
    },
    proactive: proactiveConfig,
    // 观察窗口：**放在 proactive 之后**构造，因为旧键的兼容读取要拿到
    // `buildProactiveConfig` 读出来的 `bufferMax*`（见 buildObservationConfig）。
    observation: observationConfig,
    personas: {
      dir: pickString(env, 'BOT_PERSONA_DIR', file.personas?.dir, 'dsh-profile/personas'),
    },
    hints: {
      longTask: buildLongTaskHintConfig(env, file.hints?.longTask),
    },
    logging: resolveLoggingSettings(env, file),
    logLevel: pickEnum(
      env,
      'QQ_LOG_LEVEL',
      file.logLevel,
      ['debug', 'info', 'warn', 'error'] as const,
      'info',
      'logLevel'
    ),
  };
}

export function resolveLoggingSettings(
  env: Record<string, string | undefined>,
  file: FileConfig = {}
): LoggingSettings {
  const level = pickEnum(
    env,
    'QQ_LOG_LEVEL',
    file.logLevel,
    ['debug', 'info', 'warn', 'error'] as const,
    'info',
    'logLevel'
  );
  return loggingSettings({ ...file.logging, level });
}

/**
 * 长任务提示注入（`Config.hints.longTask`）。
 *
 * 空串关键词是**配置错误**而不是"匹配一切"：`''.includes(...)` 方向反过来就是
 * 每条消息都命中，提示注入就退化成每轮固定多一段文本。在这里快速失败。
 */
function buildLongTaskHintConfig(
  env: Env,
  file: { enabled?: boolean; patterns?: string[]; text?: string } | undefined
): LongTaskHintConfig {
  const raw = pickList(env, 'BOT_HINT_LONG_TASK_PATTERNS', file?.patterns);
  const patterns = (raw.length > 0 ? raw : DEFAULT_LONG_TASK_PATTERNS).map((p) => p.trim());
  const empty = patterns.filter((p) => p === '');
  if (empty.length > 0) {
    throw new ConfigError('长任务提示的关键词里含空串', [
      '空串会命中每一条消息；hints.longTask.patterns 里的条目都必须是非空字符串',
    ]);
  }
  return {
    enabled: pickBool(env, 'BOT_HINT_LONG_TASK_ENABLED', file?.enabled, true),
    patterns: [...new Set(patterns)],
    text: pickString(env, 'BOT_HINT_LONG_TASK_TEXT', file?.text, DEFAULT_LONG_TASK_HINT_TEXT),
  };
}

/** 供日志/health 展示的配置摘要（不含任何密钥） */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    connectors: config.connectors,
    qq: config.connectors.includes(QQ_OFFICIAL_PLATFORM)
      ? {
          apiBase: config.qq.apiBase,
          intents: config.qq.intents,
          intentNames: describeIntents(config.qq.intents),
          msgType: config.qq.msgType,
          maxChars: config.qq.maxChars,
          maxRepliesPerMsg: config.qq.maxRepliesPerMsg,
          c2c: { enabled: config.qq.c2c.enabled, maxRepliesPerMsg: config.qq.c2c.maxRepliesPerMsg },
        }
      : 'disabled',
    onebot: config.connectors.includes(ONEBOT_PLATFORM)
      ? {
          listen: `${config.onebot.host}:${config.onebot.port}`,
          c2cEnabled: config.onebot.c2cEnabled,
          maxChars: config.onebot.maxChars,
          autoAcceptFriend: config.onebot.autoAcceptFriend,
          autoAcceptGroupInvite: config.onebot.autoAcceptGroupInvite,
        }
      : 'disabled',
    dsh: {
      provider: config.dsh.provider,
      model: config.dsh.model,
      profilePatch: config.dsh.profilePatch,
    },
    // 模型 API 配置层：只暴露路由名与"是否自定义了原生路由"，apiKeyEnv 的变量名
    // 不算密钥（值才在 .env），但也刻意不打印——摘要越短越好读。
    modelApi: {
      deepseek: config.modelApi.deepseek === undefined ? 'default' : 'customized',
      providers: Object.keys(config.modelApi.providers),
    },
    pool: { maxRuntimes: config.pool.maxRuntimes, replayTurns: config.pool.replayTurns },
    tasks: config.tasks,
    topic: {
      enabled: config.topic.enabled,
      // 凭证解析到哪条路由（apiKey 本身绝不进摘要）
      provider: config.topic.provider ?? '(直连 apiBase)',
      apiKeyEnv: config.topic.apiKeyEnv,
      model: config.topic.model,
      timeoutMs: config.topic.timeoutMs,
      contextTurns: config.topic.contextTurns,
    },
    paths: config.paths,
    adminCount: config.admins.length,
    proactive: {
      enabled: config.proactive.enabled,
      dryRun: config.proactive.dryRun,
      interests: {
        enabled: config.proactive.interestsEnabled,
        file: config.proactive.interestsFile,
        loaded: config.proactive.interestsLoaded,
        count: config.proactive.interestsCount,
      },
      whitelistGroups: config.proactive.whitelistGroups.length,
      botAliases: config.proactive.botAliases,
      topicRoll: {
        messages: config.proactive.topicRollMessages,
        ms: config.proactive.topicRollMs,
      },
      // 话题 session（主动发言的唯一放行闸门）：启动摘要里给出用户配的原始值。
      // **生效值**（硬上限裁剪之后）另在 health 的 `proactive.sessions` 里给——
      // 配成 9 时这两处会不一样，那正是我们想要的可见性。
      session: {
        budget: config.proactive.sessionBudget,
        idleMs: config.proactive.sessionIdleMs,
        minGapMs: config.proactive.sessionMinGapMs,
      },
      judgeTimeoutMs: config.proactive.judgeTimeoutMs,
    },
    // 观察窗口（滚窗）：**与 proactive 并列**，因为它不随主动发言开关生死
    observation: {
      groups: config.observation.allowlist.length,
      maxMessages: config.observation.maxMessages,
      maxAgeMs: config.observation.maxAgeMs,
      injectWindowMs: config.observation.injectWindowMs,
      injectImages: config.observation.injectImages,
      injectFiles: config.observation.injectFiles,
      ...(config.observation.deprecations.length === 0
        ? {}
        : { deprecations: config.observation.deprecations }),
    },
    attachments: config.attachments,
    personas: { dir: config.personas.dir },
    deprecated: {
      ignored: [
        'pool.maxConcurrentTurns',
        'qq-official.progress*',
        'qq-official.turnTimeoutMs',
        'onebot.maxRepliesPerMsg',
        'onebot.progress*',
        'onebot.turnTimeoutMs',
        'hints.longTask',
        'proactive.speakTimeoutMs',
      ],
    },
    media: {
      enabled: config.media.enabled,
      maxFileBytes: config.media.maxFileBytes,
      maxAttachmentsPerMsg: config.media.maxAttachmentsPerMsg,
      imageExtensions: config.media.imageExtensions,
      outboxDir: config.media.outboxDir,
    },
    offpeak: {
      enabled: config.offpeak.enabled,
      windows: formatWindows(config.offpeak.windows),
      timeZone: config.offpeak.timeZone,
      modelPattern: config.offpeak.modelPattern,
      weekendsAllDay: config.offpeak.weekendsAllDay,
      extraHolidays: config.offpeak.holidays.length,
    },
  };
}
