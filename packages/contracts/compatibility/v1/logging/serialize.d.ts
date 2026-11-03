export type redact = (text: string) => string;
export declare class LoggedError extends Error {
    readonly errorId: string;
    constructor(errorId: string, message: string, options?: ErrorOptions);
}
export type createLoggedErrorFactory = (errorId: string, message: string, options?: ErrorOptions) => LoggedError;
export type errorClass = (error: unknown) => string;
interface SerializationState {
    truncated: boolean;
}
export type safeValue = (value: unknown, seen?: WeakSet<object>, depth?: number, state?: SerializationState) => unknown;
export type recordLine = (record: Record<string, unknown>, maxBytes: number, extra?: (text: string) => string) => {
    line: string;
    truncated: boolean;
};
export {};
