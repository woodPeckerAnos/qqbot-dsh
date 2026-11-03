import type { LoggingSettings, RootLogger } from '../logger.js';
interface SignalSource {
  on(event: 'SIGHUP', callback: () => void): unknown;
  off(event: 'SIGHUP', callback: () => void): unknown;
}
/** 只改共享 logger；不重建 runtime，也不触碰 Task。依赖可离线注入。 */
export function installLoggingReload(
  source: SignalSource,
  logger: RootLogger,
  read: () => LoggingSettings
): () => void {
  const reload = () => {
    try {
      logger.configure(read());
    } catch {
      logger.event('logging.reload_failed', { errorClass: 'invalid-logging-config' });
    }
  };
  source.on('SIGHUP', reload);
  return () => {
    source.off('SIGHUP', reload);
  };
}
