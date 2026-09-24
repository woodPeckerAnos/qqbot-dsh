/**
 * 配置层：从环境变量解析 + 启动期快速失败。
 *
 * 设计原则：
 *   - 所有可调参数集中在这里，其余模块不直接读 process.env；
 *   - 必填项缺失立刻抛错并说清怎么修，不等到运行中途才发现；
 *   - 数值项做范围校验，避免"配错了但看起来在跑"。
 *
 * 多接入模型：
 *   - `BOT_CONNECTORS` 决定启用哪些接入平台（qq-official / onebot，可并存）；
 *   - 每个平台有自己的配置块（config.qq / config.onebot），只在启用时才校验必填项；
 *   - 回复行为的差异（配额、分段、单轮超时）经各平台的 ReplyPolicy 表达，
 *     编排层不再引用本文件里的平台字段。
 *
 * 不使用任何 schema 库：纯 TS 实现更容易单测，也少一个依赖。
 */

import { Intent, DEFAULT_INTENTS, describeIntents } from './adapters/qq-official/types.js';
import { QQ_OFFICIAL_PLATFORM } from './adapters/qq-official/gateway.js';
import { ONEBOT_PLATFORM } from './adapters/onebot/connector.js';
import { isValidDateString, isValidTimeZone, parseTimeHHMM, OffpeakConfigError } from './offpeak.js';

export type ConnectorName = typeof QQ_OFFICIAL_PLATFORM | typeof ONEBOT_PLATFORM;

export interface Config {
  /** 启用的接入平台（BOT_CONNECTORS，逗号分隔） */
  connectors: ConnectorName[];
  /**
   * 管理员白名单（BOT_ADMINS，逗号分隔），条目格式为 `platform:senderId`，
   * 例如 `qq-official:ABCDEF...` 或 `onebot:123456`。
   * 兼容项：QQ_ADMIN_OPENIDS 里的裸 openid 会自动加上 `qq-official:` 前缀。
   * 留空 = 没有管理员，/offpeak 的变更类子命令对所有人关闭（fail-closed）。
   */
  admins: string[];
  /** 官方开放平台接入（仅 connectors 含 qq-official 时有意义） */
  qq: {
    appId: string;
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
    /** 反向 WS 监听地址（本服务起 server，NapCat 等作为客户端连入） */
    host: string;
    port: number;
    /** 连接鉴权 token（OneBot 的 access_token；启用 onebot 时必填） */
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
   * 运行期可被管理员 /offpeak 命令覆盖（见 offpeak.ts），这里只是 env 默认层。
   */
  offpeak: {
    /** 总开关（QQ_OFFPEAK_ENABLED，默认 false） */
    enabled: boolean;
    /** 窗口起，HH:MM（QQ_OFFPEAK_START，默认 00:30） */
    start: string;
    /** 窗口止，HH:MM（QQ_OFFPEAK_END，默认 08:30），区间为 [start, end) */
    end: string;
    /** 窗口所在时区（QQ_OFFPEAK_TZ，默认 Asia/Shanghai） */
    timeZone: string;
    /** 命中判定：`<provider>/<model>` 包含该子串（QQ_OFFPEAK_MODEL_PATTERN，默认 deepseek） */
    modelPattern: string;
    /** 周六、周日全天谷价（QQ_OFFPEAK_WEEKENDS，默认 true，DeepSeek 2026-08-23 起规则） */
    weekendsAllDay: boolean;
    /** 追加的全天谷价日期（QQ_OFFPEAK_HOLIDAYS，逗号分隔 YYYY-MM-DD），与内置官方节假日表合并 */
    holidays: string[];
  };
  health: {
    port: number;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function requiredString(env: Env, key: string, hints: string[] = []): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(`缺少必需环境变量 ${key}`, hints);
  }
  return raw.trim();
}

function optionalString(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function optionalInt(
  env: Env,
  key: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConfigError(`${key} 必须是整数，收到 ${JSON.stringify(raw)}`);
  }
  if (value < range.min || value > range.max) {
    throw new ConfigError(`${key} 必须在 [${range.min}, ${range.max}] 之间，收到 ${value}`);
  }
  return value;
}

function optionalEnum<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim() as T;
  if (!allowed.includes(value)) {
    throw new ConfigError(`${key} 只能是 ${allowed.join(' | ')}，收到 ${JSON.stringify(raw)}`);
  }
  return value;
}

/** 布尔解析：接受 true/false/1/0/yes/no（大小写不敏感），其余视为配置错误。 */
function optionalBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`${key} 只能是 true/false（也接受 1/0），收到 ${JSON.stringify(raw)}`);
}

function optionalList(env: Env, key: string): string[] {
  return optionalString(env, key, '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 校验"进度回执必须给最终答案留配额"的不变量。 */
function assertProgressQuota(envKeyProgress: string, progressMax: number, envKeyTotal: string, total: number): void {
  if (progressMax >= total) {
    throw new ConfigError(
      `${envKeyProgress}(${progressMax}) 必须小于 ${envKeyTotal}(${total})，` +
        '否则进度回执会把配额用光，最终答案发不出去',
    );
  }
}

export function loadConfig(env: Env = process.env): Config {
  const hints = ['请复制 .env.example 为 .env 并填写后重试'];

  // --- 接入平台选择 ---------------------------------------------------------
  const connectorsRaw = optionalList(env, 'BOT_CONNECTORS');
  const connectors: ConnectorName[] =
    connectorsRaw.length === 0
      ? [QQ_OFFICIAL_PLATFORM]
      : connectorsRaw.map((name) => {
          if (name !== QQ_OFFICIAL_PLATFORM && name !== ONEBOT_PLATFORM) {
            throw new ConfigError(`BOT_CONNECTORS 含未知平台：${JSON.stringify(name)}`, [
              `可选值：${QQ_OFFICIAL_PLATFORM} | ${ONEBOT_PLATFORM}（逗号分隔可并存）`,
            ]);
          }
          return name;
        });
  // 去重，避免重复启动同一个接入
  const enabledConnectors = [...new Set(connectors)];
  const officialEnabled = enabledConnectors.includes(QQ_OFFICIAL_PLATFORM);
  const onebotEnabled = enabledConnectors.includes(ONEBOT_PLATFORM);

  // --- 官方开放平台（仅启用时校验必填项与配额不变量） ------------------------
  const appId = officialEnabled ? requiredString(env, 'QQ_APP_ID', hints) : optionalString(env, 'QQ_APP_ID', '');
  const appSecret = officialEnabled
    ? requiredString(env, 'QQ_APP_SECRET', hints)
    : optionalString(env, 'QQ_APP_SECRET', '');

  requiredString(env, 'DEEPSEEK_API_KEY', hints);

  const intents = optionalInt(env, 'QQ_INTENTS', DEFAULT_INTENTS, { min: 1, max: 0x7fffffff });
  if (officialEnabled && (intents & Intent.GROUP_AND_C2C_EVENT) === 0) {
    // GROUP_AND_C2C_EVENT(1<<25) 是收群聊/单聊消息的最低要求。缺了它机器人会连着但收不到
    // 消息，属于"看起来正常其实废掉"的配置错误，直接快速失败。
    throw new ConfigError(
      `QQ_INTENTS=${intents} 未包含 GROUP_AND_C2C_EVENT(1<<25)=33554432，将收不到任何群聊/单聊消息`,
      [`正确示例：QQ_INTENTS=${DEFAULT_INTENTS}（= ${describeIntents(DEFAULT_INTENTS).join(' | ')}）`],
    );
  }

  const maxRepliesPerMsg = optionalInt(env, 'QQ_MAX_REPLIES_PER_MSG', 4, { min: 1, max: 5 });
  const progressMax = optionalInt(env, 'QQ_PROGRESS_MAX', 3, { min: 0, max: 5 });
  // 硬性不变量：必须给最终答案留至少 1 条回复配额
  assertProgressQuota('QQ_PROGRESS_MAX', progressMax, 'QQ_MAX_REPLIES_PER_MSG', maxRepliesPerMsg);

  // 单聊：官方上限是 4 次（群聊是 5），所以单独校验，不能共用群聊的上限。
  const c2cMaxReplies = optionalInt(env, 'QQ_C2C_MAX_REPLIES_PER_MSG', 4, { min: 1, max: 4 });
  const c2cProgressMax = optionalInt(env, 'QQ_C2C_PROGRESS_MAX', 2, { min: 0, max: 4 });
  assertProgressQuota('QQ_C2C_PROGRESS_MAX', c2cProgressMax, 'QQ_C2C_MAX_REPLIES_PER_MSG', c2cMaxReplies);

  const msgTypeRaw = optionalInt(env, 'QQ_MSG_TYPE', 0, { min: 0, max: 7 });
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
  const turnTimeoutMs = optionalInt(env, 'QQ_TURN_TIMEOUT_MS', 240_000, { min: 5_000, max: 295_000 });

  const progressAfterMs = optionalInt(env, 'QQ_PROGRESS_AFTER_MS', 90_000, { min: 1_000, max: 280_000 });
  if (officialEnabled && progressAfterMs >= turnTimeoutMs) {
    throw new ConfigError(
      `QQ_PROGRESS_AFTER_MS(${progressAfterMs}) 必须小于 QQ_TURN_TIMEOUT_MS(${turnTimeoutMs})，否则永远不会发进度回执`,
    );
  }

  // --- OneBot（社区框架；无被动窗口，配额只是防失控的安全阀） ----------------
  const onebotAccessToken = onebotEnabled
    ? requiredString(env, 'ONEBOT_ACCESS_TOKEN', [
        'onebot 接入以 WS server 形式暴露端口，没有 token 等于把 agent 控制权交给能连上端口的任何人',
      ])
    : optionalString(env, 'ONEBOT_ACCESS_TOKEN', '');
  const onebotMaxReplies = optionalInt(env, 'ONEBOT_MAX_REPLIES_PER_MSG', 10, { min: 1, max: 50 });
  const onebotProgressMax = optionalInt(env, 'ONEBOT_PROGRESS_MAX', 3, { min: 0, max: 49 });
  assertProgressQuota('ONEBOT_PROGRESS_MAX', onebotProgressMax, 'ONEBOT_MAX_REPLIES_PER_MSG', onebotMaxReplies);
  const onebotTurnTimeoutMs = optionalInt(env, 'ONEBOT_TURN_TIMEOUT_MS', 600_000, {
    min: 5_000,
    max: 3_600_000,
  });
  const onebotProgressAfterMs = optionalInt(env, 'ONEBOT_PROGRESS_AFTER_MS', 90_000, {
    min: 1_000,
    max: 600_000,
  });
  if (onebotEnabled && onebotProgressAfterMs >= onebotTurnTimeoutMs) {
    throw new ConfigError(
      `ONEBOT_PROGRESS_AFTER_MS(${onebotProgressAfterMs}) 必须小于 ONEBOT_TURN_TIMEOUT_MS(${onebotTurnTimeoutMs})，否则永远不会发进度回执`,
    );
  }

  // --- 管理员白名单：platform:senderId；兼容裸 openid 的旧变量 ----------------
  const admins = [...optionalList(env, 'BOT_ADMINS')];
  for (const legacy of optionalList(env, 'QQ_ADMIN_OPENIDS')) {
    // 裸 openid 一律按官方平台解释（该变量本来的语义）
    admins.push(legacy.includes(':') ? legacy : `${QQ_OFFICIAL_PLATFORM}:${legacy}`);
  }

  // --- 谷时段闸：格式错误在启动期爆出来，不等到拦截时才发觉配错 -------------
  const offpeakStart = optionalString(env, 'QQ_OFFPEAK_START', '00:30');
  const offpeakEnd = optionalString(env, 'QQ_OFFPEAK_END', '08:30');
  const offpeakTimeZone = optionalString(env, 'QQ_OFFPEAK_TZ', 'Asia/Shanghai');
  try {
    const startMin = parseTimeHHMM(offpeakStart);
    const endMin = parseTimeHHMM(offpeakEnd);
    if (startMin === endMin) {
      throw new OffpeakConfigError('QQ_OFFPEAK_START 与 QQ_OFFPEAK_END 不能相同（那会是一个空窗口）');
    }
  } catch (error) {
    if (error instanceof OffpeakConfigError) {
      throw new ConfigError(`谷时段窗口配置无效：${error.message}`, [
        '格式为 HH:MM，例如 QQ_OFFPEAK_START=00:30 / QQ_OFFPEAK_END=08:30',
      ]);
    }
    throw error;
  }
  if (!isValidTimeZone(offpeakTimeZone)) {
    throw new ConfigError(`QQ_OFFPEAK_TZ 不是有效时区：${JSON.stringify(offpeakTimeZone)}`, [
      '使用 IANA 时区名，例如 Asia/Shanghai、UTC',
    ]);
  }
  const offpeakHolidays = optionalList(env, 'QQ_OFFPEAK_HOLIDAYS');
  for (const date of offpeakHolidays) {
    if (!isValidDateString(date)) {
      throw new ConfigError(`QQ_OFFPEAK_HOLIDAYS 含无效日期：${JSON.stringify(date)}`, [
        '格式为逗号分隔的 YYYY-MM-DD，例如 QQ_OFFPEAK_HOLIDAYS=2027-01-01,2027-01-02',
        '内置已含 2026 年官方节假日（国办发明电〔2025〕7 号），这里只需追加跨年或临时日期',
      ]);
    }
  }

  return {
    connectors: enabledConnectors,
    admins,
    qq: {
      appId,
      appSecret,
      apiBase: optionalString(env, 'QQ_API_BASE', 'https://api.bot.qq.com'),
      intents,
      msgType: msgTypeRaw as 0 | 2,
      maxChars: optionalInt(env, 'QQ_MAX_CHARS', 1500, { min: 100, max: 4000 }),
      maxRepliesPerMsg,
      progressAfterMs,
      progressIntervalMs: optionalInt(env, 'QQ_PROGRESS_INTERVAL_MS', 90_000, { min: 1_000, max: 280_000 }),
      progressMax,
      turnTimeoutMs,
      c2c: {
        enabled: optionalBool(env, 'QQ_C2C_ENABLED', true),
        maxRepliesPerMsg: c2cMaxReplies,
        progressMax: c2cProgressMax,
      },
    },
    onebot: {
      host: optionalString(env, 'ONEBOT_WS_HOST', '0.0.0.0'),
      port: optionalInt(env, 'ONEBOT_WS_PORT', 6700, { min: 0, max: 65_535 }),
      accessToken: onebotAccessToken,
      c2cEnabled: optionalBool(env, 'ONEBOT_C2C_ENABLED', true),
      maxChars: optionalInt(env, 'ONEBOT_MAX_CHARS', 1500, { min: 100, max: 4500 }),
      maxRepliesPerMsg: onebotMaxReplies,
      progressMax: onebotProgressMax,
      progressAfterMs: onebotProgressAfterMs,
      progressIntervalMs: optionalInt(env, 'ONEBOT_PROGRESS_INTERVAL_MS', 90_000, {
        min: 1_000,
        max: 600_000,
      }),
      turnTimeoutMs: onebotTurnTimeoutMs,
      autoAcceptFriend: optionalBool(env, 'ONEBOT_AUTO_ACCEPT_FRIEND', true),
      autoAcceptGroupInvite: optionalBool(env, 'ONEBOT_AUTO_ACCEPT_GROUP_INVITE', false),
    },
    dsh: {
      provider: optionalString(env, 'DSH_PROVIDER', 'deepseek-official'),
      model: optionalString(env, 'DSH_MODEL', 'deepseek-flash'),
      profilePatch: optionalString(env, 'QQ_DSH_PROFILE_PATCH', '/app/dsh-profile/cordis.patch.yml'),
      bin: optionalString(env, 'QQ_DSH_BIN', 'dsh'),
      runtimeStartTimeoutMs: optionalInt(env, 'QQ_DSH_START_TIMEOUT_MS', 60_000, { min: 5_000, max: 300_000 }),
      runtimeShutdownTimeoutMs: optionalInt(env, 'QQ_DSH_SHUTDOWN_TIMEOUT_MS', 15_000, {
        min: 2_000,
        max: 120_000,
      }),
    },
    pool: {
      maxConcurrentTurns: optionalInt(env, 'QQ_MAX_CONCURRENT_TURNS', 4, { min: 1, max: 64 }),
      maxRuntimes: optionalInt(env, 'QQ_MAX_RUNTIMES', 8, { min: 1, max: 128 }),
      runtimeIdleMs: optionalInt(env, 'QQ_RUNTIME_IDLE_MS', 1_800_000, { min: 0, max: 86_400_000 }),
      replayTurns: optionalInt(env, 'QQ_REPLAY_TURNS', 12, { min: 0, max: 200 }),
    },
    paths: {
      dshHome: optionalString(env, 'DSH_HOME', '/data/dsh'),
      workspacesRoot: optionalString(env, 'QQ_WORKSPACES_ROOT', '/data/workspaces'),
      stateDir: optionalString(env, 'QQ_STATE_DIR', '/data/bot'),
    },
    offpeak: {
      enabled: optionalBool(env, 'QQ_OFFPEAK_ENABLED', false),
      start: offpeakStart,
      end: offpeakEnd,
      timeZone: offpeakTimeZone,
      modelPattern: optionalString(env, 'QQ_OFFPEAK_MODEL_PATTERN', 'deepseek'),
      weekendsAllDay: optionalBool(env, 'QQ_OFFPEAK_WEEKENDS', true),
      holidays: offpeakHolidays,
    },
    health: {
      port: optionalInt(env, 'QQ_HEALTH_PORT', 8080, { min: 0, max: 65_535 }),
    },
    logLevel: optionalEnum(env, 'QQ_LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
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
    offpeak: {
      enabled: config.offpeak.enabled,
      window: `${config.offpeak.start}–${config.offpeak.end}`,
      timeZone: config.offpeak.timeZone,
      modelPattern: config.offpeak.modelPattern,
      weekendsAllDay: config.offpeak.weekendsAllDay,
      extraHolidays: config.offpeak.holidays.length,
    },
  };
}
