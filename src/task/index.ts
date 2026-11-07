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
export { SYSTEM_CLOCK } from './clock.js';
export { TaskAdmissionError } from './lifecycle.js';
export { LANES, isTaskTerminal, isLaneTerminal, readonlySnapshot } from './types.js';
