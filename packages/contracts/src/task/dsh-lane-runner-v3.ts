import type { DeepReadonly } from '../readonly.js';
import type { RuntimePoolV2 as RuntimePool } from '../dsh/pool-v2.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { TaskClock } from './clock.js';
import type { TaskLifeCycleManagerV3 } from './lifecycle-v3.js';
import type { PromptPreparerV3 } from './prompt-preparer-v3.js';
import type { TaskControlBridgeV3 } from './control-bridge-v3.js';
import type { Lane, LaneEvent, LaneResultV3, TaskSnapshotV3 } from './types-v3.js';
/** 调度器只依赖此接口，验收可替换 DSH，不需要真实模型或已部署客户端。 */
export interface LaneRunnerV3 {
  run(
    task: DeepReadonly<TaskSnapshotV3>,
    lane: Lane,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<LaneResultV3>;
}
export interface DshLaneRunnerV3 {
  /** Successful NO_REPLY with artifacts becomes a bodyless reply on record-capable platforms. */
  run(
    task: DeepReadonly<TaskSnapshotV3>,
    lane: Lane,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<LaneResultV3>;
}
export type createDshLaneRunnerFactoryV3 = (options: {
  pools: Record<Lane, RuntimePool>;
  manager: TaskLifeCycleManagerV3;
  preparer: PromptPreparerV3;
  control: TaskControlBridgeV3;
  config: Config;
  logger: Logger;
  clock?: TaskClock;
  cooperation?: import('./cooperation.js').TaskCooperation;
  onEvent?: (event: LaneEvent) => void;
}) => DshLaneRunnerV3;
