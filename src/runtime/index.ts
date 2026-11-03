/** Public module boundary. Consumers receive contract interfaces. */
import { AgentTraceObserver } from '../dsh/agent-trace.js';
import { RuntimePool } from '../dsh/pool.js';
import { DshRuntime } from '../dsh/process.js';
import { HarnessSdkClient } from '../dsh/protocol.js';
import { TurnAccumulator } from '../dsh/turns.js';
export const createAgentTraceObserver: import('@qqbot/contracts').createAgentTraceObserverFactory =
  (...args) => new AgentTraceObserver(...args);
export const createRuntimePool: import('@qqbot/contracts').createRuntimePoolFactory = (...args) =>
  new RuntimePool(...args);
export const createDshRuntime: import('@qqbot/contracts').createDshRuntimeFactory = (...args) =>
  new DshRuntime(...args);
export const createHarnessSdkClient: import('@qqbot/contracts').createHarnessSdkClientFactory = (
  ...args
) => new HarnessSdkClient(...args);
export const createTurnAccumulator: import('@qqbot/contracts').createTurnAccumulatorFactory = (
  ...args
) => new TurnAccumulator(...args);
import { stableSessionId as stableSessionIdImplementation } from '../dsh/pool.js';
export const stableSessionId: import('@qqbot/contracts').stableSessionId =
  stableSessionIdImplementation;
import { parseSessionEvent as parseSessionEventImplementation } from '../dsh/protocol.js';
export const parseSessionEvent: import('@qqbot/contracts').parseSessionEvent =
  parseSessionEventImplementation;
export {
  SDK_SERVER_INFO_NAME,
  JsonRpcResponseError,
  ProtocolViolationError,
} from '../dsh/protocol.js';
import { extractAssistantText as extractAssistantTextImplementation } from '../dsh/turns.js';
export const extractAssistantText: import('@qqbot/contracts').extractAssistantText =
  extractAssistantTextImplementation;
