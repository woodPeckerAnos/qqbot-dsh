import { immutableConstant } from '../readonly.js';
import type { DeepReadonly } from '../readonly.js';
import type { NormalizedMessage } from '../core/connector.js';
import type { ConversationTurn } from '../store/conversations.js';
import type { ObservationEntry } from '../store/window.js';
import type { QueuedMessage } from '../task/message-queue.js';
import type { TaskSnapshotV2 } from '../task/types-v2.js';
import type { Lane, LaneStatus, TaskStatus } from '../task/types.js';

export interface SessionContextSettings {
  mode: 'off' | 'board-only' | 'full';
  progressGuard: boolean;
  maxCharsPerTask: number;
  maxTotalChars: number;
  maxTasks: number;
  maxRecentMessages: number;
  recentTaskWindowMs: number;
}
export const DEFAULT_SESSION_CONTEXT: Readonly<SessionContextSettings> = immutableConstant({
  mode: 'board-only',
  progressGuard: true,
  maxCharsPerTask: 8000,
  maxTotalChars: 12000,
  maxTasks: 8,
  maxRecentMessages: 0,
  recentTaskWindowMs: 300000,
});
export type ContextDeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';
export interface ContextLane {
  status: LaneStatus;
  resultKind?: string;
  text: string;
  originalChars: number;
  omittedChars: number;
  delivery: ContextDeliveryStatus;
}
export interface ContextTask {
  taskId: string;
  source: 'user' | 'proactive';
  senderId: string;
  status: TaskStatus;
  explicit: boolean;
  createdAt: number;
  endedAt?: number;
  question: string;
  questionOmittedChars: number;
  lanes: Record<Lane, ContextLane>;
}
export interface ContextMessage {
  source: 'conversation' | 'window';
  speaker: string;
  text: string;
  ts: number;
}
export interface SessionContextViewValue {
  scope: {
    sessionKey: string;
    generation: number;
    taskId: string;
    since: number;
    now: number;
    recentSince?: number;
  };
  tasks: ContextTask[];
  messages: ContextMessage[];
  stats: {
    eligibleTasks: number;
    omittedTasks: number;
    eligibleMessages: number;
    omittedMessages: number;
    omittedChars: number;
    truncated: boolean;
  };
  maxTotalChars: number;
}
export type SessionContextView = DeepReadonly<SessionContextViewValue>;
/** Synchronous reads; the factory owns neither execution nor delivery state. */
export type createSessionContextViewFactory = (options: {
  settings?: Partial<SessionContextSettings>;
  tasks: (sessionKey: string) => DeepReadonly<TaskSnapshotV2[]>;
  messages: (taskId: string) => DeepReadonly<QueuedMessage[]>;
  generation: (sessionKey: string) => number;
  sinceTs?: (sessionKey: string) => number;
  conversations?: (sessionKey: string) => DeepReadonly<ConversationTurn[]>;
  window?: (sessionKey: string) => DeepReadonly<ObservationEntry[]>;
  now?: () => number;
}) => { read(task: DeepReadonly<TaskSnapshotV2>): SessionContextView };
export type renderSessionContextView = (view: SessionContextView) => string;
export type classifyTaskFollowUp = (options: {
  message: DeepReadonly<NormalizedMessage>;
  generation: number;
  tasks: DeepReadonly<TaskSnapshotV2[]>;
  now: number;
  beforeSequence?: number;
  recentTaskWindowMs?: number;
}) => Readonly<{ followUpOf?: string; progressOnly?: boolean }>;
