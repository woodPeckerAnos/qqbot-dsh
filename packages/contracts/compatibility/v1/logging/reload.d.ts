import type { LoggingSettings, RootLogger } from '../logger.js';
interface SignalSource {
    on(event: 'SIGHUP', callback: () => void): unknown;
    off(event: 'SIGHUP', callback: () => void): unknown;
}
/** 只改共享 logger；不重建 runtime，也不触碰 Task。依赖可离线注入。 */
export type installLoggingReload = (source: SignalSource, logger: RootLogger, read: () => LoggingSettings) => () => void;
export {};
