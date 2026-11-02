/**
 * Ingress 运行机制：分流归一化事件，构建输入绑定，驱动注入的 stage 链。
 * main 负责 stage 顺序、SessionActor 提交和消息队列装配。
 * 这里不管理 runtime 事件或等待 Task 执行；状态由注入探针提供。
 */

import type {
  BotConnector,
  NormalizedEvent,
  NormalizedMessage,
  ReplyPolicy,
} from '../core/connector.js';
import { isAddressedMessage, isObservedMessage, isUserMessage } from '../core/connector.js';
import type { Logger } from '../logger.js';
import type { OffpeakSnapshot } from '../offpeak/index.js';
import type { Responder } from './egress/responder.js';
import { handleWelcomeEvent } from './ingress/welcome.js';
import { runStages, type IngressStage, type MessageContext } from './ingress/types.js';
import type { PipelineStats, PipelineStatsSnapshot } from './stats.js';

export interface OrchestratorDeps {
  logger: Logger;
  /** 平台标识 → 连接器。回复按 target.platform 路由。 */
  connectors: ReadonlyMap<string, BotConnector>;
  /** 管理员白名单，条目为 `platform:senderId` 组合（见 BOT_ADMINS） */
  admins: readonly string[];
  /** 各 stage 自报的计数器（业务层创建，注入给所有 stage 与 Responder） */
  stats: PipelineStats;
  /**
   * Ingress stage 链。**顺序即架构约束**（去重 → 命令 → 闸 → 记录 → Actor 准入，
   * 理由见 ingress/types.ts），由业务层显式排布后整体传入——编排层不决定
   * 有哪些拦截、也不决定它们的顺序。
   */
  stages: readonly IngressStage[];
  /** 输入判定与 Task 提交；只等待短事务，不等待 Task.done。 */
  terminal: (ctx: MessageContext) => Promise<void>;
  /** 命令和准入错误收口工厂；Responder 将消息交给持久队列。 */
  createResponder: (
    message: NormalizedMessage,
    connector: BotConnector,
    policy: ReplyPolicy,
    logger: Logger,
  ) => Responder;
  /**
   * 主动介入层的入口（旁听消息的唯一去向）。
   *
   * 可选：未装配时旁听消息只计一个 skipped 计数（不报错）——这让"只想要
   * @ 回复"的部署不必配介入层，也不会因为收到全量群消息而刷日志。
   */
  observe?: (message: NormalizedMessage) => void;
  /** health 快照的状态探针：准入闸门与谷时段闸的实时状态（对象归业务层持有） */
  status: () => { inFlight: number; queued: number; offpeak: OffpeakSnapshot };
}

export class Orchestrator {
  /**
   * `deps` 用 public readonly 暴露，只有一个用途：测试要基于一份已装配好的
   * 依赖派生一个"改动单点"的实例（例如把介入层入口换成会抛错的桩，验证兜底）。
   * 生产代码不应读取它——依赖是组装期注入的，运行期没有"改依赖"的语义。
   */
  constructor(readonly deps: OrchestratorDeps) {}

  snapshotStats(): PipelineStatsSnapshot {
    const {
      proactiveWaitTickets,
      proactiveWaitTicketCreatedByReason,
      proactiveWaitDeclined,
      proactiveSessionClosedBy,
      proactiveSpokeInSession,
      ...rest
    } = this.deps.stats;
    return {
      ...rest,
      // 按理由/按句数拆开的分布一律映射成**数字**：`dispatcher` 的对外契约是
      // "字段全为数字"（RUNBOOK 在用），分布另在 health 的 proactive 段给。
      proactiveWaitTickets: sumValues(proactiveWaitTickets),
      proactiveWaitTicketCreatedByReason: sumValues(proactiveWaitTicketCreatedByReason),
      proactiveWaitDeclined: sumValues(proactiveWaitDeclined),
      proactiveSessionClosedBy: sumValues(proactiveSessionClosedBy),
      proactiveSpokeInSession: sumValues(proactiveSpokeInSession),
      ...this.deps.status(),
    };
  }

  /** 入口：处理一个归一化事件。永不抛错（所有失败都转成回复或日志）。 */
  async handleEvent(event: NormalizedEvent): Promise<void> {
    // 分流点只有这里一处：旁听消息（群里没 @ bot）不进 Ingress 管线——
    // 不写对话记录、不占并发名额、不回复——只交给主动介入层判断要不要插话。
    if (isObservedMessage(event)) {
      this.handleObserved(event);
      return;
    }
    if (isAddressedMessage(event)) {
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

  /**
   * 旁听消息入口：只投给主动介入层，永不进入 Ingress 管线。
   *
   * 为什么与 handleMessage 分开而不是在里面加一个 if：两者的**后续完全不同**
   * ——旁听消息不该被去重表占据、不该走命令解析、不该写对话记录、不该占并发，
   * 也不该产生任何用户可见的回复。用同一个函数加分支，迟早会有人在这条路径上
   * 加一个"顺手"的副作用。
   */
  private handleObserved(message: NormalizedMessage): void {
    this.deps.stats.observed += 1;
    const observe = this.deps.observe;
    if (observe === undefined) {
      this.deps.stats.observedSkipped += 1;
      return;
    }
    try {
      observe(message);
    } catch (error) {
      // 介入层的第一条纪律是"永不抛错"；这里再兜一层，避免旁听消息把主链路带崩。
      this.deps.logger.warn('旁听消息处理失败（已忽略）', {
        conversation: message.target.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

/** 把"按理由拆开的分布"折成一个数字（见 snapshotStats 的注释）。 */
function sumValues(map: Record<string, number>): number {
  let total = 0;
  for (const value of Object.values(map)) total += value;
  return total;
}
