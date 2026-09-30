/**
 * Orchestrator：编排层的运行机制，**不组装任何业务逻辑**。
 *
 * 所有业务组件——stage 链、准入闸门、谷时段闸服务、TurnRunner、Responder
 * 工厂——都由业务层（main.ts）显式构造并按序注入。这里只做四件事：
 *
 *   1. 事件分流：用户消息 → Ingress 管线；进群/加好友 → 欢迎语；其余仅记日志；
 *   2. 为每条消息构建 MessageContext（含 Egress 收口 Responder），
 *      并按业务层给定的顺序串行驱动 stage 链；
 *   3. runtime 事件委托给 TurnRunner 路由（方向相反，与 Ingress 无关）；
 *   4. 聚合统计快照：计数来自各 stage 自报的 PipelineStats，
 *      状态（inFlight / queued / offpeak）来自业务层注入的 status 探针。
 *
 * 永不抛错契约：stage 链内部各自兜底（准入 stage 包住终态的未预期错误），
 * 入口不向外抛——main.ts 仍保留一层 .catch 作为组装级保险。
 */

import type {
  BotConnector,
  NormalizedEvent,
  NormalizedMessage,
  ReplyPolicy,
} from '../core/connector.js';
import { isObservedMessage, isUserMessage } from '../core/connector.js';
import type { SessionEventNotification, SessionStatusNotification } from '../dsh/protocol.js';
import type { InterventionSnapshot, TopicWatcher } from '../intervention/watcher.js';
import type { Logger } from '../logger.js';
import type { OffpeakSnapshot } from '../offpeak/index.js';
import type { Responder } from './egress/responder.js';
import { handleWelcomeEvent } from './ingress/welcome.js';
import { runStages, type IngressStage, type MessageContext } from './ingress/types.js';
import type { PipelineStats, PipelineStatsSnapshot } from './stats.js';

/** runtime 事件路由的委托面（由 TurnRunner 实现）。 */
export interface SessionEventRouter {
  routeSessionEvent(conversationKey: string, notification: SessionEventNotification): void;
  routeSessionStatus(conversationKey: string, status: SessionStatusNotification): void;
}

export interface OrchestratorDeps {
  logger: Logger;
  /** 平台标识 → 连接器。回复按 target.platform 路由。 */
  connectors: ReadonlyMap<string, BotConnector>;
  /** 管理员白名单，条目为 `platform:senderId` 组合（见 BOT_ADMINS） */
  admins: readonly string[];
  /** 各 stage 自报的计数器（业务层创建，注入给所有 stage 与 Responder） */
  stats: PipelineStats;
  /**
   * Ingress stage 链。**顺序即架构约束**（去重 → 命令 → 闸 → 记录 → 准入，
   * 理由见 ingress/types.ts），由业务层显式排布后整体传入——编排层不决定
   * 有哪些拦截、也不决定它们的顺序。
   */
  stages: readonly IngressStage[];
  /** 终态 handler（TurnRunner.runTurn），在准入 stage 的名额与串行锁内运行 */
  terminal: (ctx: MessageContext) => Promise<void>;
  /** Egress 收口工厂：每条消息一个 Responder（持有唯一配额账本） */
  createResponder: (
    message: NormalizedMessage,
    connector: BotConnector,
    policy: ReplyPolicy,
    logger: Logger,
  ) => Responder;
  /** runtime 事件路由（TurnRunner 的委托面） */
  turns: SessionEventRouter;
  /**
   * 话题介入 watcher（可选；缺省 = 旁听消息直接丢弃）。
   * observed 事件在 handleEvent 入口分流给它，永不进入 Ingress 管线。
   */
  watcher?: TopicWatcher;
  /** health 快照的状态探针：准入闸门、谷时段闸与介入层的实时状态（对象归业务层持有） */
  status: () => {
    inFlight: number;
    queued: number;
    offpeak: OffpeakSnapshot;
    intervention: InterventionSnapshot;
  };
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  snapshotStats(): PipelineStatsSnapshot {
    return { ...this.deps.stats, ...this.deps.status() };
  }

  /** 入口：处理一个归一化事件。永不抛错（所有失败都转成回复或日志）。 */
  async handleEvent(event: NormalizedEvent): Promise<void> {
    // 旁听消息最先分流：不进 Ingress 管线（去重磁盘层、谷时段闸、记录、
    // 并发准入对它全都不适用），同步交给 watcher，永不抛错由 watcher 收口。
    if (isObservedMessage(event)) {
      this.deps.watcher?.observe(event);
      return;
    }
    if (isUserMessage(event)) {
      // 官方全量模式下同一 msgId 可能同时以 at/observed 两个事件到达；
      // 通知 watcher 标记 addressed，介入评估跳过它（方案 §12 幂等）。
      this.deps.watcher?.markAddressed(event.target.key, event.msgId);
      await this.handleMessage(event);
      return;
    }
    if (event.kind === 'group-add-robot' || event.kind === 'c2c-friend-add') {
      await handleWelcomeEvent(event, {
        connectors: this.deps.connectors,
        stats: this.deps.stats,
        logger: this.deps.logger,
      });
      return;
    }
    this.deps.logger.debug('忽略系统事件', { kind: event.kind, reason: event.reason });
  }

  /** runtime 事件路由直接委托给 TurnRunner（与 Ingress 管线无关）。 */
  routeSessionEvent(conversationKey: string, notification: SessionEventNotification): void {
    this.deps.turns.routeSessionEvent(conversationKey, notification);
  }

  routeSessionStatus(conversationKey: string, status: SessionStatusNotification): void {
    this.deps.turns.routeSessionStatus(conversationKey, status);
  }

  // -------------------------------------------------------------------------
  // 用户消息入口：构建上下文，进入 Ingress 管线
  // -------------------------------------------------------------------------

  private async handleMessage(message: NormalizedMessage): Promise<void> {
    const { logger } = this.deps;
    this.deps.stats.received += 1;

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
      this.deps.stats.skippedC2C += 1;
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
      isAdmin: this.deps.admins.includes(`${message.target.platform}:${message.senderId}`),
      logger: messageLogger,
      responder: this.deps.createResponder(message, connector, policy, messageLogger),
    };

    await runStages(this.deps.stages, ctx, () => this.deps.terminal(ctx));
  }
}
