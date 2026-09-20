/**
 * 结构化日志。**必须写 stderr**。
 *
 * 原因：DSH runtime 子进程与将来的 SDK 传输都约定 stdout 归协议帧所有。
 * 机器人自身一旦往 stdout 写日志，任何复用 stdout 的路径都会被污染。
 * 所以本进程的 stdout 全程保持干净，日志一律走 stderr。
 *
 * 另外做密钥脱敏：access_token / AppSecret / API key 绝不进日志。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 需要从日志里抹掉的模式（顺序敏感：先长后短）。 */
const REDACTIONS: Array<[RegExp, string]> = [
  // Authorization: QQBot <token>
  [/(QQBot\s+)[A-Za-z0-9._-]{8,}/g, '$1<redacted>'],
  // DeepSeek / OpenAI 风格密钥
  [/\bsk-[A-Za-z0-9]{8,}/g, 'sk-<redacted>'],
  // JSON 字段形式
  [/"(access_token|clientSecret|client_secret|appSecret|apiKey|api_key|DEEPSEEK_API_KEY)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"'],
  // env 形式
  [/\b(QQ_APP_SECRET|DEEPSEEK_API_KEY)=[^\s"']+/g, '$1=<redacted>'],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

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
  /** 派生子 logger，自动带上固定字段（例如 group / session） */
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** 输出目标，默认 process.stderr；测试里可替换 */
  sink?: (line: string) => void;
  /** 派生 logger 的固定字段 */
  fields?: Record<string, unknown>;
  /** 额外的脱敏函数（例如运行期才拿到的 token） */
  extraRedactor?: (text: string) => string;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const threshold = LEVEL_ORDER[level];
  const baseFields = options.fields ?? {};
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));

  const emit = (recordLevel: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[recordLevel] < threshold) return;
    const record: LogRecord = {
      level: recordLevel,
      time: Date.now(),
      msg,
      ...baseFields,
      ...fields,
    };
    let line = JSON.stringify(record, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    if (options.extraRedactor) line = options.extraRedactor(line);
    sink(redact(line));
  };

  const logger: Logger = {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) =>
      createLogger({ ...options, level, fields: { ...baseFields, ...fields } }),
  };
  return logger;
}

/** 无副作用的空 logger，供单测使用 */
export function createNullLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
