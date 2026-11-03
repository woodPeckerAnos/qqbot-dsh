/**
 * Ingress 运行机制：分流归一化事件，构建输入绑定，驱动注入的 stage 链。
 * main 负责 stage 顺序、SessionActor 提交和消息队列装配。
 * 这里不管理 runtime 事件或等待 Task 执行；状态由注入探针提供。
 */
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
import type { TraceContext, Logger } from '../logger.js';
import type { OffpeakSnapshot } from '../offpeak/index.js';
import type { Responder } from './egress/responder.js';
import type { IngressStage, MessageContext } from './ingress/types.js';
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
    trace?: TraceContext
  ) => Responder;
  /**
   * 主动介入层的入口（旁听消息的唯一去向）。
   *
   * 可选：未装配时旁听消息只计一个 skipped 计数（不报错）——这让"只想要
   * @ 回复"的部署不必配介入层，也不会因为收到全量群消息而刷日志。
   */
  observe?: (message: NormalizedMessage) => void;
  /** health 快照的状态探针：准入闸门与谷时段闸的实时状态（对象归业务层持有） */
  status: () => {
    inFlight: number;
    queued: number;
    offpeak: OffpeakSnapshot;
  };
}
export interface Orchestrator {
  readonly deps: OrchestratorDeps;
  snapshotStats(): PipelineStatsSnapshot;
  /** 入口：处理一个归一化事件。永不抛错（所有失败都转成回复或日志）。 */
  handleEvent(event: NormalizedEvent): Promise<void>;
}
export type createOrchestratorFactory = (deps: OrchestratorDeps) => Orchestrator;
