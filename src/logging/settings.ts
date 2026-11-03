import { DEFAULT_LOGGING } from '@qqbot/contracts';
import type { LoggingSettings } from '@qqbot/contracts';
import { ConfigError } from '@qqbot/contracts';

export type { LoggingSettings } from '@qqbot/contracts';
export { DEFAULT_LOGGING } from '@qqbot/contracts';
const LIMITS = {
  maxRecordBytes: [1024, 8192],
  maxQueuedBytes: [8192, 1048576],
  agentDetailLimit: [0, 100],
  dedupeWindowMs: [1000, 60000],
  diagnosticTtlMs: [1000, 1800000],
  flushTimeoutMs: [0, 2000],
} as const;
export function loggingSettings(
  update: Partial<LoggingSettings> = {},
  previous = DEFAULT_LOGGING
): LoggingSettings {
  const settings = { ...previous, ...update };
  if (!['debug', 'info', 'warn', 'error'].includes(settings.level))
    throw new ConfigError('日志 level 非法');
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const value = settings[key as keyof typeof LIMITS];
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new ConfigError(`logging.${key} 必须在 ${min}..${max} 内`);
  }
  validateTargets(settings);
  return settings;
}
function validateTargets(settings: LoggingSettings): void {
  const targets = [...settings.diagnosticTraceIds, ...settings.diagnosticSessionKeys];
  if (
    targets.length > 8 ||
    targets.some((s) => typeof s !== 'string' || !s.length || s.length > 256)
  )
    throw new ConfigError('日志诊断目标最多 8 个，每个须为 1..256 字符');
  if (settings.maxQueuedBytes < settings.maxRecordBytes)
    throw new ConfigError('日志缓冲必须容纳一条记录');
  settings.diagnosticTraceIds = [...settings.diagnosticTraceIds];
  settings.diagnosticSessionKeys = [...settings.diagnosticSessionKeys];
}
