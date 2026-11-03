import type { DeepReadonly } from '../readonly.js';
import type { Logger, TraceContext } from '../logger.js';
import type { SubagentStartedNotification, SubagentFinishedNotification } from './protocol.js';
export interface AgentTraceObserver {
  observe(raw: unknown): boolean;
  started(n: SubagentStartedNotification): boolean;
  finished(n: SubagentFinishedNotification): boolean;
  invalid(): void;
  unknown(): void;
  snapshot(): DeepReadonly<{
    sessions: number;
    pendingTools: number;
    toolCategories: number;
    errorExamples: number;
    usage: {
      [x: string]: number;
    };
    turns: number;
    steps: number;
    tools: number;
    retries: number;
    subagents: number;
    suppressed: number;
    invalid: number;
    unknown: number;
    late: number;
    duplicate: number;
    overflow: number;
    incomplete: boolean;
  }>;
  close(): void;
}
export type createAgentTraceObserverFactory = (options: {
  trace: TraceContext;
  logger: Logger;
  isCurrent: () => boolean;
  now?: () => number;
  deferBudgetRelease?: boolean;
}) => AgentTraceObserver;
