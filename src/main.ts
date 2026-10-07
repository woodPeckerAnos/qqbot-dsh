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
import { createDocumentExtractor } from './dsh/document.js';
import { BackgroundPusher } from './pipeline/egress/background.js';
import { Responder } from './pipeline/egress/responder.js';
import { AdmissionGate } from './pipeline/ingress/admission.js';
import { createDedupeStage } from './pipeline/ingress/dedupe.js';
import { OffpeakCommandRouter } from './pipeline/ingress/offpeak-command.js';
import { createOffpeakGateStage } from './pipeline/ingress/offpeak-gate.js';
import { createRecordStage } from './pipeline/ingress/record.js';
import { SessionCommandRouter } from './pipeline/ingress/session-command.js';
import type { IngressStage } from './pipeline/ingress/types.js';
import { Orchestrator } from './pipeline/orchestrator.js';
import { PipelineStats } from './pipeline/stats.js';
import { createTopicJudge } from './pipeline/topic-judge.js';
import { ProactiveSpeaker } from './pipeline/proactive/deliver/speaker.js';
import { loadInterestPool } from './pipeline/proactive/interests/pool.js';
import { createChatClient } from './pipeline/proactive/judge/chat-client.js';
import { createDefaultProactiveJudge } from './pipeline/proactive/judge/client.js';
import {
  DEFAULT_WATCHER_CONFIG,
  ProactiveWatcher,
} from './pipeline/proactive/scene/watcher.js';
import type { ProactiveHealthSnapshot } from './health.js';
import { TurnRunner } from './pipeline/turn-runner.js';
import { ConversationStore } from './store/conversations.js';
import { SeenStore } from './store/seen.js';
import { SessionStore } from './store/sessions.js';
import { ensureStoreDirs, resolveStorePaths, workspacePathFor } from './store/paths.js';
import { buildHealthSnapshot, createHealthServer, type HealthServer } from './health.js';

/** 处理中的 turn 结束前最多等多久（毫秒） */
const DRAIN_TIMEOUT_MS = 30_000;

/**
 * 官方平台被动回复窗口（平台硬约束，不可配）：群聊 5 分钟、单聊 60 分钟。
 * 后台任务完成时若仍在窗口内即可用最后一条消息的 msg_id 即时补发（见
 * pipeline/egress/background.ts）。OneBot 无窗口，用 +∞。
 */
const QQ_GROUP_PASSIVE_WINDOW_MS = 5 * 60 * 1000;
const QQ_C2C_PASSIVE_WINDOW_MS = 60 * 60 * 1000;

/** 按配置建一个连接器（不启动）。 */
function buildConnector(
  name: string,
  config: Config,
  logger: ReturnType<typeof createLogger>,
  stats: PipelineStats,
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
        passiveWindowMs: QQ_GROUP_PASSIVE_WINDOW_MS,
      },
      c2cPolicy: {
        maxChars: config.qq.maxChars,
        maxRepliesPerMsg: config.qq.c2c.maxRepliesPerMsg,
        progressMax: config.qq.c2c.progressMax,
        progressAfterMs: config.qq.progressAfterMs,
        progressIntervalMs: config.qq.progressIntervalMs,
        turnTimeoutMs: config.qq.turnTimeoutMs,
        passiveWindowMs: QQ_C2C_PASSIVE_WINDOW_MS,
      },
      forward: config.attachments.forward,
      // 转发块展开结果计入 /metrics（与 OneBot 侧同一套计数）
      onForward: ({ ok, nodes }) => {
        if (ok) {
          stats.forwardsExpanded += 1;
          stats.forwardNodesInlined += nodes;
        } else {
          stats.forwardsFailed += 1;
        }
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
    forward: config.attachments.forward,
    // 转发块回查结果计入 /metrics（接入层不认识 PipelineStats，只回调）
    onForward: ({ ok, nodes }) => {
      if (ok) {
        stats.forwardsExpanded += 1;
        stats.forwardNodesInlined += nodes;
      } else {
        stats.forwardsFailed += 1;
      }
    },
    replyPolicy: {
      maxChars: config.onebot.maxChars,
      maxRepliesPerMsg: config.onebot.maxRepliesPerMsg,
      progressMax: config.onebot.progressMax,
      progressAfterMs: config.onebot.progressAfterMs,
      progressIntervalMs: config.onebot.progressIntervalMs,
      turnTimeoutMs: config.onebot.turnTimeoutMs,
      passiveWindowMs: Number.POSITIVE_INFINITY,
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
  // stats 提前到这里：连接器需要上报转发块回查结果（onForward 回调），
  // 而它是编排层与接入层之间唯一的"计数"通道。放在最前面也让它成为
  // 整条装配链上第一个可观测对象。
  const stats = new PipelineStats();
  const connectors = new Map<string, BotConnector>();
  for (const name of config.connectors) {
    connectors.set(name, buildConnector(name, config, logger, stats));
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
  // stats 在"接入层"就已创建（连接器要用它上报转发块回查结果），这里不再新建。

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

  // --- 主动介入层（旁听 → 判定 → 主动发言）--------------------------------
  //
  // 装配顺序有依赖：兴趣池 → 投递器 → 判定器 → watcher。四者都只在
  // `config.proactive.enabled` 时创建；未启用时 orchestrator 拿到的是 undefined
  // observe（旁听消息只计 skipped 计数），**"只 @ 回复"的部署形态不受影响**。
  //
  // 兴趣池文件不存在 = 空池（合法，场景 5 不触发）；存在但格式错 = 启动期报错
  // （fail-closed，不让 bot 悄悄少一个场景）。
  let proactive: ProactiveWatcher | undefined;
  /** health 里的介入层快照（延迟求值：每次 /metrics 都取最新） */
  let proactiveHealth: (() => ProactiveHealthSnapshot) | undefined;
  if (config.proactive.enabled) {
    const interests = loadInterestPool({
      path: config.proactive.interestsFile,
      // 显式配了路径就必须存在（否则是"配了但没生效"这种最难查的故障）
      explicit: config.proactive.interestsFile !== 'interests.yml',
      enabled: config.proactive.interestsEnabled,
    });
    // 回填给配置摘要：`enabled && !loaded` 就是路径配错了
    config.proactive.interestsLoaded = interests.size > 0;
    config.proactive.interestsCount = interests.size;

    const speaker = new ProactiveSpeaker({
      connectorFor: (target) => connectors.get(target.platform),
      // 单一开关：主动发言复用介入层总开关（见 deliver/speaker.ts 的说明）
      enabled: true,
      dryRun: config.proactive.dryRun,
      logger: logger.child({ component: 'proactive-deliver' }),
    });

    // 判定能力：需要 LLM 密钥。没有密钥时 watcher 只收集不判定（"只听不说"）。
    const apiKey = process.env['DEEPSEEK_API_KEY'] ?? '';
    const judge =
      apiKey === ''
        ? undefined
        : createDefaultProactiveJudge({
            chat: createChatClient({
              apiBase: config.topic.apiBase,
              apiKey,
              model: config.topic.model,
              timeoutMs: config.topic.timeoutMs,
            }),
            maxConcurrent: 2,
            onError: (reason, detail) => {
              stats.proactiveJudgeFailures += 1;
              logger.warn('主动介入判定失败（本次按沉默处理）', { reason, detail });
            },
          });

    proactive = new ProactiveWatcher({
      config: {
        ...DEFAULT_WATCHER_CONFIG,
        enabled: true,
        dryRun: config.proactive.dryRun,
        // 白名单来自 BOT_LISTEN_GROUPS（个人标识不进配置文件；介入层将来
        // 归并到同一个变量，届时不冲突）
        whitelistGroups: config.proactive.whitelistGroups,
        botAliases: config.proactive.botAliases,
        topicRollMessages: config.proactive.topicRollMessages,
        topicRollMs: config.proactive.topicRollMs,
        questionProbeMs: config.proactive.questionProbeMs,
        stateOptions: {
          maxEntries: config.proactive.bufferMaxMessages,
          maxAgeMs: config.proactive.bufferMaxAgeMs,
        },
      },
      speaker,
      ...(judge === undefined ? {} : { judge }),
      interests,
      logger: logger.child({ component: 'proactive-watcher' }),
      metrics: {
        evaluated: (trigger) => {
          stats.proactiveEvaluated += 1;
          logger.debug('主动介入评估', { trigger });
        },
        judgeFailed: () => {
          stats.proactiveJudgeFailures += 1;
        },
        judgeSuspended: (conversation) => {
          stats.proactiveSuspended += 1;
          logger.warn('主动介入暂停评估（判定连续失败）', { conversation });
        },
        vetoed: (reason, scene) => {
          stats.proactiveVetoed += 1;
          logger.debug('主动介入被否决', { reason, scene });
        },
        spoke: (scene, dryRun) => {
          if (dryRun) stats.proactiveWouldSend += 1;
          else {
            stats.proactiveSpoke += 1;
            stats.repliesSent += 1;
          }
          logger.info(dryRun ? '主动介入（dryRun：本应发言）' : '主动介入已发言', { scene });
        },
        deliveryDegraded: (reason, scene) => {
          stats.proactiveDegraded += 1;
          logger.debug('主动介入投递降级', { reason, scene });
        },
      },
    });

    proactiveHealth = (): ProactiveHealthSnapshot => {
      const snapshot = proactive?.snapshot();
      return {
        enabled: snapshot?.enabled ?? false,
        dryRun: snapshot?.dryRun ?? false,
        conversations: snapshot?.conversations ?? 0,
        buffered: snapshot?.buffered ?? 0,
        pendingQuestions: snapshot?.pendingQuestions ?? 0,
        evaluating: snapshot?.evaluating ?? 0,
        suspended: snapshot?.suspended ?? 0,
        spoke: snapshot?.spoke ?? 0,
        wouldSend: snapshot?.wouldSend ?? 0,
        judgeFailures: snapshot?.judgeFailures ?? 0,
        interests: {
          enabled: config.proactive.interestsEnabled,
          loaded: config.proactive.interestsLoaded,
          count: config.proactive.interestsCount,
          file: config.proactive.interestsFile,
        },
        botAliases: config.proactive.botAliases.length,
        evaluatedByTrigger: snapshot?.evaluatedByTrigger ?? {},
        satisfiedByScene: snapshot?.satisfiedByScene ?? {},
        vetoed: snapshot?.vetoed ?? {},
        deliveryDegraded: snapshot?.deliveryDegraded ?? {},
      };
    };
    logger.info('主动介入已装配', {
      dryRun: config.proactive.dryRun,
      groups: config.proactive.whitelistGroups.length,
      interests: interests.size,
      botAliases: config.proactive.botAliases.length,
      judge: judge === undefined ? '未配置判定（只听不说）' : 'ready',
    });
  }

  // 后台结果投递器：后台子代理完成后，能即时推送就推送（OneBot 恒可、官方在
  // 被动窗口内且配额未尽），否则暂存待下一条消息带出；暂存持久化到 stateDir，
  // 桥接进程重启后仍能带出（见 pipeline/egress/background.ts、DESIGN §13.5）。
  const background = new BackgroundPusher({
    connectors,
    conversations,
    stats,
    logger: logger.child({ component: 'background' }),
    persistPath: join(paths.stateDir, 'background-pending.json'),
  });

  const turnRunner = new TurnRunner({
    config,
    logger: logger.child({ component: 'turn-runner' }),
    pool,
    conversations,
    sessions,
    paths,
    stats,
    background,
    // 话题判定器：不经 DSH 进程的小模型调用（判定失败一律视为相关，见
    // pipeline/topic-judge.ts）。apiKey 复用 DEEPSEEK_API_KEY（env 必填项）。
    ...(config.topic.enabled
      ? {
          topicJudge: createTopicJudge({
            apiBase: config.topic.apiBase,
            apiKey: process.env['DEEPSEEK_API_KEY'] ?? '',
            model: config.topic.model,
            timeoutMs: config.topic.timeoutMs,
            perTurnMaxChars: 500,
            logger: logger.child({ component: 'topic-judge' }),
          }),
        }
      : {}),
    // 文档正文抽取：PDF 走 pdftotext 子进程，纯文本类直接解码。
    // 抽取器缺失（本地开发没装 poppler）时自动降级为"只落盘 + 路径说明"，
    // 不会让这一轮失败——见 dsh/document.ts。
    extractDocument: createDocumentExtractor({
      logger: logger.child({ component: 'document' }),
    }),
  });

  const offpeakCommands = new OffpeakCommandRouter({ gate: offpeak, config, stats });
  // 会话控制命令（/stop、/new，仅管理员）：必须在闸之前，且不进会话锁——
  // /stop 的意义就是在锁被长任务占住时也能立刻生效。
  const sessionCommands = new SessionCommandRouter({ pool, turns: turnRunner, stats });
  const stages: IngressStage[] = [
    createDedupeStage({ seen, stats }),
    sessionCommands.stage(),
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
    // 旁听消息的去向：唯一入口是 watcher（未启用时留 undefined →
    // orchestrator 只计 skipped 计数）
    ...(proactive === undefined ? {} : { observe: (message) => proactive?.observe(message) }),
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
      // 被 @ 的消息也记进旁听缓冲：否则判定看不到"bot 回答了谁、回答了什么"，
      // 场景 1（续聊追问）没有判断依据。只记不评（评估仍由旁听路径触发）。
      if (proactive !== undefined && (event.kind === 'group-at-message' || event.kind === 'c2c-message')) {
        proactive.observeAddressed(event);
      }
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
        runtime: {
          size: pool.size,
          activeConversationKeys: pool.activeConversationKeys(),
          activeSubagents: pool.activeSubagents(),
        },
        background: background.snapshot(),
        dispatcher: orchestrator.snapshotStats(),
        ...(proactiveHealth === undefined ? {} : { proactive: proactiveHealth() }),
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
