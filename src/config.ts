/**
 * 配置层：env（密钥）+ qqbot.yml（行为参数）+ 代码内置默认，三层合并 + 启动期快速失败。
 *
 * 为什么要分层（而不是全塞 .env）：
 *   `.env` 里 39 个变量中真正敏感的只有 4 个（QQ_APP_ID / QQ_APP_SECRET /
 *   DEEPSEEK_API_KEY / ONEBOT_ACCESS_TOKEN），其余都是行为参数。混在一起的结果是
 *   重要信息被稀释——想改个端口要在一堆参数里翻。所以：
 *
 *     .env        只放密钥（以及 docker-compose 传递的少数几个）
 *     qqbot.yml   其余全部行为参数（随仓库提供，带注释，就是默认配置）
 *
 * 取值优先级：**env > qqbot.yml > 内置默认**。
 * 让 env 仍然优先有两个理由：既有部署的 .env 零破坏；临时覆盖不用改文件。
 * 密钥类（appId/appSecret/apiKey/accessToken）**只能**来自 env——它们绝不写进配置文件。
 *
 * 设计原则：
 *   - 所有可调参数集中在这里，其余模块不直接读 process.env 或读配置文件；
 *   - 必填项缺失/范围越界立刻抛错并说清怎么修，不等到运行中途才发现；
 *   - 配置文件只做形状与类型校验（见 config-file.ts），语义校验（取值范围、
 *     配额不变量、窗口重叠…）在这里做，因为要等 env 合并完才能判。
 */

import { Intent, DEFAULT_INTENTS, describeIntents } from './adapters/qq-official/types.js';
import { QQ_OFFICIAL_PLATFORM } from './adapters/qq-official/gateway.js';
import { ONEBOT_PLATFORM } from './adapters/onebot/connector.js';
import { ConfigError } from './config-error.js';
import type { FileConfig, ProactiveFileConfig } from './config-file.js';
import {
  formatWindows,
  isValidDateString,
  isValidTimeZone,
  OffpeakConfigError,
  parseWindowsSpec,
  type OffpeakWindow,
} from './offpeak/index.js';

export { ConfigError } from './config-error.js';

export type ConnectorName = typeof QQ_OFFICIAL_PLATFORM | typeof ONEBOT_PLATFORM;

/**
 * 内置的默认谷时段窗口：北京时间 00:00-09:00、12:00-14:00、18:00-24:00。
 * 窗口之外（09:00-12:00、14:00-18:00）是正价时段。
 */
export const DEFAULT_OFFPEAK_WINDOWS = '00:00-09:00,12:00-14:00,18:00-24:00';

export interface Config {
  /** 启用的接入平台（BOT_CONNECTORS / connectors，逗号分隔） */
  connectors: ConnectorName[];
  /**
   * 管理员白名单，**只来自 env**（BOT_ADMINS，逗号分隔）。
   *
   * 条目格式为 `platform:senderId`，例如 `qq-official:ABCDEF...` 或 `onebot:123456`。
   * 兼容项：QQ_ADMIN_OPENIDS 里的裸 openid 会自动加上 `qq-official:` 前缀。
   * 留空 = 没有管理员，/offpeak 的变更类子命令对所有人关闭（fail-closed）。
   *
   * 为什么只认 env：这里是真实 QQ 号 / openid，属于个人标识，不该进随仓库提交的
   * 配置文件（写在那里会在启动期被明确拒绝）。
   */
  admins: string[];
  /** 官方开放平台接入（仅 connectors 含 qq-official 时有意义） */
  qq: {
    /** 密钥，只能来自 env（QQ_APP_ID） */
    appId: string;
    /** 密钥，只能来自 env（QQ_APP_SECRET） */
    appSecret: string;
    /** OpenAPI 基址；2026-08-10 起统一为 api.bot.qq.com */
    apiBase: string;
    /** 订阅的 intents 位掩码 */
    intents: number;
    /** 发送消息用 markdown(2) 还是纯文本(0) */
    msgType: 0 | 2;
    maxChars: number;
    maxRepliesPerMsg: number;
    progressAfterMs: number;
    progressIntervalMs: number;
    progressMax: number;
    turnTimeoutMs: number;
    /**
     * 单聊（C2C）相关配置。
     *
     * 单聊与群聊共用 `1<<25` 这一个 intent，无法在订阅层屏蔽，所以用一个
     * 显式开关在业务层决定是否响应私聊。
     */
    c2c: {
      /** 是否响应单聊消息（false = 只服务群聊） */
      enabled: boolean;
      /** 单聊每条消息的最大回复条数（官方上限 4） */
      maxRepliesPerMsg: number;
      /** 单聊进度回执条数上限，必须 < maxRepliesPerMsg */
      progressMax: number;
    };
  };
  /** OneBot v11 社区框架接入（仅 connectors 含 onebot 时有意义） */
  onebot: {
    /** 反向 WS 监听地址（本服务起 server，LLBot/NapCat 等作为客户端连入） */
    host: string;
    port: number;
    /** 密钥，只能来自 env（ONEBOT_ACCESS_TOKEN；启用 onebot 时必填） */
    accessToken: string;
    /** 是否响应私聊消息 */
    c2cEnabled: boolean;
    maxChars: number;
    /** 无平台级配额，这里只是防失控的安全阀 */
    maxRepliesPerMsg: number;
    progressMax: number;
    progressAfterMs: number;
    progressIntervalMs: number;
    /** 无被动回复窗口，单轮超时可以放宽到任务真正需要的时长 */
    turnTimeoutMs: number;
    /** 收到加好友请求时自动同意（否则私聊路径永远打不开） */
    autoAcceptFriend: boolean;
    /** 收到拉群邀请时自动同意（默认关闭：被拉进陌生群意味着陌生人能触发 agent） */
    autoAcceptGroupInvite: boolean;
    /** 附件字节传输方式：base64（跨容器安全）或 path（同机部署省体积） */
    fileTransport: 'base64' | 'path';
  };
  dsh: {
    provider: string;
    model: string;
    /** profile patch 的绝对路径 */
    profilePatch: string;
    /** dsh 可执行文件；默认从 PATH 解析 */
    bin: string;
    /** 单轮上限（毫秒），与 qq.turnTimeoutMs 保持一致语义 */
    runtimeStartTimeoutMs: number;
    runtimeShutdownTimeoutMs: number;
  };
  pool: {
    maxConcurrentTurns: number;
    maxRuntimes: number;
    runtimeIdleMs: number;
    replayTurns: number;
  };
  /**
   * 话题判定：新消息与既有话题是否相关由一个小模型调用判断（不经 DSH 进程，
   * 见 pipeline/topic-judge.ts）。判定为无关 → 关闭话题（回收 runtime、
   * 跳过冷启动回放）。判定失败一律视为相关（fail-safe）。
   * apiKey 复用 DEEPSEEK_API_KEY（env），不在此处。
   */
  topic: {
    /** 总开关（BOT_TOPIC_ENABLED / topic.enabled，默认 true） */
    enabled: boolean;
    /** chat completions 基址（BOT_TOPIC_API_BASE / topic.apiBase） */
    apiBase: string;
    /** 判定用模型（BOT_TOPIC_MODEL / topic.model），默认与主模型同档的小模型 */
    model: string;
    /** 单次判定超时（毫秒） */
    timeoutMs: number;
    /** 送给判定器的最近记录条数（不含当前新消息） */
    contextTurns: number;
  };
  paths: {
    dshHome: string;
    workspacesRoot: string;
    stateDir: string;
  };
  /**
   * 谷时段闸：命中 modelPattern 的模型在谷时段窗口之外不调用 API，直接回复提示。
   * 运行期可被管理员 /offpeak 命令覆盖（见 offpeak/ 目录），这里只是 env/文件默认层。
   */
  offpeak: {
    /** 总开关（QQ_OFFPEAK_ENABLED / offpeak.enabled，默认 false） */
    enabled: boolean;
    /** 一天内的谷时段窗口列表（QQ_OFFPEAK_WINDOWS / offpeak.windows） */
    windows: OffpeakWindow[];
    /** 窗口所在时区（QQ_OFFPEAK_TZ / offpeak.timeZone，默认 Asia/Shanghai） */
    timeZone: string;
    /** 命中判定：`<provider>/<model>` 包含该子串（默认 deepseek） */
    modelPattern: string;
    /** 周六、周日全天谷价（默认 true，DeepSeek 2026-08-23 起规则） */
    weekendsAllDay: boolean;
    /** 追加的全天谷价日期（YYYY-MM-DD），与内置官方节假日表合并 */
    holidays: string[];
  };
  /**
   * 富媒体输入（图片 / 语音 / 引用 / 卡片）送进模型的总开关与配额。
   *
   * 与平台无关：官方与 OneBot 都走这一套。关闭后所有消息都退回"纯文本 +
   * `[图片]` 之类占位标记"的行为，适合模型不支持多模态时使用。
   */
  attachments: AttachmentsConfig;
  /**
   * 富媒体出站（agent 产物回发用户）：outbox 目录约定 + 体积/数量上限。
   *
   * 与平台无关：官方走 /files 上传 + msg_type=7，OneBot 走消息段/upload 动作，
   * 差异都在适配器内部。agent 侧只有一条约定——把要发的文件放进工作区的
   * `outboxDir` 目录（见 dsh-profile 的 persona 与 docs/RICH-MEDIA-PLAN.md）。
   */
  media: MediaConfig;
  health: {
    port: number;
  };
  /**
   * 主动发言（旁听 → 判定 → 主动开口）的配置面。
   *
   * 场景清单与判据见 `src/pipeline/proactive/interests/SCENES.md`；
   * 兴趣池文件（场景 5）另存，见 `proactive.interestsFile`。
   * 注意：`enabled` 是**主动发言的总开关**，缺省 false（fail-closed）。
   */
  proactive: {
    enabled: boolean;
    /** 兴趣池总开关（BOT_PROACTIVE_INTERESTS / proactive.interestsEnabled，默认 true） */
    interestsEnabled: boolean;
    /** 兴趣池文件路径（QQ_INTERESTS_FILE / proactive.interestsFile，默认 ./interests.yml） */
    interestsFile: string;
    /** 兴趣池是否真的读到了文件（health / 排障用：false + enabled = 配置指错了） */
    interestsLoaded: boolean;
    /** 兴趣池条目数（health 用） */
    interestsCount: number;
    /** bot 在本群的别名（BOT_BOT_ALIASES / proactive.botAliases），场景 4 指代检测用 */
    botAliases: string[];
    /** 话题滚动周期（条）：每多少条旁听消息收敛一次，场景 2/5 的入口 */
    topicRollMessages: number;
    /** 话题滚动周期（毫秒）：无仲裁时的兜底收敛间隔 */
    topicRollMs: number;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/** 富媒体出站配置（见 Config.media）。 */
export interface MediaConfig {
  /** 是否扫描并发送 outbox 产物（BOT_MEDIA_ENABLED / media.enabled） */
  enabled: boolean;
  /** 单附件体积上限（字节）。超出的文件降级为文本说明 */
  maxFileBytes: number;
  /** 单次回复最多发几个附件（超出的降级为文本说明） */
  maxAttachmentsPerMsg: number;
  /** 图片扩展名白名单（小写不带点）；其余一律按文件发 */
  imageExtensions: string[];
  /**
   * 工作区内的约定目录名（BOT_MEDIA_OUTBOX_DIR / media.outboxDir，默认 outbox）。
   * 必须是不含路径分隔符的纯目录名——它会拼进每个会话的工作区路径。
   */
  outboxDir: string;
}

/** 富媒体输入配额（见 Config.attachments）。 */
export interface AttachmentsConfig {
  /** 是否把图片内联送进模型（BOT_ATTACHMENT_ENABLED / attachments.enabled） */
  enabled: boolean;
  /** 单条消息最多内联几张图（含引用消息里的图片） */
  maxImages: number;
  /** 单张图片最大字节数，超过则只留文字说明 */
  maxImageBytes: number;
  /** 单张图片下载超时（毫秒） */
  downloadTimeoutMs: number;
  /** 转发消息块（合并转发 / 聊天记录）的展开配额 */
  forward: ForwardConfig;
  /** 文件（PDF 等）的下载与解析配额 */
  files: FilesConfig;
}

/**
 * 转发消息块的配额（见 Config.attachments.forward）。
 *
 * 四重上限刻意都保守：一个转发块动辄上百条，全量展开既烧 token 也把真正的问题
 * 淹掉。超限**不是错误**，是渲染成"仅展开以上条目"的显式说明。
 */
export interface ForwardConfig {
  /** 是否展开转发块（BOT_ATTACHMENT_FORWARD_ENABLED / attachments.forward.enabled） */
  enabled: boolean;
  /** 单个转发块最多展开几条 */
  maxNodes: number;
  /** 单条发言的字符上限（超出截断，防一条长文吃掉整个预算） */
  maxNodeChars: number;
  /** 一个转发块展开后的总字符上限 */
  maxChars: number;
  /** 最多再下钻几层嵌套转发（0 = 只展开最外层，最外层永远展开） */
  maxDepth: number;
  /** 回查超时（毫秒） */
  timeoutMs: number;
}

/**
 * 文件（PDF 等）的下载与解析配额（见 Config.attachments.files）。
 *
 * 与图片配额分开的原因：文件的"读入成本"比图片高一个量级（下载 + 落盘 + 解析
 * 子进程 + 可能两三万字的正文），共用一套数值会逼着两件事中的一个妥协。
 */
export interface FilesConfig {
  /** 是否下载并解析文件（BOT_ATTACHMENT_FILE_ENABLED / attachments.files.enabled） */
  enabled: boolean;
  /** 单条消息最多解析几个文件（超出的只列名字与体积） */
  maxFiles: number;
  /** 单文件字节上限；平台声明超限时**不下载** */
  maxFileBytes: number;
  /** 抽取文本的字符上限（超出截断并在 prompt 里说明） */
  maxExtractChars: number;
  /** PDF 最多读多少页 */
  maxPdfPages: number;
  /** 解析子进程超时（毫秒） */
  extractTimeoutMs: number;
  /** 是否把原文落到工作区的 inbox 目录（给 agent 自己深挖用） */
  saveToInbox: boolean;
  /** 工作区内的 inbox 目录名（必须是纯目录名，见 media.outboxDir 的同款校验） */
  inboxDir: string;
  /** inbox 文件保留天数，超期清理（0 = 不清理） */
  retentionDays: number;
  /** 单会话 inbox 总字节上限；超出时**删最旧的**而不是拒绝新文件 */
  maxInboxBytes: number;
  /** 允许抽取正文的扩展名白名单（小写不带点）；不在名单里的文件不下载 */
  extractExtensions: string[];
}

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

function pickString(env: Env, envKey: string, fileValue: string | undefined, fallback: string): string {
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
function assertWorkspaceSubdirName(value: string, label: string, hints: string[]): void {
  const reason =
    value === ''
      ? '不能为空（空串会让它退化成工作区根目录）'
      : value.includes('/') || value.includes('\\')
        ? '不能含路径分隔符'
        : value === '.' || value === '..'
          ? '不能是 . 或 ..'
          : undefined;
  if (reason === undefined) return;
  throw new ConfigError(
    `${label} 必须是工作区内的纯子目录名：${reason}，收到 ${JSON.stringify(value)}`,
    hints,
  );
}

function pickInt(
  env: Env,
  envKey: string,
  fileValue: number | undefined,
  fallback: number,
  range: { min: number; max: number },
  filePath: string,
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
        `配置文件里的 ${filePath} 必须在 [${range.min}, ${range.max}] 之间，收到 ${fileValue}`,
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
  fallback: boolean,
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
  filePath: string,
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
        `配置文件里的 ${filePath} 只能是 ${allowed.join(' | ')}，收到 ${JSON.stringify(fileValue)}`,
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
function buildProactiveConfig(env: Env, file: ProactiveFileConfig | undefined): Config['proactive'] {
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

  return {
    enabled: pickBool(env, 'BOT_PROACTIVE_ENABLED', file?.enabled, false),
    interestsEnabled: pickBool(env, 'BOT_PROACTIVE_INTERESTS', file?.interestsEnabled, true),
    interestsFile: pickString(env, 'QQ_INTERESTS_FILE', file?.interestsFile, 'interests.yml'),
    // 真实取值由组装层读文件后回填（见 main.ts）；配置层只知道路径。
    interestsLoaded: false,
    interestsCount: 0,
    botAliases: aliases,
    topicRollMessages: pickInt(
      env,
      'BOT_TOPIC_ROLL_MESSAGES',
      file?.topicRollMessages,
      30,
      { min: 3, max: 500 },
      'proactive.topicRollMessages',
    ),
    topicRollMs: pickInt(
      env,
      'BOT_TOPIC_ROLL_MS',
      file?.topicRollMs,
      300_000,
      { min: 10_000, max: 3_600_000 },
      'proactive.topicRollMs',
    ),
  };
}

/** 列表：env 用逗号分隔，配置文件用 YAML 数组；env 非空时以 env 为准。 */
function pickList(env: Env, envKey: string, fileValue: string[] | undefined): string[] {
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

/** 校验"进度回执必须给最终答案留配额"的不变量。 */
function assertProgressQuota(
  progressLabel: string,
  progressMax: number,
  totalLabel: string,
  total: number,
): void {
  if (progressMax >= total) {
    throw new ConfigError(
      `${progressLabel}(${progressMax}) 必须小于 ${totalLabel}(${total})，` +
        '否则进度回执会把配额用光，最终答案发不出去',
    );
  }
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
              [`可选值：${QQ_OFFICIAL_PLATFORM} | ${ONEBOT_PLATFORM}（逗号分隔可并存）`],
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
  const appId = officialEnabled ? requiredSecret(env, 'QQ_APP_ID', hints) : (envRaw(env, 'QQ_APP_ID') ?? '');
  const appSecret = officialEnabled
    ? requiredSecret(env, 'QQ_APP_SECRET', hints)
    : (envRaw(env, 'QQ_APP_SECRET') ?? '');

  // DEEPSEEK_API_KEY 不只是本进程要用：dsh 子进程继承环境（src/dsh/process.ts），
  // 所以它必须在环境里，不能只放进配置文件。
  requiredSecret(env, 'DEEPSEEK_API_KEY', hints);

  const qqFile = file.qqOfficial ?? {};
  const intents = pickInt(env, 'QQ_INTENTS', qqFile.intents, DEFAULT_INTENTS, { min: 1, max: 0x7fffffff }, 'qq-official.intents');
  if (officialEnabled && (intents & Intent.GROUP_AND_C2C_EVENT) === 0) {
    // GROUP_AND_C2C_EVENT(1<<25) 是收群聊/单聊消息的最低要求。缺了它机器人会连着但收不到
    // 消息，属于"看起来正常其实废掉"的配置错误，直接快速失败。
    throw new ConfigError(
      `QQ_INTENTS=${intents} 未包含 GROUP_AND_C2C_EVENT(1<<25)=33554432，将收不到任何群聊/单聊消息`,
      [`正确示例：QQ_INTENTS=${DEFAULT_INTENTS}（= ${describeIntents(DEFAULT_INTENTS).join(' | ')}）`],
    );
  }

  const maxRepliesPerMsg = pickInt(env, 'QQ_MAX_REPLIES_PER_MSG', qqFile.maxRepliesPerMsg, 4, { min: 1, max: 5 }, 'qq-official.maxRepliesPerMsg');
  const progressMax = pickInt(env, 'QQ_PROGRESS_MAX', qqFile.progressMax, 3, { min: 0, max: 5 }, 'qq-official.progressMax');
  // 硬性不变量：必须给最终答案留至少 1 条回复配额
  assertProgressQuota('QQ_PROGRESS_MAX', progressMax, 'QQ_MAX_REPLIES_PER_MSG', maxRepliesPerMsg);

  // 单聊：官方上限是 4 次（群聊是 5），所以单独校验，不能共用群聊的上限。
  const qqC2cFile = qqFile.c2c ?? {};
  const c2cMaxReplies = pickInt(env, 'QQ_C2C_MAX_REPLIES_PER_MSG', qqC2cFile.maxRepliesPerMsg, 4, { min: 1, max: 4 }, 'qq-official.c2c.maxRepliesPerMsg');
  const c2cProgressMax = pickInt(env, 'QQ_C2C_PROGRESS_MAX', qqC2cFile.progressMax, 2, { min: 0, max: 4 }, 'qq-official.c2c.progressMax');
  assertProgressQuota('QQ_C2C_PROGRESS_MAX', c2cProgressMax, 'QQ_C2C_MAX_REPLIES_PER_MSG', c2cMaxReplies);

  const msgTypeRaw = pickInt(env, 'QQ_MSG_TYPE', qqFile.msgType, 0, { min: 0, max: 7 }, 'qq-official.msgType');
  if (msgTypeRaw !== 0 && msgTypeRaw !== 2) {
    throw new ConfigError(
      `QQ_MSG_TYPE 本 MVP 只支持 0(纯文本) 或 2(markdown)，收到 ${msgTypeRaw}`,
      ['6(input_notify 打字状态)只有单聊支持，且本 MVP 不发送打字状态'],
    );
  }

  // 群被动回复窗口 5 分钟（官方硬约束）。单轮超时必须**小于**该窗口，
  // 否则超时后那条"任务已中断"的回复本身也会因为窗口过期而发送失败。
  // 默认 4 分钟：留出 1 分钟做收尾和发送。
  //
  // 单聊的被动窗口更宽（官方文档为 60 分钟），这里**故意共用**同一个更保守的
  // 上限：更容易配错也更难排查的是"超时提示发不出去"，而不是任务跑得不够久。
  const turnTimeoutMs = pickInt(env, 'QQ_TURN_TIMEOUT_MS', qqFile.turnTimeoutMs, 240_000, { min: 5_000, max: 295_000 }, 'qq-official.turnTimeoutMs');

  const progressAfterMs = pickInt(env, 'QQ_PROGRESS_AFTER_MS', qqFile.progressAfterMs, 90_000, { min: 1_000, max: 280_000 }, 'qq-official.progressAfterMs');
  if (officialEnabled && progressAfterMs >= turnTimeoutMs) {
    throw new ConfigError(
      `QQ_PROGRESS_AFTER_MS(${progressAfterMs}) 必须小于 QQ_TURN_TIMEOUT_MS(${turnTimeoutMs})，否则永远不会发进度回执`,
    );
  }

  // --- OneBot（社区框架；无被动窗口，配额只是防失控的安全阀） ----------------
  // access token 是密钥：只认 env，启用 onebot 时必填。
  const onebotAccessToken = onebotEnabled
    ? requiredSecret(env, 'ONEBOT_ACCESS_TOKEN', [
        'onebot 接入以 WS server 形式暴露端口，没有 token 等于把 agent 控制权交给能连上端口的任何人',
      ])
    : (envRaw(env, 'ONEBOT_ACCESS_TOKEN') ?? '');
  const obFile = file.onebot ?? {};
  const onebotMaxReplies = pickInt(env, 'ONEBOT_MAX_REPLIES_PER_MSG', obFile.maxRepliesPerMsg, 10, { min: 1, max: 50 }, 'onebot.maxRepliesPerMsg');
  const onebotProgressMax = pickInt(env, 'ONEBOT_PROGRESS_MAX', obFile.progressMax, 3, { min: 0, max: 49 }, 'onebot.progressMax');
  assertProgressQuota('ONEBOT_PROGRESS_MAX', onebotProgressMax, 'ONEBOT_MAX_REPLIES_PER_MSG', onebotMaxReplies);
  const onebotTurnTimeoutMs = pickInt(env, 'ONEBOT_TURN_TIMEOUT_MS', obFile.turnTimeoutMs, 600_000, { min: 5_000, max: 3_600_000 }, 'onebot.turnTimeoutMs');
  const onebotProgressAfterMs = pickInt(env, 'ONEBOT_PROGRESS_AFTER_MS', obFile.progressAfterMs, 90_000, { min: 1_000, max: 600_000 }, 'onebot.progressAfterMs');
  if (onebotEnabled && onebotProgressAfterMs >= onebotTurnTimeoutMs) {
    throw new ConfigError(
      `ONEBOT_PROGRESS_AFTER_MS(${onebotProgressAfterMs}) 必须小于 ONEBOT_TURN_TIMEOUT_MS(${onebotTurnTimeoutMs})，否则永远不会发进度回执`,
    );
  }

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
  const poolFile = file.pool ?? {};
  const pathsFile = file.paths ?? {};
  const attachmentsFile = file.attachments ?? {};
  const mediaFile = file.media ?? {};

  // outboxDir 会拼进每个会话的工作区路径，必须是纯目录名（不含分隔符、不是 . / ..），
  // 否则"产物只能落在会话工作区内"这条安全不变量就被配置自己打破了。
  const mediaOutboxDir = pickString(env, 'BOT_MEDIA_OUTBOX_DIR', mediaFile.outboxDir, 'outbox');
  assertWorkspaceSubdirName(mediaOutboxDir, 'media 的 outboxDir', [
    '正确示例：outbox、deliverables',
  ]);

  const mediaImageExtensionsRaw = pickList(env, 'BOT_MEDIA_IMAGE_EXTENSIONS', mediaFile.imageExtensions);
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
    'inbox',
  );
  assertWorkspaceSubdirName(attachmentInboxDir, 'attachments.files.inboxDir', [
    '正确示例：inbox、uploads',
  ]);
  if (attachmentInboxDir === mediaOutboxDir) {
    throw new ConfigError(
      `attachments.files.inboxDir 与 media.outboxDir 不能同名（都是 ${JSON.stringify(attachmentInboxDir)}）`,
      [
        'inbox 放用户发来的文件、outbox 放要发回用户的产物；同名会让用户发来的文件被立刻回发给自己',
      ],
    );
  }

  const attachmentExtensionsRaw = pickList(
    env,
    'BOT_ATTACHMENT_FILE_EXTENSIONS',
    attachmentsFile.files?.extractExtensions,
  );
  const attachmentExtensions = (
    attachmentExtensionsRaw.length > 0
      ? attachmentExtensionsRaw
      : ['pdf', 'txt', 'md', 'csv', 'json', 'yaml', 'yml', 'log', 'xml', 'html']
  )
    .map((ext) => ext.trim().toLowerCase().replace(/^\./, ''))
    // 空串会被 extensionOf('') 之外的调用方当成"任意无扩展名文件都命中白名单"
    .filter((ext) => ext !== '');

  return {
    connectors: enabledConnectors,
    admins,
    qq: {
      appId,
      appSecret,
      apiBase: pickString(env, 'QQ_API_BASE', qqFile.apiBase, 'https://api.bot.qq.com'),
      intents,
      msgType: msgTypeRaw as 0 | 2,
      maxChars: pickInt(env, 'QQ_MAX_CHARS', qqFile.maxChars, 1500, { min: 100, max: 4000 }, 'qq-official.maxChars'),
      maxRepliesPerMsg,
      progressAfterMs,
      progressIntervalMs: pickInt(env, 'QQ_PROGRESS_INTERVAL_MS', qqFile.progressIntervalMs, 90_000, { min: 1_000, max: 280_000 }, 'qq-official.progressIntervalMs'),
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
      port: pickInt(env, 'ONEBOT_WS_PORT', obFile.port, 6700, { min: 0, max: 65_535 }, 'onebot.port'),
      accessToken: onebotAccessToken,
      c2cEnabled: pickBool(env, 'ONEBOT_C2C_ENABLED', obFile.c2cEnabled, true),
      maxChars: pickInt(env, 'ONEBOT_MAX_CHARS', obFile.maxChars, 1500, { min: 100, max: 4500 }, 'onebot.maxChars'),
      maxRepliesPerMsg: onebotMaxReplies,
      progressMax: onebotProgressMax,
      progressAfterMs: onebotProgressAfterMs,
      progressIntervalMs: pickInt(env, 'ONEBOT_PROGRESS_INTERVAL_MS', obFile.progressIntervalMs, 90_000, { min: 1_000, max: 600_000 }, 'onebot.progressIntervalMs'),
      turnTimeoutMs: onebotTurnTimeoutMs,
      autoAcceptFriend: pickBool(env, 'ONEBOT_AUTO_ACCEPT_FRIEND', obFile.autoAcceptFriend, true),
      autoAcceptGroupInvite: pickBool(env, 'ONEBOT_AUTO_ACCEPT_GROUP_INVITE', obFile.autoAcceptGroupInvite, false),
      fileTransport: pickEnum(env, 'ONEBOT_FILE_TRANSPORT', obFile.fileTransport, ['base64', 'path'] as const, 'base64', 'onebot.fileTransport'),
    },
    dsh: {
      provider: pickString(env, 'DSH_PROVIDER', dshFile.provider, 'deepseek-official'),
      model: pickString(env, 'DSH_MODEL', dshFile.model, 'deepseek-flash'),
      profilePatch: pickString(env, 'QQ_DSH_PROFILE_PATCH', dshFile.profilePatch, '/app/dsh-profile/cordis.patch.yml'),
      bin: pickString(env, 'QQ_DSH_BIN', dshFile.bin, 'dsh'),
      runtimeStartTimeoutMs: pickInt(env, 'QQ_DSH_START_TIMEOUT_MS', dshFile.startTimeoutMs, 60_000, { min: 5_000, max: 300_000 }, 'dsh.startTimeoutMs'),
      runtimeShutdownTimeoutMs: pickInt(env, 'QQ_DSH_SHUTDOWN_TIMEOUT_MS', dshFile.shutdownTimeoutMs, 15_000, { min: 2_000, max: 120_000 }, 'dsh.shutdownTimeoutMs'),
    },
    pool: {
      maxConcurrentTurns: pickInt(env, 'QQ_MAX_CONCURRENT_TURNS', poolFile.maxConcurrentTurns, 4, { min: 1, max: 64 }, 'pool.maxConcurrentTurns'),
      maxRuntimes: pickInt(env, 'QQ_MAX_RUNTIMES', poolFile.maxRuntimes, 8, { min: 1, max: 128 }, 'pool.maxRuntimes'),
      runtimeIdleMs: pickInt(env, 'QQ_RUNTIME_IDLE_MS', poolFile.runtimeIdleMs, 1_800_000, { min: 0, max: 86_400_000 }, 'pool.runtimeIdleMs'),
      replayTurns: pickInt(env, 'QQ_REPLAY_TURNS', poolFile.replayTurns, 12, { min: 0, max: 200 }, 'pool.replayTurns'),
    },
    topic: {
      enabled: pickBool(env, 'BOT_TOPIC_ENABLED', file.topic?.enabled, true),
      apiBase: pickString(env, 'BOT_TOPIC_API_BASE', file.topic?.apiBase, 'https://api.deepseek.com'),
      model: pickString(env, 'BOT_TOPIC_MODEL', file.topic?.model, 'deepseek-flash'),
      timeoutMs: pickInt(env, 'BOT_TOPIC_TIMEOUT_MS', file.topic?.timeoutMs, 10_000, { min: 1_000, max: 60_000 }, 'topic.timeoutMs'),
      contextTurns: pickInt(env, 'BOT_TOPIC_CONTEXT_TURNS', file.topic?.contextTurns, 10, { min: 1, max: 50 }, 'topic.contextTurns'),
    },
    paths: {
      dshHome: pickString(env, 'DSH_HOME', pathsFile.dshHome, '/data/dsh'),
      workspacesRoot: pickString(env, 'QQ_WORKSPACES_ROOT', pathsFile.workspacesRoot, '/data/workspaces'),
      stateDir: pickString(env, 'QQ_STATE_DIR', pathsFile.stateDir, '/data/bot'),
    },
    offpeak: {
      enabled: pickBool(env, 'QQ_OFFPEAK_ENABLED', file.offpeak?.enabled, false),
      windows: offpeakWindows,
      timeZone: offpeakTimeZone,
      modelPattern: pickString(env, 'QQ_OFFPEAK_MODEL_PATTERN', file.offpeak?.modelPattern, 'deepseek'),
      weekendsAllDay: pickBool(env, 'QQ_OFFPEAK_WEEKENDS', file.offpeak?.weekendsAllDay, true),
      holidays: offpeakHolidays,
    },
    attachments: {
      enabled: pickBool(env, 'BOT_ATTACHMENT_ENABLED', attachmentsFile.enabled, true),
      // 上限都刻意保守：一条消息塞十几张图既烧 token 又压不住延迟，
      // 而 QQ 单图硬上限是 200MB，绝不能照抄。
      maxImages: pickInt(env, 'BOT_ATTACHMENT_MAX_IMAGES', attachmentsFile.maxImages, 4, { min: 0, max: 20 }, 'attachments.maxImages'),
      maxImageBytes: pickInt(env, 'BOT_ATTACHMENT_MAX_BYTES', attachmentsFile.maxImageBytes, 8 * 1024 * 1024, { min: 1024, max: 200 * 1024 * 1024 }, 'attachments.maxImageBytes'),
      downloadTimeoutMs: pickInt(env, 'BOT_ATTACHMENT_TIMEOUT_MS', attachmentsFile.downloadTimeoutMs, 15_000, { min: 1_000, max: 120_000 }, 'attachments.downloadTimeoutMs'),
      forward: {
        enabled: pickBool(env, 'BOT_ATTACHMENT_FORWARD_ENABLED', attachmentsFile.forward?.enabled, true),
        // 20 条 ≈ 群里一次"爬楼"转发的常见规模；再多模型也读不完，只是烧 token。
        maxNodes: pickInt(env, 'BOT_ATTACHMENT_FORWARD_MAX_NODES', attachmentsFile.forward?.maxNodes, 20, { min: 1, max: 100 }, 'attachments.forward.maxNodes'),
        maxNodeChars: pickInt(env, 'BOT_ATTACHMENT_FORWARD_MAX_NODE_CHARS', attachmentsFile.forward?.maxNodeChars, 500, { min: 50, max: 5_000 }, 'attachments.forward.maxNodeChars'),
        // 总字符上限：4000 字 ≈ 一篇长文，足够读懂"这捆记录在聊什么"。
        maxChars: pickInt(env, 'BOT_ATTACHMENT_FORWARD_MAX_CHARS', attachmentsFile.forward?.maxChars, 4_000, { min: 200, max: 40_000 }, 'attachments.forward.maxChars'),
        maxDepth: pickInt(env, 'BOT_ATTACHMENT_FORWARD_MAX_DEPTH', attachmentsFile.forward?.maxDepth, 2, { min: 0, max: 5 }, 'attachments.forward.maxDepth'),
        timeoutMs: pickInt(env, 'BOT_ATTACHMENT_FORWARD_TIMEOUT_MS', attachmentsFile.forward?.timeoutMs, 10_000, { min: 1_000, max: 60_000 }, 'attachments.forward.timeoutMs'),
      },
      files: {
        enabled: pickBool(env, 'BOT_ATTACHMENT_FILE_ENABLED', attachmentsFile.files?.enabled, true),
        maxFiles: pickInt(env, 'BOT_ATTACHMENT_FILE_MAX_FILES', attachmentsFile.files?.maxFiles, 2, { min: 0, max: 10 }, 'attachments.files.maxFiles'),
        // 16MB：够放下常规 PDF/报表，又不至于让下载+落盘+解析把一轮拖垮。
        maxFileBytes: pickInt(env, 'BOT_ATTACHMENT_FILE_MAX_BYTES', attachmentsFile.files?.maxFileBytes, 16 * 1024 * 1024, { min: 1024, max: 200 * 1024 * 1024 }, 'attachments.files.maxFileBytes'),
        // 20000 字 ≈ 30 页纯文字 PDF，是"能读懂"与"不撑爆 prompt"的分界。
        maxExtractChars: pickInt(env, 'BOT_ATTACHMENT_FILE_MAX_CHARS', attachmentsFile.files?.maxExtractChars, 20_000, { min: 200, max: 200_000 }, 'attachments.files.maxExtractChars'),
        maxPdfPages: pickInt(env, 'BOT_ATTACHMENT_FILE_MAX_PDF_PAGES', attachmentsFile.files?.maxPdfPages, 30, { min: 1, max: 500 }, 'attachments.files.maxPdfPages'),
        extractTimeoutMs: pickInt(env, 'BOT_ATTACHMENT_FILE_TIMEOUT_MS', attachmentsFile.files?.extractTimeoutMs, 10_000, { min: 1_000, max: 120_000 }, 'attachments.files.extractTimeoutMs'),
        saveToInbox: pickBool(env, 'BOT_ATTACHMENT_FILE_SAVE', attachmentsFile.files?.saveToInbox, true),
        inboxDir: attachmentInboxDir,
        // 0 = 永不清理；默认 7 天，让"上周发的那份 PDF"还找得到。
        retentionDays: pickInt(env, 'BOT_ATTACHMENT_INBOX_RETENTION_DAYS', attachmentsFile.files?.retentionDays, 7, { min: 0, max: 365 }, 'attachments.files.retentionDays'),
        // 单会话 200MB 上限；与 media.maxFileMB 一样用 MB —— 这是运维旋钮，
        // 不需要字节级精度（单文件上限才是安全边界，用字节）。
        maxInboxBytes:
          pickInt(env, 'BOT_ATTACHMENT_INBOX_MAX_MB', attachmentsFile.files?.maxInboxMB, 200, { min: 1, max: 5_000 }, 'attachments.files.maxInboxMB') *
          1024 *
          1024,
        extractExtensions: attachmentExtensions,
      },
    },
    media: {
      enabled: pickBool(env, 'BOT_MEDIA_ENABLED', mediaFile.enabled, true),
      // 默认 20MB：base64 传输膨胀 +33%，再大既拖慢发送也容易撞上平台/框架的上限
      maxFileBytes:
        pickInt(env, 'BOT_MEDIA_MAX_FILE_MB', mediaFile.maxFileMB, 20, { min: 1, max: 100 }, 'media.maxFileMB') *
        1024 *
        1024,
      maxAttachmentsPerMsg: pickInt(env, 'BOT_MEDIA_MAX_ATTACHMENTS', mediaFile.maxAttachmentsPerMsg, 4, { min: 1, max: 10 }, 'media.maxAttachmentsPerMsg'),
      imageExtensions: mediaImageExtensions,
      outboxDir: mediaOutboxDir,
    },
    health: {
      port: pickInt(env, 'QQ_HEALTH_PORT', file.health?.port, 8080, { min: 0, max: 65_535 }, 'health.port'),
    },
    proactive: buildProactiveConfig(env, file.proactive),
    logLevel: pickEnum(env, 'QQ_LOG_LEVEL', file.logLevel, ['debug', 'info', 'warn', 'error'] as const, 'info', 'logLevel'),
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
          progress: {
            afterMs: config.qq.progressAfterMs,
            intervalMs: config.qq.progressIntervalMs,
            max: config.qq.progressMax,
          },
          turnTimeoutMs: config.qq.turnTimeoutMs,
          c2c: config.qq.c2c,
        }
      : 'disabled',
    onebot: config.connectors.includes(ONEBOT_PLATFORM)
      ? {
          listen: `${config.onebot.host}:${config.onebot.port}`,
          c2cEnabled: config.onebot.c2cEnabled,
          maxChars: config.onebot.maxChars,
          maxRepliesPerMsg: config.onebot.maxRepliesPerMsg,
          progressMax: config.onebot.progressMax,
          turnTimeoutMs: config.onebot.turnTimeoutMs,
          autoAcceptFriend: config.onebot.autoAcceptFriend,
          autoAcceptGroupInvite: config.onebot.autoAcceptGroupInvite,
        }
      : 'disabled',
    dsh: {
      provider: config.dsh.provider,
      model: config.dsh.model,
      profilePatch: config.dsh.profilePatch,
    },
    pool: config.pool,
    topic: {
      enabled: config.topic.enabled,
      model: config.topic.model,
      timeoutMs: config.topic.timeoutMs,
      contextTurns: config.topic.contextTurns,
    },
    paths: config.paths,
    adminCount: config.admins.length,
    proactive: {
      enabled: config.proactive.enabled,
      interests: {
        enabled: config.proactive.interestsEnabled,
        file: config.proactive.interestsFile,
        loaded: config.proactive.interestsLoaded,
        count: config.proactive.interestsCount,
      },
      botAliases: config.proactive.botAliases,
      topicRoll: {
        messages: config.proactive.topicRollMessages,
        ms: config.proactive.topicRollMs,
      },
    },
    attachments: config.attachments,
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
