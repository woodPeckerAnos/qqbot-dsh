import type { LogLevel } from '../logger.js';
export interface LoggingSettings {
    level: LogLevel;
    maxRecordBytes: number;
    maxQueuedBytes: number;
    agentDetailLimit: number;
    dedupeWindowMs: number;
    diagnosticTraceIds: string[];
    diagnosticSessionKeys: string[];
    diagnosticTtlMs: number;
    flushTimeoutMs: number;
}
export declare const DEFAULT_LOGGING: LoggingSettings;
export type loggingSettings = (update?: Partial<LoggingSettings>, previous?: LoggingSettings) => LoggingSettings;
