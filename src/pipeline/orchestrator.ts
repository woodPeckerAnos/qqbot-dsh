/**
 * Orchestrator：编排层的对外门面，也是 Ingress 管线的组装点。
 *
 * 事件流：
 *
 *   connector.on(event)
 *     ├─ 用户消息 → handleMessage
 *     │     入口（received 计数、平台路由、c2c 开关、Responder 构建）
 *     │       → Ingress 管线（去重 → 命令 → 谷时段闸 → 记录 → 准入）
 *     │       → 终态：TurnRunner.runTurn
 *     ├─ 进群/加好友 → 欢迎语（ingress/welcome.ts）
 *     └─ 其余系统事件 → 仅记日志
 *
 * runtime 事件流（方向相反，与 Ingress 无关）：
 *   pool.on('session.event' / 'session.status') → TurnRunner 路由到在途 turn
 *
 * 永不抛错契约：stage 链内部各自兜底（准入 stage 包住终态的未预期错误），
 * 入口不向外抛——main.ts 仍保留一层 .catch 作为组装级保险。
 */

import { join } from 'node:path';

import type { Config } from '../config.js';
import type { BotConnector, NormalizedEvent, NormalizedMessage } from '../core/connector.js';
import { isUserMessage } from '../core/connector.js';
import type { RuntimePool } from '../dsh/pool.js';
import type { SessionStatusNotification } from '../dsh/protocol.js';
import type { Logger } from '../logger.js';
import { CN_HOLIDAYS_2026, OffpeakGate } from '../offpeak.js';
import type { ConversationStore } from '../store/conversations.js';
import type { SeenStore } from '../store/seen.js';
import type { SessionStore } from '../store/sessions.js';
import type { StorePaths } from '../store/paths.js';
import { AdmissionGate } from './ingress/admission.js';
import { createDedupeStage } from './ingress/dedupe.js';
import { OffpeakCommandRouter } from './ingress/offpeak-command.js';
import { createOffpeakGateStage } from './ingress/offpeak-gate.js';
import { createRecordStage } from './ingress/record.js';
import { handleWelcomeEvent } from './ingress/welcome.js';
import { runStages, type IngressStage, type MessageContext } from './ingress/types.js';
import { Responder } from './responder.js';
import { PipelineStats, type PipelineStatsSnapshot } from './stats.js';
import { TurnRunner } from './turn-runner.js';

export interface OrchestratorDeps {
  config: Config;
  logger: Logger;
  pool: RuntimePool;
  /** 平台标识 → 连接器。回复按 target.platform 路由。 */
  connectors: ReadonlyMap<string, BotConnector>;
  conversations: ConversationStore;
  seen: SeenStore;
  sessions: SessionStore;
  paths: StorePaths;
  /** 统计用（health 展示） */
  now?: () => number;
}

export class Orchestrator {
  private readonly stats = new PipelineStats();

  /**
   * 谷时段闸服务。生效配置 = env 默认 + 运行期覆盖（持久化在 stateDir，
   * 由管理员 /offpeak 命令热切换，下一条消息即生效）。
   * 命令路由与闸拦截两个 stage 共享同一个服务实例。
   */
  private readonly offpeak: OffpeakGate;
  private readonly admission: AdmissionGate;
  private readonly turnRunner: TurnRunner;
  private readonly stages: readonly IngressStage[];

  constructor(private readonly deps: OrchestratorDeps) {
    this.offpeak = new OffpeakGate({
      defaults: {
        enabled: deps.config.offpeak.enabled,
        windows: deps.config.offpeak.windows,
        timeZone: deps.config.offpeak.timeZone,
        modelPattern: deps.config.offpeak.modelPattern,
        weekendsAllDay: deps.config.offpeak.weekendsAllDay,
        holidays: new Set([...CN_HOLIDAYS_2026, ...deps.config.offpeak.holidays]),
      },
      filePath: join(deps.paths.stateDir, 'offpeak-override.json'),
      logger: deps.logger.child({ component: 'offpeak' }),
      now: deps.now,
    });
    this.admission = new AdmissionGate({
      maxConcurrentTurns: deps.config.pool.maxConcurrentTurns,
      stats: this.stats,
    });
    this.turnRunner = new TurnRunner({
      config: deps.config,
      logger: deps.logger.child({ component: 'turn-runner' }),
      pool: deps.pool,
      conversations: deps.conversations,
      sessions: deps.sessions,
      paths: deps.paths,
      stats: this.stats,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });

    // 顺序即架构约束，改动前先读 src/pipeline/ingress/types.ts 的顺序说明
    const commandRouter = new OffpeakCommandRouter({
      gate: this.offpeak,
      config: deps.config,
      stats: this.stats,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    this.stages = [
      createDedupeStage({ seen: deps.seen, stats: this.stats }),
      commandRouter.stage(),
      createOffpeakGateStage({
        gate: this.offpeak,
        config: deps.config,
        stats: this.stats,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      }),
      createRecordStage({ conversations: deps.conversations }),
      this.admission.stage(),
    ];
  }

  snapshotStats(): PipelineStatsSnapshot {
    return {
      ...this.stats,
      inFlight: this.admission.inUse,
      queued: this.admission.queued,
      offpeak: this.offpeak.snapshot(),
    };
  }

  /** 入口：处理一个归一化事件。永不抛错（所有失败都转成回复或日志）。 */
  async handleEvent(event: NormalizedEvent): Promise<void> {
    if (isUserMessage(event)) {
      await this.handleMessage(event);
      return;
    }
    if (event.kind === 'group-add-robot' || event.kind === 'c2c-friend-add') {
      await handleWelcomeEvent(event, {
        connectors: this.deps.connectors,
        stats: this.stats,
        logger: this.deps.logger,
      });
      return;
    }
    this.deps.logger.debug('忽略系统事件', { kind: event.kind, reason: event.reason });
  }

  /** runtime 事件路由直接委托给 TurnRunner（与 Ingress 管线无关）。 */
  routeSessionEvent(
    conversationKey: string,
    event: { type: string; seq: number; data: Record<string, unknown> },
  ): void {
    this.turnRunner.routeSessionEvent(conversationKey, event);
  }

  routeSessionStatus(conversationKey: string, status: SessionStatusNotification): void {
    this.turnRunner.routeSessionStatus(conversationKey, status);
  }

  // -------------------------------------------------------------------------
  // 用户消息入口：构建上下文，进入 Ingress 管线
  // -------------------------------------------------------------------------

  private async handleMessage(message: NormalizedMessage): Promise<void> {
    const { logger } = this.deps;
    this.stats.received += 1;

    const connector = this.deps.connectors.get(message.target.platform);
    if (connector === undefined) {
      // 未知平台说明适配器注册与事件来源不一致（属于 bug）
      logger.warn('收到未知平台的事件，已丢弃', {
        platform: message.target.platform,
        conversation: message.target.key,
      });
      return;
    }
    const policy = connector.policy(message.target.kind);

    // 单聊开关：订阅层往往无法只收群聊，所以在业务层拦。
    // 位置在去重之前——被禁的消息连去重表都不该占。
    if (message.target.kind === 'c2c' && !connector.acceptsC2C) {
      this.stats.skippedC2C += 1;
      logger.debug('单聊已禁用，忽略私聊消息', { conversation: message.target.key });
      return;
    }

    const messageLogger = logger.child({
      conversation: message.target.key,
      platform: message.target.platform,
      kind: message.target.kind,
      msgId: message.msgId,
    });

    const ctx: MessageContext = {
      message,
      connector,
      policy,
      // 管理员判定：白名单条目是 `platform:senderId` 组合（见 BOT_ADMINS）
      isAdmin: this.deps.config.admins.includes(
        `${message.target.platform}:${message.senderId}`,
      ),
      logger: messageLogger,
      responder: new Responder({
        message,
        connector,
        policy,
        conversations: this.deps.conversations,
        stats: this.stats,
        logger: messageLogger,
        ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
      }),
    };

    await runStages(this.stages, ctx, () => this.turnRunner.runTurn(ctx));
  }
}
