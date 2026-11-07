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
import type { TaskLifeCycleManagerV2 } from './lifecycle-v2.js';
import type { TaskBudget } from './budget.js';
import type { MessageQueue } from './message-queue.js';
import type { SessionOutputCoordinatorV2 } from './output-coordinator-v2.js';
import type { LaneRunnerV2 } from './dsh-lane-runner-v2.js';
import type { SessionActorV2 } from './session-actor-v2.js';
import type { ProactiveTaskAdapterV2 } from './proactive-adapter-v2.js';
import type { TaskClock } from './clock.js';
import type { Lane } from './types-v2.js';
export interface TaskSystemV2 {
  readonly manager: TaskLifeCycleManagerV2;
  readonly budget: TaskBudget;
  readonly queue: MessageQueue;
  readonly pools: Record<Lane, RuntimePool>;
  readonly actor: SessionActorV2;
  readonly output: SessionOutputCoordinatorV2;
  readonly cooperation: import('./cooperation.js').TaskCooperation;
  readonly proactive: ProactiveTaskAdapterV2;
  /** Task 工作区与协调器缓存一起到期；待发附件副本不受此清理影响。 */
  prune(): Promise<void>;
  context(
    message: NormalizedMessage,
    isAdmin?: boolean,
    suppliedTrace?: TraceContext
  ): MessageContext;
  close(): Promise<void>;
}
export type createTaskSystemFactoryV2 = (options: {
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
  runner?: LaneRunnerV2;
  clock?: TaskClock;
  runtimeFactory?: RuntimePoolOptions['runtimeFactory'];
}) => TaskSystemV2;
