import type { Config } from '../config.js';
import type { BotConnector, NormalizedMessage } from '../core/connector.js';
import type {
  RuntimePoolV2 as RuntimePool,
  RuntimePoolOptionsV2 as RuntimePoolOptions,
} from '../dsh/pool-v2.js';
import type { DocumentExtractor } from '../dsh/files.js';
import type { TraceContext, Logger } from '../logger.js';
import type { PipelineStats } from '../pipeline/stats.js';
import type { TopicJudge } from '../pipeline/topic-judge.js';
import type { ConversationStore } from '../store/conversations.js';
import type { ObservationWindowStore } from '../store/window.js';
import type { StorePaths } from '../store/paths.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { TaskLifeCycleManagerV3 } from './lifecycle-v3.js';
import type { TaskBudget } from './budget.js';
import type { MessageQueue } from './message-queue.js';
import type { SessionOutputCoordinatorV3 } from './output-coordinator-v3.js';
import type { LaneRunnerV3 } from './dsh-lane-runner-v3.js';
import type { SessionActorV3 } from './session-actor-v3.js';
import type { ProactiveTaskAdapterV3 } from './proactive-adapter-v3.js';
import type { TaskClock } from './clock.js';
import type { Lane } from './types-v3.js';
export interface TaskSystemV3 {
  readonly manager: TaskLifeCycleManagerV3;
  readonly budget: TaskBudget;
  readonly queue: MessageQueue;
  readonly pools: Record<Lane, RuntimePool>;
  readonly actor: SessionActorV3;
  readonly output: SessionOutputCoordinatorV3;
  readonly cooperation: import('./cooperation.js').TaskCooperation;
  readonly proactive: ProactiveTaskAdapterV3;
  /** Task 工作区与协调器缓存一起到期；待发附件副本不受此清理影响。 */
  prune(): Promise<void>;
  context(
    message: NormalizedMessage,
    isAdmin?: boolean,
    suppliedTrace?: TraceContext
  ): MessageContext;
  close(): Promise<void>;
}
export type createTaskSystemFactoryV3 = (options: {
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
  runner?: LaneRunnerV3;
  clock?: TaskClock;
  runtimeFactory?: RuntimePoolOptions['runtimeFactory'];
}) => TaskSystemV3;
