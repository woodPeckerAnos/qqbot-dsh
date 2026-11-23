import type { TaskSystemV2, createTaskSystemFactoryV2 } from './system-v2.js';
import type { RuntimePool } from '../dsh/pool.js';
import type { ConfigV3 } from '../config.js';
import type { TaskLifeCycleManagerV3 } from './lifecycle-v3.js';
import type { SessionActorV3 } from './session-actor-v3.js';
import type { SessionOutputCoordinatorV3 } from './output-coordinator-v3.js';
import type { ProactiveTaskAdapterV3 } from './proactive-adapter-v3.js';
import type { TaskRunnerV3 } from './task-runner-v3.js';
export interface TaskSystemV3 extends Omit<
  TaskSystemV2,
  'manager' | 'pools' | 'actor' | 'output' | 'cooperation' | 'proactive'
> {
  readonly manager: TaskLifeCycleManagerV3;
  readonly pools: { frontend: RuntimePool; worker: RuntimePool };
  readonly actor: SessionActorV3;
  readonly output: SessionOutputCoordinatorV3;
  readonly proactive: ProactiveTaskAdapterV3;
}
export type createTaskSystemFactoryV3 = (
  options: Omit<Parameters<createTaskSystemFactoryV2>[0], 'config' | 'pools' | 'runner'> & {
    config: ConfigV3;
    pools?: { frontend: RuntimePool; worker: RuntimePool };
    runner?: TaskRunnerV3;
  }
) => TaskSystemV3;
