export declare const FAILURE_CODES: readonly ["INVALID_INPUT", "NOT_FOUND", "STALE_DATA", "PERSISTENCE_FAILED", "UPSTREAM_FAILED", "TIMEOUT", "CANCELLED", "CLOSED", "CONFLICT", "UNKNOWN_OUTCOME"];
export type FailureCode = (typeof FAILURE_CODES)[number];
export interface ContractFailure {
    readonly code: FailureCode;
    readonly retry: 'safe' | 'never' | 'after-change';
    readonly errorId?: string;
    readonly cause?: unknown;
}
export type Result<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: ContractFailure;
};
export declare function failure(code: FailureCode, cause?: unknown, errorId?: string): ContractFailure;
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
export interface MessageStateWriter extends StateWriter<import('./task/message-queue.js').QueuedMessage> {
    readonly domain?: 'messages';
}
export interface BudgetStateWriter extends StateWriter<import('./task/budget.js').BudgetRecord> {
    readonly domain?: 'task-budgets';
}
export interface SessionStateWriter extends StateWriter<import('./task/session-actor.js').SessionContextState> {
    readonly domain?: 'task-sessions';
}
