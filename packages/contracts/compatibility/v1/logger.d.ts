import type { DeepReadonly } from './readonly.js';
import type { EventName, EventFieldsFor, EventFields, LogCategory } from './logging/events.js';
import type { LoggingSettings } from './logging/settings.js';
import type { LogTransport } from './logging/transport.js';
import type { TraceContext } from './logging/trace.js';
export type { LoggedError, redact, errorClass } from './logging/serialize.js';
export type { createTrace, traceSpan, legacyTrace, TraceContext } from './logging/trace.js';
export { DEFAULT_LOGGING } from './logging/settings.js';
export type { LogTransport } from './logging/transport.js';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogRecord {
    level: LogLevel;
    time: number;
    msg: string;
    [key: string]: unknown;
}
export interface Logger {
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
    child(fields: Record<string, unknown>): Logger;
    withTrace(context: TraceContext): Logger;
    event<Name extends EventName>(name: Name, fields?: EventFieldsFor<Name>): boolean;
    /** 首次根因生成身份，上层状态事件只引用；不保留 Error 正文。 */
    cause(error: unknown, classification?: string, fields?: EventFields): string;
    finishExecution(executionId: string): void;
}
export interface RootLogger extends Logger {
    configure(settings: Partial<LoggingSettings>): void;
    snapshot(): LoggingSnapshot;
    flush(timeoutMs?: number): Promise<boolean>;
    tick(): void;
}
interface LoggingSnapshotValue {
    emitted: number;
    deduplicated: number;
    aggregated: number;
    truncated: number;
    dropped: number;
    sinkFailures: number;
    queuedBytes: number;
    droppedByCategory: Record<LogCategory, number>;
    diagnostics: {
        active: boolean;
        targets: number;
        expiresAt?: number;
    };
}
export type LoggingSnapshot = DeepReadonly<LoggingSnapshotValue>;
export interface LoggerOptions {
    level?: LogLevel;
    settings?: Partial<LoggingSettings>;
    sink?: (line: string) => void;
    transport?: LogTransport;
    fields?: Record<string, unknown>;
    extraRedactor?: (text: string) => string;
    now?: () => number;
    id?: () => string;
    autoTick?: boolean;
}
export type createLogger = (options?: LoggerOptions) => RootLogger;
export type createNullLogger = () => RootLogger;
export type { LoggingSettings, loggingSettings } from './logging/settings.js';
