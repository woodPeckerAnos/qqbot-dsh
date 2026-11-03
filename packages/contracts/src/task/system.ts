import type { Config } from '../config.js';
import type { BotConnector, NormalizedMessage } from '../core/connector.js';
import type { RuntimePool, RuntimePoolOptions } from '../dsh/pool.js';
import type { DocumentExtractor } from '../dsh/files.js';
import type { TraceContext, Logger } from '../logger.js';
import type { PipelineStats } from '../pipeline/stats.js';
import type { TopicJudge } from '../pipeline/topic-judge.js';
import type { ConversationStore } from '../store/conversations.js';
import type { ObservationWindowStore } from '../store/window.js';
import type { StorePaths } from '../store/paths.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { TaskLifeCycleManager } from './lifecycle.js';
import type { TaskBudget } from './budget.js';
import type { MessageQueue } from './message-queue.js';
import type { SessionOutputCoordinator } from './output-coordinator.js';
import type { LaneRunner } from './dsh-lane-runner.js';
import type { SessionActor } from './session-actor.js';
import type { ProactiveTaskAdapter } from './proactive-adapter.js';
import type { TaskClock } from './clock.js';
import type { Lane } from './types.js';
export interface TaskSystem {
  readonly manager: TaskLifeCycleManager;
  readonly budget: TaskBudget;
  readonly queue: MessageQueue;
  readonly pools: Record<Lane, RuntimePool>;
  readonly actor: SessionActor;
  readonly output: SessionOutputCoordinator;
  readonly proactive: ProactiveTaskAdapter;
  /** Task 工作区与协调器缓存一起到期；待发附件副本不受此清理影响。 */
  prune(): Promise<void>;
  context(
    message: NormalizedMessage,
    isAdmin?: boolean,
    suppliedTrace?: TraceContext
  ): MessageContext;
  close(): Promise<void>;
}
export type createTaskSystemFactory = (options: {
  config: Config;
  logger: Logger;
  paths: StorePaths;
  connectors: ReadonlyMap<string, BotConnector>;
  conversations: ConversationStore;
  windows: ObservationWindowStore;
  stats: PipelineStats;
  extractDocument?: DocumentExtractor;
  topicJudge?: TopicJudge;
  topicJudgeResult?: import('../pipeline/topic-judge.js').TopicJudgeResult;
  modelPatches?: string[];
  pools?: Record<Lane, RuntimePool>;
  runner?: LaneRunner;
  clock?: TaskClock;
  runtimeFactory?: RuntimePoolOptions['runtimeFactory'];
}) => TaskSystem;
