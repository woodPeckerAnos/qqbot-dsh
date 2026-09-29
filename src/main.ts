/**
 * 组装入口：唯一的 new 汇聚点。
 *
 * 顺序很重要：
 *   1. 解析配置（失败立刻退出，并打印修复提示）
 *   2. 准备存储目录
 *   3. 建健康检查服务（先起来，这样启动失败也能被探针看到）
 *   4. 按 BOT_CONNECTORS 建接入层连接器（官方 / OneBot 可并存）
 *   5. 建 DSH 池与编排器，把两侧接起来
 *   6. 启动全部连接器
 *   7. 挂信号处理，优雅退出
 *
 * 多接入模型：
 *   每个连接器一条事件通道，共享同一个编排器、runtime 池与存储。
 *   会话隔离靠 ConversationTarget.key（各平台 key 带自己的命名空间），
 *   回复路由靠 ConversationTarget.platform → 连接器。
 *
 * 退出路径必须是**优雅**的：先停全部连接器（不再接新消息），再等在处理中的
 * turn 结束，最后关掉所有 DSH runtime（shutdown → SIGTERM → SIGKILL）。
 * 粗暴退出会让 DSH 的会话日志留半条记录，而那正是我们排障的依据。
 */

import { join } from 'node:path';

import { loadConfig, describeConfig, ConfigError, type Config } from './config.js';
import { loadConfigFile } from './config-file.js';
import { QqOfficialConnector } from './adapters/qq-official/connector.js';
import { QQ_OFFICIAL_PLATFORM } from './adapters/qq-official/gateway.js';
import { TokenError } from './adapters/qq-official/token.js';
import { OnebotConnector, ONEBOT_PLATFORM } from './adapters/onebot/connector.js';
import type { BotConnector } from './core/connector.js';
import { createLogger } from './logger.js';
import { CN_HOLIDAYS_2026, OffpeakGate } from './offpeak/index.js';
import { RuntimePool } from './dsh/pool.js';
import { Responder } from './pipeline/egress/responder.js';
import { AdmissionGate } from './pipeline/ingress/admission.js';
import { createDedupeStage } from './pipeline/ingress/dedupe.js';
import { OffpeakCommandRouter } from './pipeline/ingress/offpeak-command.js';
import { createOffpeakGateStage } from './pipeline/ingress/offpeak-gate.js';
import { createRecordStage } from './pipeline/ingress/record.js';
import type { IngressStage } from './pipeline/ingress/types.js';
import { Orchestrator } from './pipeline/orchestrator.js';
import { PipelineStats } from './pipeline/stats.js';
import { TurnRunner } from './pipeline/turn-runner.js';
import { ConversationStore } from './store/conversations.js';
import { SeenStore } from './store/seen.js';
import { SessionStore } from './store/sessions.js';
import { ensureStoreDirs, resolveStorePaths, workspacePathFor } from './store/paths.js';
import { buildHealthSnapshot, createHealthServer, type HealthServer } from './health.js';

/** 处理中的 turn 结束前最多等多久（毫秒） */
const DRAIN_TIMEOUT_MS = 30_000;

/** 按配置建一个连接器（不启动）。 */
function buildConnector(
  name: string,
  config: Config,
  logger: ReturnType<typeof createLogger>,
): BotConnector {
  if (name === QQ_OFFICIAL_PLATFORM) {
    return new QqOfficialConnector({
      appId: config.qq.appId,
      appSecret: config.qq.appSecret,
      apiBase: config.qq.apiBase,
      intents: config.qq.intents,
      msgType: config.qq.msgType,
      acceptsC2C: config.qq.c2c.enabled,
      groupPolicy: {
        maxChars: config.qq.maxChars,
        maxRepliesPerMsg: config.qq.maxRepliesPerMsg,
        progressMax: config.qq.progressMax,
        progressAfterMs: config.qq.progressAfterMs,
        progressIntervalMs: config.qq.progressIntervalMs,
        turnTimeoutMs: config.qq.turnTimeoutMs,
      },
      c2cPolicy: {
        maxChars: config.qq.maxChars,
        maxRepliesPerMsg: config.qq.c2c.maxRepliesPerMsg,
        progressMax: config.qq.c2c.progressMax,
        progressAfterMs: config.qq.progressAfterMs,
        progressIntervalMs: config.qq.progressIntervalMs,
        turnTimeoutMs: config.qq.turnTimeoutMs,
      },
      logger: logger.child({ component: `connector:${name}` }),
    });
  }
  // ONEBOT_PLATFORM
  return new OnebotConnector({
    host: config.onebot.host,
    port: config.onebot.port,
    accessToken: config.onebot.accessToken,
    acceptsC2C: config.onebot.c2cEnabled,
    autoAcceptFriend: config.onebot.autoAcceptFriend,
    autoAcceptGroupInvite: config.onebot.autoAcceptGroupInvite,
    fileTransport: config.onebot.fileTransport,
    replyPolicy: {
      maxChars: config.onebot.maxChars,
      maxRepliesPerMsg: config.onebot.maxRepliesPerMsg,
      progressMax: config.onebot.progressMax,
      progressAfterMs: config.onebot.progressAfterMs,
      progressIntervalMs: config.onebot.progressIntervalMs,
      turnTimeoutMs: config.onebot.turnTimeoutMs,
    },
    logger: logger.child({ component: `connector:${name}` }),
  });
}

async function main(): Promise<void> {
  let config: Config;
  let configFile: string | undefined;
  try {
    // 配置文件（qqbot.yml）先读：缺文件、YAML 语法错、键名拼错都在这里爆出来。
    // 密钥不走配置文件，只从 env 读（loadConfig 内部处理）。
    const loaded = loadConfigFile(process.env);
    configFile = loaded.path;
    config = loadConfig(process.env, loaded.config);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n配置错误：${error.message}\n`);
      for (const hint of error.hints) process.stderr.write(`  → ${hint}\n`);
      process.stderr.write('\n');
      process.exit(2);
    }
    throw error;
  }

  const logger = createLogger({ level: config.logLevel });
  const startedAt = Date.now();

  logger.info('启动 qqbot-dsh', {
    node: process.version,
    platform: process.platform,
    // 配置文件路径要显式打出来：排障第一个问题永远是"你到底读的哪个配置"
    configFile: configFile ?? '(未使用配置文件，全部走 env/默认)',
    config: describeConfig(config),
  });

  // --- 存储 -----------------------------------------------------------------
  const paths = resolveStorePaths({
    workspacesRoot: config.paths.workspacesRoot,
    stateDir: config.paths.stateDir,
  });
  ensureStoreDirs(paths);
  logger.info('存储目录就绪', { ...paths });

  const conversations = new ConversationStore(paths, logger);
  const seen = new SeenStore({ paths, logger });
  const sessions = new SessionStore({ paths, logger });

  // --- 接入层（按配置建连接器，可多个并存） ----------------------------------
  const connectors = new Map<string, BotConnector>();
  for (const name of config.connectors) {
    connectors.set(name, buildConnector(name, config, logger));
  }

  // --- DSH runtime 池 --------------------------------------------------------
  const pool = new RuntimePool({
    maxRuntimes: config.pool.maxRuntimes,
    runtimeIdleMs: config.pool.runtimeIdleMs,
    base: {
      bin: config.dsh.bin,
      profilePatch: config.dsh.profilePatch,
      dshHome: config.paths.dshHome,
      provider: config.dsh.provider,
      model: config.dsh.model,
      startTimeoutMs: config.dsh.runtimeStartTimeoutMs,
      shutdownTimeoutMs: config.dsh.runtimeShutdownTimeoutMs,
    },
    logger: logger.child({ component: 'pool' }),
  });

  // --- 编排 -----------------------------------------------------------------
  // 业务逻辑在这里显式组装：每个 stage / 闸门 / 服务都在本文件 new 出来并按序
  // 排布，Orchestrator 只是运行机制（事件分流 + 驱动 stage 链），不决定有哪些
  // 拦截、也不决定顺序。
  //
  // Ingress 顺序即架构约束：去重 → /offpeak 命令 → 谷时段闸 → 记录 → 准入
  // （命令先于闸：管理员要能在峰时段关闸；闸先于记录与名额：被拦消息不写
  // 对话记录、不占并发。详见 src/pipeline/ingress/types.ts）。
  const stats = new PipelineStats();

  // 谷时段闸服务：生效配置 = env 默认 + 运行期覆盖（持久化在 stateDir，
  // 由管理员 /offpeak 命令热切换，下一条消息即生效）。
  // 命令路由与闸拦截两个 stage 共享同一个实例。
  const offpeak = new OffpeakGate({
    defaults: {
      enabled: config.offpeak.enabled,
      windows: config.offpeak.windows,
      timeZone: config.offpeak.timeZone,
      modelPattern: config.offpeak.modelPattern,
      weekendsAllDay: config.offpeak.weekendsAllDay,
      holidays: new Set([...CN_HOLIDAYS_2026, ...config.offpeak.holidays]),
    },
    filePath: join(paths.stateDir, 'offpeak-override.json'),
    logger: logger.child({ component: 'offpeak' }),
  });

  // 准入闸门：全局并发名额 + 每会话串行锁（全系统唯一一处每会话串行）
  const admission = new AdmissionGate({
    maxConcurrentTurns: config.pool.maxConcurrentTurns,
    stats,
  });

  const turnRunner = new TurnRunner({
    config,
    logger: logger.child({ component: 'turn-runner' }),
    pool,
    conversations,
    sessions,
    paths,
    stats,
  });

  const offpeakCommands = new OffpeakCommandRouter({ gate: offpeak, config, stats });

  const stages: IngressStage[] = [
    createDedupeStage({ seen, stats }),
    offpeakCommands.stage(),
    createOffpeakGateStage({ gate: offpeak, config, stats }),
    createRecordStage({ conversations }),
    admission.stage(),
  ];

  const orchestrator = new Orchestrator({
    logger: logger.child({ component: 'orchestrator' }),
    connectors,
    admins: config.admins,
    stats,
    stages,
    terminal: (ctx) => turnRunner.runTurn(ctx),
    createResponder: (message, connector, policy, messageLogger) =>
      new Responder({
        message,
        connector,
        policy,
        conversations,
        stats,
        logger: messageLogger,
        // outbox 目录路径在这里拼好：Responder 不感知工作区布局，
        // 只拿一个"该扫哪个目录"的绝对路径（目录不存在 = 没有产物）。
        ...(config.media.enabled
          ? {
              media: {
                outboxDir: join(workspacePathFor(paths, message.target.key), config.media.outboxDir),
                maxFileBytes: config.media.maxFileBytes,
                maxAttachments: config.media.maxAttachmentsPerMsg,
                imageExtensions: config.media.imageExtensions,
              },
            }
          : {}),
      }),
    turns: turnRunner,
    status: () => ({
      inFlight: admission.inUse,
      queued: admission.queued,
      offpeak: offpeak.snapshot(),
    }),
  });

  // runtime 事件 → 编排器（按会话路由）。
  // 传**完整 notification**（含 sessionId）：一个 runtime 进程里除了父会话还有
  // 后台子代理的子会话，事件都从同一条 wire 上来；TurnRunner 需要 sessionId
  // 才能把子会话事件过滤掉，否则子代理的 turn/end 会把父轮次提前"结算"（串扰）。
  pool.on('session.event', (conversationKey, notification) => {
    orchestrator.routeSessionEvent(conversationKey, notification);
  });
  pool.on('session.status', (conversationKey, notification) => {
    orchestrator.routeSessionStatus(conversationKey, notification);
  });
  // 后台子代理生命周期 → 统计（回收豁免已由池自己记账，这里只做可观测）。
  pool.on('subagent.started', (conversationKey, notification) => {
    stats.backgroundStarted += 1;
    logger.info('后台子代理启动', { conversation: conversationKey, child: notification.childSessionId });
  });
  pool.on('subagent.finished', (conversationKey, notification) => {
    stats.backgroundFinished += 1;
    logger.info('后台子代理结束', {
      conversation: conversationKey,
      child: notification.childSessionId,
      status: notification.status,
      stopReason: notification.stopReason,
    });
  });

  // --- 连接器事件 → 编排器 ----------------------------------------------------
  // 同步回调里直接派发：Ingress 管线的准入 stage 保证同一会话串行进入 turn，
  // 这里只留一层 .catch 作为组装级保险（Orchestrator 自身永不抛错）。
  for (const connector of connectors.values()) {
    connector.on((event) => {
      void orchestrator.handleEvent(event).catch((error: unknown) => {
        logger.error('处理事件时出错', {
          kind: event.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  // --- 健康检查 -------------------------------------------------------------
  const health: HealthServer = createHealthServer({
    port: config.health.port,
    logger,
    snapshot: () =>
      buildHealthSnapshot({
        startedAt,
        connectors: Object.fromEntries(
          [...connectors.entries()].map(([name, connector]) => [name, connector.health()]),
        ),
        runtime: { size: pool.size, activeConversationKeys: pool.activeConversationKeys() },
        dispatcher: orchestrator.snapshotStats(),
      }),
  });
  await health.start();

  // --- 优雅退出 -------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('收到退出信号，开始优雅关闭', { signal });

    // 1. 先停全部连接器：不再接受新消息
    for (const [name, connector] of connectors) {
      await connector.stop().catch((error: unknown) => {
        logger.warn('停止连接器时出错', {
          connector: name,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // 2. 等处理中的 turn 结束（有上限，避免卡死）
    const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (orchestrator.snapshotStats().inFlight > 0 && Date.now() < drainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const stats = orchestrator.snapshotStats();
    if (stats.inFlight > 0) {
      logger.warn('仍有 turn 未结束，强制继续关闭', { inFlight: stats.inFlight });
    }

    // 3. 关闭全部 DSH runtime（内部是 shutdown → SIGTERM → SIGKILL 三档）
    await pool.disposeAll();

    // 4. 关健康检查
    await health.stop();

    logger.info('已退出', { stats });
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常，准备退出', { error: error.message, stack: error.stack });
    void shutdown('uncaughtException', 1);
  });

  // --- 启动全部连接器 ---------------------------------------------------------
  // 单个连接器启动失败不再直接杀死进程：多接入场景下，一个平台挂掉不该拖死
  // 另一个。但**全部**失败 = 服务完全没有事件来源，等于废了，必须退出。
  let started = 0;
  for (const [name, connector] of connectors) {
    try {
      await connector.start();
      started += 1;
      logger.info('连接器已启动', { connector: name });
    } catch (error) {
      if (error instanceof TokenError) {
        logger.error('连接器鉴权失败', { connector: name, error: error.message, code: error.code });
      } else {
        logger.error('连接器启动失败', {
          connector: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (started === 0) {
    logger.error('所有连接器都启动失败，服务没有事件来源，退出');
    process.exitCode = 1;
    await shutdown('startup-failure', 1);
    return;
  }
  if (started < connectors.size) {
    logger.warn('部分连接器启动失败，服务降级运行（健康检查会持续报告）', {
      started,
      total: connectors.size,
    });
  }
  logger.info('qqbot-dsh 已就绪，等待群聊/单聊消息', { connectors: [...connectors.keys()] });
}

void main();
