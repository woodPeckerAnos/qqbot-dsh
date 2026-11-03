/** Public module boundary. Consumers receive contract interfaces. */
import { LogBuffer } from '../logging/transport.js';
export const createLogBuffer: import('@qqbot/contracts').createLogBufferFactory = (...args) =>
  new LogBuffer(...args);
import {
  createHealthServer as createHealthServerImplementation,
  buildHealthSnapshot as buildHealthSnapshotImplementation,
} from '../health.js';
export const createHealthServer: import('@qqbot/contracts').createHealthServer =
  createHealthServerImplementation;
export const buildHealthSnapshot: import('@qqbot/contracts').buildHealthSnapshot =
  buildHealthSnapshotImplementation;
export { EVENT_STALE_THRESHOLD_MS } from '../health.js';
import {
  createLogger as createLoggerImplementation,
  createNullLogger as createNullLoggerImplementation,
} from '../logger.js';
export const createLogger: import('@qqbot/contracts').createLogger = createLoggerImplementation;
export const createNullLogger: import('@qqbot/contracts').createNullLogger =
  createNullLoggerImplementation;
export { LOG_CATEGORIES, EVENTS } from '../logging/events.js';
import { installLoggingReload as installLoggingReloadImplementation } from '../logging/reload.js';
export const installLoggingReload: import('@qqbot/contracts').installLoggingReload =
  installLoggingReloadImplementation;
import {
  redact as redactImplementation,
  errorClass as errorClassImplementation,
  safeValue as safeValueImplementation,
  recordLine as recordLineImplementation,
} from '../logging/serialize.js';
export const redact: import('@qqbot/contracts').redact = redactImplementation;
export const errorClass: import('@qqbot/contracts').errorClass = errorClassImplementation;
export const safeValue: import('@qqbot/contracts').safeValue = safeValueImplementation;
export const recordLine: import('@qqbot/contracts').recordLine = recordLineImplementation;
export { LoggedError } from '../logging/serialize.js';
import { loggingSettings as loggingSettingsImplementation } from '../logging/settings.js';
export const loggingSettings: import('@qqbot/contracts').loggingSettings =
  loggingSettingsImplementation;
export { DEFAULT_LOGGING } from '../logging/settings.js';
import {
  createTrace as createTraceImplementation,
  traceSpan as traceSpanImplementation,
  legacyTrace as legacyTraceImplementation,
} from '../logging/trace.js';
export const createTrace: import('@qqbot/contracts').createTrace = createTraceImplementation;
export const traceSpan: import('@qqbot/contracts').traceSpan = traceSpanImplementation;
export const legacyTrace: import('@qqbot/contracts').legacyTrace = legacyTraceImplementation;
import { stderrTransport as stderrTransportImplementation } from '../logging/transport.js';
export const stderrTransport: import('@qqbot/contracts').stderrTransport =
  stderrTransportImplementation;

import { PipelineStats } from '../pipeline/stats.js';
export const createPipelineStats: import('@qqbot/contracts').createPipelineStatsFactory = () =>
  new PipelineStats();
