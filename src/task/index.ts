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
export const createTaskBudget: import('@qqbot/contracts').createTaskBudgetFactory = (...args) =>
  new TaskBudget(...args);
export const createTaskControlBridge: import('@qqbot/contracts').createTaskControlBridgeFactory = (
  ...args
) => new TaskControlBridge(...args);
export const createDshLaneRunner: import('@qqbot/contracts').createDshLaneRunnerFactory = (
  ...args
) => new DshLaneRunner(...args);
export const createLaneScheduler: import('@qqbot/contracts').createLaneSchedulerFactory = (
  ...args
) => new LaneScheduler(...args);
export const createTaskLifeCycleManager: import('@qqbot/contracts').createTaskLifeCycleManagerFactory =
  (...args) => new TaskLifeCycleManager(...args);
export const createProactiveTaskAdapter: import('@qqbot/contracts').createProactiveTaskAdapterFactory =
  (...args) => new ProactiveTaskAdapter(...args);
export const createPromptPreparer: import('@qqbot/contracts').createPromptPreparerFactory = (
  ...args
) => new PromptPreparer(...args);
export const createSessionActor: import('@qqbot/contracts').createSessionActorFactory = (...args) =>
  new SessionActor(...args);
export const createTaskSystem: import('@qqbot/contracts').createTaskSystemFactory = (...args) =>
  new TaskSystem(...args);
export { SYSTEM_CLOCK } from './clock.js';
export { TaskAdmissionError } from './lifecycle.js';
export { LANES, isTaskTerminal, isLaneTerminal, readonlySnapshot } from './types.js';
