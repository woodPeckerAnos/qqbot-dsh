import type { DeepReadonly } from '../readonly.js';
import type { Result } from '../errors.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { ConfigV3 } from '../config.js';
import type { Logger } from '../logger.js';
import type { RuntimePool } from '../dsh/pool.js';
import type { TaskClock } from './clock.js';
import type { TaskLifeCycleManagerV3 } from './lifecycle-v3.js';
import type { PromptPreparerV3 } from './prompt-preparer-v3.js';
import type { TaskControlBridgeV3 } from './control-bridge-v3.js';
import type {
  FrontendReply,
  FrontendTurnResultV3,
  TaskJobV3,
  TaskSnapshotV3,
  WorkerResult,
} from './types-v3.js';
export interface TaskRunnerV3 {
  runFrontend(
    task: DeepReadonly<TaskSnapshotV3>,
    job: DeepReadonly<TaskJobV3>,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<Result<FrontendTurnResultV3>>;
  runWorker(
    task: DeepReadonly<TaskSnapshotV3>,
    job: DeepReadonly<TaskJobV3>,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<Result<WorkerResult>>;
  runSummary(
    task: DeepReadonly<TaskSnapshotV3>,
    job: DeepReadonly<TaskJobV3>,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<Result<FrontendReply>>;
}
export type createDshTaskRunnerFactoryV3 = (options: {
  pools: { frontend: RuntimePool; worker: RuntimePool };
  manager: TaskLifeCycleManagerV3;
  preparer: PromptPreparerV3;
  control: TaskControlBridgeV3;
  config: ConfigV3;
  logger: Logger;
  clock?: TaskClock;
  contextView?: ReturnType<import('../session/context-v3.js').createSessionContextViewFactoryV3>;
}) => TaskRunnerV3;
