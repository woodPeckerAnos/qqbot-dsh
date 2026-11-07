import { immutableConstant } from './readonly.js';
export const FAILURE_CODES = immutableConstant([
  'INVALID_INPUT',
  'NOT_FOUND',
  'STALE_DATA',
  'PERSISTENCE_FAILED',
  'UPSTREAM_FAILED',
  'TIMEOUT',
  'CANCELLED',
  'CLOSED',
  'CONFLICT',
  'UNKNOWN_OUTCOME',
] as const);
export type FailureCode = (typeof FAILURE_CODES)[number];
export interface ContractFailure {
  readonly code: FailureCode;
  readonly retry: 'safe' | 'never' | 'after-change';
  readonly errorId?: string;
  readonly cause?: unknown;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ContractFailure };
export function failure(code: FailureCode, cause?: unknown, errorId?: string): ContractFailure {
  return Object.freeze({ code, retry: retryPolicy(code), cause, errorId });
}
export interface StateReader<T> {
  load(): T[];
}
export interface StateWriter<T> extends StateReader<T> {
  save(records: readonly T[]): void;
}
export type StateDomain = 'tasks' | 'messages' | 'task-budgets' | 'task-sessions';
export interface StatePersistence {
  reader<T>(domain: StateDomain): StateReader<T>;
}

export interface TaskStateWriter extends StateWriter<import('./task/types.js').TaskSnapshot> {
  readonly domain?: 'tasks';
}
export interface MessageStateWriter extends StateWriter<
  import('./task/message-queue.js').QueuedMessage
> {
  readonly domain?: 'messages';
}
export interface BudgetStateWriter extends StateWriter<import('./task/budget.js').BudgetRecord> {
  readonly domain?: 'task-budgets';
}
export interface SessionStateWriter extends StateWriter<
  import('./task/session-actor.js').SessionContextState
> {
  readonly domain?: 'task-sessions';
}

function retryPolicy(code: FailureCode): ContractFailure['retry'] {
  if (['INVALID_INPUT', 'CANCELLED', 'CLOSED', 'UNKNOWN_OUTCOME'].includes(code)) return 'never';
  if (['PERSISTENCE_FAILED', 'UPSTREAM_FAILED', 'STALE_DATA', 'TIMEOUT'].includes(code))
    return 'safe';
  return 'after-change';
}

export interface TaskStateWriterV2 extends StateWriter<
  import('./task/types-v2.js').TaskSnapshotV2
> {
  readonly domain?: 'tasks';
}
