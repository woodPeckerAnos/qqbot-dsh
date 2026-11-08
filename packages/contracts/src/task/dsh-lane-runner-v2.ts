import type { DeepReadonly } from '../readonly.js';
import type { RuntimePool } from '../dsh/pool.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { TaskClock } from './clock.js';
import type { TaskLifeCycleManagerV2 } from './lifecycle-v2.js';
import type { PromptPreparerV2 } from './prompt-preparer-v2.js';
import type { TaskControlBridgeV2 } from './control-bridge-v2.js';
import type { Lane, LaneEvent, LaneResultV2, TaskSnapshotV2 } from './types-v2.js';
/** 调度器只依赖此接口，验收可替换 DSH，不需要真实模型或已部署客户端。 */
export interface LaneRunnerV2 {
  run(
    task: DeepReadonly<TaskSnapshotV2>,
    lane: Lane,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<LaneResultV2>;
}
export interface DshLaneRunnerV2 {
  /** Successful NO_REPLY with artifacts becomes a bodyless reply on record-capable platforms. */
  run(
    task: DeepReadonly<TaskSnapshotV2>,
    lane: Lane,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<LaneResultV2>;
}
export type createDshLaneRunnerFactoryV2 = (options: {
  pools: Record<Lane, RuntimePool>;
  manager: TaskLifeCycleManagerV2;
  preparer: PromptPreparerV2;
  control: TaskControlBridgeV2;
  config: Config;
  logger: Logger;
  clock?: TaskClock;
  cooperation?: import('./cooperation.js').TaskCooperation;
  contextView?: ReturnType<import('../session/context.js').createSessionContextViewFactory>;
  onEvent?: (event: LaneEvent) => void;
}) => DshLaneRunnerV2;
