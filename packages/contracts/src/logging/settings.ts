import { immutableConstant } from '../readonly.js';
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
export const DEFAULT_LOGGING: LoggingSettings = immutableConstant({
  level: 'info',
  maxRecordBytes: 8192,
  maxQueuedBytes: 1048576,
  agentDetailLimit: 100,
  dedupeWindowMs: 60000,
  diagnosticTraceIds: [],
  diagnosticSessionKeys: [],
  diagnosticTtlMs: 600000,
  flushTimeoutMs: 2000,
});
export type loggingSettings = (
  update?: Partial<LoggingSettings>,
  previous?: LoggingSettings
) => LoggingSettings;
