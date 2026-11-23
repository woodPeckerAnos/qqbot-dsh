/** Public module boundary. Consumers receive contract interfaces. */
import { TaskBudget } from './budget.js';
import { TaskControlBridge } from './control-bridge.js';
import { DshLaneRunner } from './dsh-lane-runner.js';
import { LaneScheduler } from './lane-scheduler.js';
import { TaskLifeCycleManager } from './lifecycle.js';
import { ProactiveTaskAdapter } from './proactive-adapter.js';
import { PromptPreparer } from './prompt-preparer.js';
import { SessionActor } from './session-actor.js';
import { TaskSystem } from './system.js';
import { TaskCooperation } from './cooperation.js';
import { TaskLifeCycleManagerV3 } from './lifecycle-v3.js';
import { SessionActorV3 } from './session-actor-v3.js';
import { JobSchedulerV3 } from './job-scheduler.js';
import { TaskControlBridgeV3 } from './control-bridge-v3.js';
import { DshTaskRunnerV3 } from './dsh-task-runner-v3.js';
import { PromptPreparerV3 } from './prompt-preparer-v3.js';
import { TaskSystemV3 } from './system-v3.js';
export const createTaskCooperation: import('@qqbot/contracts').createTaskCooperationFactory = (
  ...args
) => new TaskCooperation(...args);
export const createTaskBudget: import('@qqbot/contracts').createTaskBudgetFactory = (...args) =>
  new TaskBudget(...args);
export const createTaskControlBridgeV2: import('@qqbot/contracts').createTaskControlBridgeFactoryV2 =
  (...args) => new TaskControlBridge(...args);
export const createDshLaneRunnerV2: import('@qqbot/contracts').createDshLaneRunnerFactoryV2 = (
  ...args
) => new DshLaneRunner(...args);
export const createLaneSchedulerV2: import('@qqbot/contracts').createLaneSchedulerFactoryV2 = (
  ...args
) => new LaneScheduler(...args);
export const createTaskLifeCycleManagerV2: import('@qqbot/contracts').createTaskLifeCycleManagerFactoryV2 =
  (...args) => new TaskLifeCycleManager(...args);
export const createProactiveTaskAdapterV2: import('@qqbot/contracts').createProactiveTaskAdapterFactoryV2 =
  (...args) => new ProactiveTaskAdapter(...args);
export const createPromptPreparerV2: import('@qqbot/contracts').createPromptPreparerFactoryV2 = (
  ...args
) => new PromptPreparer(...args);
export const createSessionActorV2: import('@qqbot/contracts').createSessionActorFactoryV2 = (
  ...args
) => new SessionActor(...args);
export const createTaskSystemV2: import('@qqbot/contracts').createTaskSystemFactoryV2 = (...args) =>
  new TaskSystem(...args);
export const createTaskLifeCycleManagerV3: import('@qqbot/contracts').createTaskLifeCycleManagerFactoryV3 =
  (...args) => new TaskLifeCycleManagerV3(...args);
export const createSessionActorV3: import('@qqbot/contracts').createSessionActorFactoryV3 = (
  ...args
) => new SessionActorV3(...args);
export const createJobSchedulerV3: import('@qqbot/contracts').createJobSchedulerFactoryV3 = (
  ...args
) => new JobSchedulerV3(...args);
export const createTaskControlBridgeV3: import('@qqbot/contracts').createTaskControlBridgeFactoryV3 =
  (...args) => new TaskControlBridgeV3(...args);
export const createDshTaskRunnerV3: import('@qqbot/contracts').createDshTaskRunnerFactoryV3 = (
  ...args
) => new DshTaskRunnerV3(...args);
export const createPromptPreparerV3: import('@qqbot/contracts').createPromptPreparerFactoryV3 = (
  ...args
) => new PromptPreparerV3(...args);
export const createTaskSystemV3: import('@qqbot/contracts').createTaskSystemFactoryV3 = (...args) =>
  new TaskSystemV3(...args);
export const createProactiveTaskAdapterV3: import('@qqbot/contracts').createProactiveTaskAdapterFactoryV3 =
  (...args) => new ProactiveTaskAdapter(...args);
export { SYSTEM_CLOCK } from './clock.js';
export { TaskAdmissionError } from './lifecycle.js';
export {
  buildTaskRuntimeBaseV3,
  buildTaskRuntimeEnvironmentV3,
  startTaskRuntimeCheckV3,
} from './runtime-profile-v3.js';
export { LANES, isTaskTerminal, isLaneTerminal, readonlySnapshot } from './types.js';
