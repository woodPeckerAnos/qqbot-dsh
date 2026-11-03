import type { DeepReadonly } from '../readonly.js';
import type { RuntimePool } from '../dsh/pool.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { TaskClock } from './clock.js';
import type { TaskLifeCycleManager } from './lifecycle.js';
import type { PromptPreparer } from './prompt-preparer.js';
import type { TaskControlBridge } from './control-bridge.js';
import type { Lane, LaneEvent, LaneResult, TaskSnapshot } from './types.js';
/** 调度器只依赖此接口，验收可替换 DSH，不需要真实模型或已部署客户端。 */
export interface LaneRunner {
  run(
    task: DeepReadonly<TaskSnapshot>,
    lane: Lane,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<LaneResult>;
}
export interface DshLaneRunner {
  run(
    task: DeepReadonly<TaskSnapshot>,
    lane: Lane,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<LaneResult>;
}
export type createDshLaneRunnerFactory = (options: {
  pools: Record<Lane, RuntimePool>;
  manager: TaskLifeCycleManager;
  preparer: PromptPreparer;
  control: TaskControlBridge;
  config: Config;
  logger: Logger;
  clock?: TaskClock;
  onEvent?: (event: LaneEvent) => void;
}) => DshLaneRunner;
