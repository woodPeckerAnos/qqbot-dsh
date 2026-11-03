/** 脱敏先于字节截断；不调用 toJSON/getter，也不保留业务内容和错误正文。 */
import { LOG_CATEGORIES } from './events.js';

const PRIVATE_KEY =
  /^(raw|frame|body|content|text|preview|response|result|arguments|params|line|detail|stderr|stack|lastAssistantMessage|transcript|evidence|directive|excerpt|url|message|prompt|input|output|args|toolArguments|toolResults)$/i;
const SECRET_KEY = /(token|secret|password|authorization|api[_-]?key|credential|cookie)/i;
export function redact(text: string): string {
  return text
    .replace(/\b(QQBot|Bearer)\s+[A-Za-z0-9._-]{8,}/gi, '$1 <redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
    .replace(
      /"([^"\s]*(?:token|secret|password|api[_-]?key|authorization)[^"\s]*)"\s*:\s*"[^"]*"/gi,
      '"$1":"<redacted>"'
    )
    .replace(/\b([A-Z_]*(?:TOKEN|SECRET|API_KEY|PASSWORD))=[^\s"']+/g, '$1=<redacted>');
}
export class LoggedError extends Error {
  constructor(
    readonly errorId: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}
export function errorClass(error: unknown): string {
  if (typeof error === 'string' && /^[a-z]+(?:-[a-z]+){0,4}$/.test(error))
    return error.slice(0, 80);
  if (error instanceof Error) return error.name || 'Error';
  return 'unknown';
}
interface SerializationState {
  truncated: boolean;
}
function primitive(value: unknown, state: SerializationState): unknown {
  if (typeof value === 'string') {
    const clean = redact(value);
    if (clean.length > 512) state.truncated = true;
    return clean.slice(0, 512);
  }
  if (typeof value === 'bigint') return primitive(value.toString(), state);
  if (typeof value === 'function' || typeof value === 'symbol') return '<unsupported>';
  return value;
}
export function safeValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  state: SerializationState = { truncated: false }
): unknown {
  if (value === null || typeof value !== 'object') return primitive(value, state);
  try {
    if (value instanceof Error) return { name: value.name, errorClass: errorClass(value) };
    if (seen.has(value)) return '<circular>';
    if (depth >= 6) {
      state.truncated = true;
      return '<depth-limit>';
    }
    seen.add(value);
    return safeObject(value, seen, depth, state);
  } catch {
    return '<unserializable>';
  }
}
function safeObject(
  value: object,
  seen: WeakSet<object>,
  depth: number,
  state: SerializationState
): unknown {
  if (Array.isArray(value)) {
    if (value.length > 64) state.truncated = true;
    return value.slice(0, 64).map((v: unknown) => safeValue(v, seen, depth + 1, state));
  }
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value);
  if (keys.length > 64) state.truncated = true;
  for (const key of keys.slice(0, 64)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      out[key] = '<accessor>';
      continue;
    }
    copyField(out, key, descriptor.value, seen, depth, state);
  }
  return out;
}
function copyField(
  out: Record<string, unknown>,
  key: string,
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  state: SerializationState
): void {
  if (key === 'counts') {
    out.counts = categoryCounts(value);
    return;
  }
  if (SECRET_KEY.test(key) && !/Tokens$/.test(key)) {
    out[key] = '<redacted>';
    return;
  }
  if (PRIVATE_KEY.test(key)) {
    out[`${key}Length`] = typeof value === 'string' ? value.length : 0;
    return;
  }
  if (key === 'error') {
    out.errorClass = errorClass(value);
    return;
  }
  out[redact(key).slice(0, 128)] = safeValue(value, seen, depth + 1, state);
}
function categoryCounts(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (value === null || typeof value !== 'object') return counts;
  for (const category of LOG_CATEGORIES) {
    const descriptor = Object.getOwnPropertyDescriptor(value, category);
    const count: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
      counts[category] = count;
  }
  return counts;
}
export function recordLine(
  record: Record<string, unknown>,
  maxBytes: number,
  extra?: (text: string) => string
): { line: string; truncated: boolean } {
  const state = { truncated: false };
  const safe = safeValue(record, new WeakSet(), 0, state) as Record<string, unknown>;
  if (state.truncated) safe.truncated = true;
  let line = JSON.stringify(safe);
  if (extra) line = extra(line);
  line = redact(line);
  // 外部 redactor 也必须返回合法 JSON，不允许破坏 JSONL 协议。
  JSON.parse(line);
  if (Buffer.byteLength(line) + 1 <= maxBytes) return { line, truncated: state.truncated };
  return { line: compactLine(line, maxBytes), truncated: true };
}
function compactLine(original: string, maxBytes: number): string {
  const identity = [
    'schemaVersion',
    'event',
    'component',
    'level',
    'time',
    'msg',
    'instanceId',
    'traceId',
    'spanId',
    'parentSpanId',
    'sessionKey',
    'inputMessageId',
    'inputEventId',
    'taskId',
    'lane',
    'executionId',
    'runtimeGeneration',
    'dshSessionId',
    'dshSeq',
    'messageId',
    'historicalTraceMissing',
    'status',
    'errorId',
    'errorClass',
  ];
  const compact: Record<string, unknown> = { truncated: true };
  const clean = JSON.parse(original) as Record<string, unknown>;
  for (const key of identity) if (clean[key] !== undefined) compact[key] = clean[key];
  let line = JSON.stringify(compact);
  // 恶意超长身份仍必须有界，保持 UTF-8 与 JSON 完整。
  while (Buffer.byteLength(line) + 1 > maxBytes) {
    const key = Object.keys(compact).findLast(
      (k) => typeof compact[k] === 'string' && compact[k].length > 16
    );
    if (!key) break;
    compact[key] = (compact[key] as string).slice(
      0,
      Math.floor((compact[key] as string).length / 2)
    );
    line = JSON.stringify(compact);
  }
  return line;
}
