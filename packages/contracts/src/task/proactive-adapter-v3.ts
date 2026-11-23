import type {
  ProactiveTaskAdapterV2,
  createProactiveTaskAdapterFactoryV2,
} from './proactive-adapter-v2.js';
import type { SessionActorV3 } from './session-actor-v3.js';
export type ProactiveTaskAdapterV3 = ProactiveTaskAdapterV2;
export type createProactiveTaskAdapterFactoryV3 = (
  options: Omit<Parameters<createProactiveTaskAdapterFactoryV2>[0], 'actor'> & {
    actor: SessionActorV3;
  }
) => ProactiveTaskAdapterV3;
