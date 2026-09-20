/**
 * 配置层：从环境变量解析 + 启动期快速失败。
 *
 * 设计原则：
 *   - 所有可调参数集中在这里，其余模块不直接读 process.env；
 *   - 必填项缺失立刻抛错并说清怎么修，不等到运行中途才发现；
 *   - 数值项做范围校验，避免"配错了但看起来在跑"。
 *
 * 不使用任何 schema 库：纯 TS 实现更容易单测，也少一个依赖。
 */

import { Intent, DEFAULT_INTENTS, describeIntents } from './qq/types.js';
import { isValidTimeZone, parseTimeHHMM, OffpeakConfigError } from './offpeak.js';

export interface Config {
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
    /**
     * 管理员 openid 白名单（QQ_ADMIN_OPENIDS，逗号分隔）。
     * 管理员永不被谷时段闸拦截，且可用 /offpeak 命令热切换闸配置。
     * 注意：群聊里是 member_openid，单聊里是 user_openid，同一个人两个值不同。
     * 留空 = 没有管理员，命令的变更类子命令对所有人关闭（fail-closed）。
     */
    adminOpenids: string[];
    c2c: {
      /** 是否响应单聊消息（false = 只服务群聊） */
      enabled: boolean;
      /** 单聊每条消息的最大回复条数（官方上限 4） */
      maxRepliesPerMsg: number;
      /** 单聊进度回执条数上限，必须 < maxRepliesPerMsg */
      progressMax: number;
    };
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

export function loadConfig(env: Env = process.env): Config {
  const hints = ['请复制 .env.example 为 .env 并填写后重试'];

  const appId = requiredString(env, 'QQ_APP_ID', hints);
  const appSecret = requiredString(env, 'QQ_APP_SECRET', hints);
  requiredString(env, 'DEEPSEEK_API_KEY', hints);

  const intents = optionalInt(env, 'QQ_INTENTS', DEFAULT_INTENTS, { min: 1, max: 0x7fffffff });
  // GROUP_AND_C2C_EVENT(1<<25) 是收群聊/单聊消息的最低要求。缺了它机器人会连着但收不到
  // 消息，属于"看起来正常其实废掉"的配置错误，直接快速失败。
  if ((intents & Intent.GROUP_AND_C2C_EVENT) === 0) {
    throw new ConfigError(
      `QQ_INTENTS=${intents} 未包含 GROUP_AND_C2C_EVENT(1<<25)=33554432，将收不到任何群聊/单聊消息`,
      [`正确示例：QQ_INTENTS=${DEFAULT_INTENTS}（= ${describeIntents(DEFAULT_INTENTS).join(' | ')}）`],
    );
  }

  const maxRepliesPerMsg = optionalInt(env, 'QQ_MAX_REPLIES_PER_MSG', 4, { min: 1, max: 5 });
  const progressMax = optionalInt(env, 'QQ_PROGRESS_MAX', 3, { min: 0, max: 5 });
  // 硬性不变量：必须给最终答案留至少 1 条回复配额
  if (progressMax >= maxRepliesPerMsg) {
    throw new ConfigError(
      `QQ_PROGRESS_MAX(${progressMax}) 必须小于 QQ_MAX_REPLIES_PER_MSG(${maxRepliesPerMsg})，` +
        '否则进度回执会把配额用光，最终答案发不出去',
    );
  }

  // 单聊：官方上限是 4 次（群聊是 5），所以单独校验，不能共用群聊的上限。
  const c2cMaxReplies = optionalInt(env, 'QQ_C2C_MAX_REPLIES_PER_MSG', 4, { min: 1, max: 4 });
  const c2cProgressMax = optionalInt(env, 'QQ_C2C_PROGRESS_MAX', 2, { min: 0, max: 4 });
  if (c2cProgressMax >= c2cMaxReplies) {
    throw new ConfigError(
      `QQ_C2C_PROGRESS_MAX(${c2cProgressMax}) 必须小于 QQ_C2C_MAX_REPLIES_PER_MSG(${c2cMaxReplies})，` +
        '否则单聊的进度回执会把配额用光，最终答案发不出去',
    );
  }

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
  if (turnTimeoutMs >= 300_000) {
    throw new ConfigError(
      `QQ_TURN_TIMEOUT_MS(${turnTimeoutMs}) 必须小于群被动回复窗口 300000ms(5 分钟)`,
      [
        '原因：超时后还要发一条"任务已中断"的回复，超过窗口这条也会发送失败',
        '推荐值：240000（4 分钟），留 1 分钟收尾',
      ],
    );
  }

  const progressAfterMs = optionalInt(env, 'QQ_PROGRESS_AFTER_MS', 90_000, { min: 1_000, max: 280_000 });
  if (progressAfterMs >= turnTimeoutMs) {
    throw new ConfigError(
      `QQ_PROGRESS_AFTER_MS(${progressAfterMs}) 必须小于 QQ_TURN_TIMEOUT_MS(${turnTimeoutMs})，否则永远不会发进度回执`,
    );
  }

  const adminOpenids = optionalString(env, 'QQ_ADMIN_OPENIDS', '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

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

  return {
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
      adminOpenids,
      c2c: {
        enabled: optionalBool(env, 'QQ_C2C_ENABLED', true),
        maxRepliesPerMsg: c2cMaxReplies,
        progressMax: c2cProgressMax,
      },
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
    dsh: {
      provider: config.dsh.provider,
      model: config.dsh.model,
      profilePatch: config.dsh.profilePatch,
    },
    pool: config.pool,
    paths: config.paths,
    adminCount: config.qq.adminOpenids.length,
    offpeak: {
      enabled: config.offpeak.enabled,
      window: `${config.offpeak.start}\u2013${config.offpeak.end}`,
      timeZone: config.offpeak.timeZone,
      modelPattern: config.offpeak.modelPattern,
    },
  };
}
