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
export const createTaskControlBridgeV3: import('@qqbot/contracts').createTaskControlBridgeFactoryV3 =
  (...args) => new TaskControlBridge(...args);
export const createDshLaneRunnerV3: import('@qqbot/contracts').createDshLaneRunnerFactoryV3 = (
  ...args
) => new DshLaneRunner(...args);
export const createLaneSchedulerV3: import('@qqbot/contracts').createLaneSchedulerFactoryV3 = (
  ...args
) => new LaneScheduler(...args);
export const createTaskLifeCycleManagerV3: import('@qqbot/contracts').createTaskLifeCycleManagerFactoryV3 =
  (...args) => new TaskLifeCycleManager(...args);
export const createProactiveTaskAdapterV3: import('@qqbot/contracts').createProactiveTaskAdapterFactoryV3 =
  (...args) => new ProactiveTaskAdapter(...args);
export const createPromptPreparerV3: import('@qqbot/contracts').createPromptPreparerFactoryV3 = (
  ...args
) => new PromptPreparer(...args);
export const createSessionActorV3: import('@qqbot/contracts').createSessionActorFactoryV3 = (
  ...args
) => new SessionActor(...args);
export const createTaskSystemV3: import('@qqbot/contracts').createTaskSystemFactoryV3 = (...args) =>
  new TaskSystem(...args);
export { SYSTEM_CLOCK } from './clock.js';
export { TaskAdmissionError } from './lifecycle.js';
export { LANES, isTaskTerminal, isLaneTerminal, readonlySnapshot } from './types.js';
