/**
 * 组装入口：唯一的 new 汇聚点。
 *
 * 顺序很重要：
 *   1. 解析配置（失败立刻退出，并打印修复提示）
 *   2. 准备存储目录
 *   3. 建健康检查服务（先起来，这样启动失败也能被探针看到）
 *   4. 建 QQ 接入层与 DSH 池
 *   5. 建编排器，把两侧接起来
 *   6. 启动网关
 *   7. 挂信号处理，优雅退出
 *
 * 退出路径必须是**优雅**的：先停网关（不再接新消息），再等在处理中的 turn 结束，
 * 最后关掉所有 DSH runtime（shutdown → SIGTERM → SIGKILL）。
 * 粗暴退出会让 DSH 的会话日志留半条记录，而那正是我们排障的依据。
 */

import { loadConfig, describeConfig, ConfigError, type Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { RuntimePool } from './dsh/pool.js';
import { QqApi } from './qq/api.js';
import { QqGateway, type NormalizedEvent } from './qq/gateway.js';
import { TokenManager, TokenError } from './qq/token.js';
import { Dispatcher } from './pipeline/dispatcher.js';
import { ConversationStore } from './store/conversations.js';
import { SeenStore } from './store/seen.js';
import { SessionStore } from './store/sessions.js';
import { ensureStoreDirs, resolveStorePaths } from './store/paths.js';
import { buildHealthSnapshot, createHealthServer, type HealthServer } from './health.js';

/** 处理中的 turn 结束前最多等多久（毫秒） */
const DRAIN_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
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

  // --- QQ 接入层 -------------------------------------------------------------
  const tokenManager = new TokenManager({
    appId: config.qq.appId,
    appSecret: config.qq.appSecret,
    apiBase: config.qq.apiBase,
    logger,
  });
  const api = new QqApi({ apiBase: config.qq.apiBase, tokenManager, logger });

  const gateway = new QqGateway({
    api,
    tokenManager,
    intents: config.qq.intents,
    logger: logger.child({ component: 'gateway' }),
  });

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
  const dispatcher = new Dispatcher({
    config,
    logger: logger.child({ component: 'dispatcher' }),
    pool,
    api,
    conversations,
    seen,
    sessions,
    paths,
  });

  // runtime 事件 → 编排器（按群路由）
  pool.on('session.event', (groupKey, notification) => {
    dispatcher.routeSessionEvent(groupKey, notification.event);
  });
  pool.on('session.status', (groupKey, notification) => {
    dispatcher.routeSessionStatus(groupKey, notification);
  });

  // --- QQ 事件 → 编排器 ------------------------------------------------------
  // QQ 的 handler 是同步回调，我们在内部按群串行链式调用，避免同一群并发进入。
  const eventChains = new Map<string, Promise<void>>();
  gateway.on((event: NormalizedEvent) => {
    const key =
      event.kind === 'group-at-message'
        ? event.groupOpenid
        : event.kind === 'group-add-robot'
          ? (event.groupOpenid ?? '__system__')
          : '__system__';
    const previous = eventChains.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => dispatcher.handleEvent(event))
      .catch((error: unknown) => {
        logger.error('处理事件链时出错', {
          kind: event.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (eventChains.get(key) === next) eventChains.delete(key);
      });
    eventChains.set(key, next);
  });

  // --- 健康检查 -------------------------------------------------------------
  const health: HealthServer = createHealthServer({
    port: config.health.port,
    logger,
    snapshot: () =>
      buildHealthSnapshot({
        startedAt,
        gateway: gateway.health(),
        runtime: { size: pool.size, activeGroupKeys: pool.activeGroupKeys() },
        dispatcher: dispatcher.snapshotStats(),
        token: tokenManager.snapshot(),
      }),
  });
  await health.start();

  // --- 优雅退出 -------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('收到退出信号，开始优雅关闭', { signal });

    // 1. 先停网关：不再接受新消息
    await gateway.stop().catch((error: unknown) => {
      logger.warn('停止网关时出错', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // 2. 等处理中的 turn 结束（有上限，避免卡死）
    const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (dispatcher.snapshotStats().inFlight > 0 && Date.now() < drainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const stats = dispatcher.snapshotStats();
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

  // --- 启动网关 -------------------------------------------------------------
  try {
    // 先验证一次鉴权，把配置错误挡在"连着但没权限"之前
    await tokenManager.get();
    await gateway.start();
    logger.info('qqbot-dsh 已就绪，等待群消息');
  } catch (error) {
    if (error instanceof TokenError) {
      logger.error('鉴权失败，无法启动', { error: error.message, code: error.code });
    } else {
      logger.error('启动网关失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    process.exitCode = 1;
    await shutdown('startup-failure', 1);
  }
}

void main();
