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
import type { FileConfig } from './config-file.js';
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
  if (
    mediaOutboxDir.includes('/') ||
    mediaOutboxDir.includes('\\') ||
    mediaOutboxDir === '.' ||
    mediaOutboxDir === '..'
  ) {
    throw new ConfigError(
      `media 的 outboxDir 必须是纯目录名（不含路径分隔符），收到 ${JSON.stringify(mediaOutboxDir)}`,
      ['正确示例：outbox、deliverables'],
    );
  }

  const mediaImageExtensionsRaw = pickList(env, 'BOT_MEDIA_IMAGE_EXTENSIONS', mediaFile.imageExtensions);
  const mediaImageExtensions = (
    mediaImageExtensionsRaw.length > 0 ? mediaImageExtensionsRaw : ['png', 'jpg', 'jpeg', 'gif']
  ).map((ext) => ext.trim().toLowerCase().replace(/^\./, ''));

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
    paths: config.paths,
    adminCount: config.admins.length,
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
