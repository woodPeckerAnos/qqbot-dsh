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

export function loadConfig(env: Env = process.env): Config {
  const hints = ['请复制 .env.example 为 .env 并填写后重试'];

  const appId = requiredString(env, 'QQ_APP_ID', hints);
  const appSecret = requiredString(env, 'QQ_APP_SECRET', hints);
  requiredString(env, 'DEEPSEEK_API_KEY', hints);

  const intents = optionalInt(env, 'QQ_INTENTS', DEFAULT_INTENTS, { min: 1, max: 0x7fffffff });
  // GROUP_AND_C2C_EVENT(1<<25) 是收群消息的最低要求。缺了它机器人会连着但收不到消息，
  // 属于"看起来正常其实废掉"的配置错误，直接快速失败。
  if ((intents & Intent.GROUP_AND_C2C_EVENT) === 0) {
    throw new ConfigError(
      `QQ_INTENTS=${intents} 未包含 GROUP_AND_C2C_EVENT(1<<25)=33554432，将收不到任何群消息`,
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

  const msgTypeRaw = optionalInt(env, 'QQ_MSG_TYPE', 0, { min: 0, max: 7 });
  if (msgTypeRaw !== 0 && msgTypeRaw !== 2) {
    throw new ConfigError(
      `QQ_MSG_TYPE 本 MVP 只支持 0(纯文本) 或 2(markdown)，收到 ${msgTypeRaw}`,
      ['群聊不支持 6(input_notify 打字状态)，那是单聊专属'],
    );
  }

  // 群被动回复窗口 5 分钟（官方硬约束）。单轮超时必须**小于**该窗口，
  // 否则超时后那条"任务已中断"的回复本身也会因为窗口过期而发送失败。
  // 默认 4 分钟：留出 1 分钟做收尾和发送。
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
    dsh: {
      provider: config.dsh.provider,
      model: config.dsh.model,
      profilePatch: config.dsh.profilePatch,
    },
    pool: config.pool,
    paths: config.paths,
  };
}
