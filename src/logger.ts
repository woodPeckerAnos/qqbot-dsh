import { readonlySnapshot } from '@qqbot/contracts';
import type {
  LogLevel,
  Logger,
  RootLogger,
  LoggingSnapshot,
  LoggerOptions,
} from '@qqbot/contracts';
/** 核心日志：所有子 logger 共享配置、预算和 stderr JSONL 出口。 */
import { randomUUID } from 'node:crypto';
import { EVENTS } from './logging/events.js';
import { LOG_CATEGORIES } from '@qqbot/contracts';
import type { EventName, EventFields, LogCategory } from '@qqbot/contracts';
import { loggingSettings } from './logging/settings.js';
import type { LoggingSettings } from '@qqbot/contracts';
import { LoggedError } from '@qqbot/contracts';
import { errorClass, recordLine } from './logging/serialize.js';
import { LogBuffer, stderrTransport } from './logging/transport.js';
import type { LogTransport } from '@qqbot/contracts';
import type { TraceContext } from '@qqbot/contracts';
export { LoggedError, redact, errorClass } from './logging/serialize.js';
export { createTrace, traceSpan, legacyTrace, type TraceContext } from './logging/trace.js';
export { DEFAULT_LOGGING, loggingSettings, type LoggingSettings } from './logging/settings.js';
export type { LogTransport } from './logging/transport.js';
export type { LogLevel } from '@qqbot/contracts';
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export type { LogRecord } from '@qqbot/contracts';
export type { Logger } from '@qqbot/contracts';
export type { RootLogger } from '@qqbot/contracts';
export type { LoggingSnapshot } from '@qqbot/contracts';
export type { LoggerOptions } from '@qqbot/contracts';
interface ExecutionBudget {
  used: number;
  suppressed: number;
  counts: Record<LogCategory, number>;
}
class LoggerCore {
  settings: LoggingSettings;
  readonly instanceId: string;
  readonly buffer: LogBuffer;
  private expiresAt?: number;
  private lastSummary: number;
  private readonly duplicates = new Map<string, number>();
  private readonly executions = new Map<string, ExecutionBudget>();
  private readonly causes = new WeakMap<object, string>();
  private counts = Object.fromEntries(LOG_CATEGORIES.map((c) => [c, 0])) as Record<
    LogCategory,
    number
  >;
  private readonly drops = { ...this.counts };
  private deduplicated = 0;
  private aggregated = 0;
  private truncated = 0;
  constructor(readonly options: LoggerOptions) {
    this.settings = loggingSettings({
      ...options.settings,
      level: options.level ?? options.settings?.level ?? 'info',
    });
    this.instanceId = this.id();
    this.lastSummary = this.now();
    this.buffer = new LogBuffer(this.transport(), (category) => {
      this.drops[category]++;
    });
    this.activate();
    if (options.autoTick !== false)
      setInterval(() => {
        this.tick();
      }, 60000).unref();
  }
  now(): number {
    return this.options.now?.() ?? Date.now();
  }
  id(): string {
    return this.options.id?.() ?? randomUUID();
  }
  private transport(): LogTransport {
    const sink = this.options.sink;
    if (!sink) return this.options.transport ?? stderrTransport();
    return {
      write: (line, done) => {
        sink(line.slice(0, -1));
        done();
        return true;
      },
    };
  }
  configure(update: Partial<LoggingSettings>): void {
    const next = loggingSettings(update, this.settings);
    if (this.buffer.queuedBytes > next.maxQueuedBytes)
      throw new Error('日志缓冲尚未排空，不能缩小到当前占用以下');
    this.settings = next;
    this.activate();
    this.emit('info', 'logging.configured', 'system', EVENTS['logging.configured'].msg, {
      diagnosticTargets: this.targets(),
      expiresAt: this.expiresAt,
    });
  }
  private activate(): void {
    this.expiresAt = this.targets() ? this.now() + this.settings.diagnosticTtlMs : undefined;
  }
  private targets(): number {
    return this.settings.diagnosticTraceIds.length + this.settings.diagnosticSessionKeys.length;
  }
  private diagnostic(trace?: TraceContext): boolean {
    if (this.expiresAt === undefined || this.now() >= this.expiresAt) return false;
    return (
      !!trace &&
      (this.settings.diagnosticTraceIds.includes(trace.traceId) ||
        this.settings.diagnosticSessionKeys.includes(trace.sessionKey ?? ''))
    );
  }
  event(name: EventName, fields: EventFields, base: EventFields, trace?: TraceContext): boolean {
    try {
      const spec = EVENTS[name];
      const combined = { ...base, ...fields };
      const selected = Object.fromEntries(
        spec.fields.filter((key) => Object.hasOwn(combined, key)).map((key) => [key, combined[key]])
      );
      const identity = trace ? { ...this.baseIdentity(base), ...trace } : this.baseIdentity(base);
      return this.emit(
        spec.level,
        name,
        spec.component,
        spec.msg,
        selected,
        identity,
        spec.diagnostic
      );
    } catch {
      this.drops.system++;
      return false;
    }
  }
  private baseIdentity(base: EventFields): TraceContext | undefined {
    // 无 trace 的资源 logger 也保留 runtime 代次；其余身份由 withTrace 绑定。
    if (typeof base.runtimeGeneration !== 'string') return;
    return {
      traceId: typeof base.traceId === 'string' ? base.traceId : '',
      spanId: typeof base.spanId === 'string' ? base.spanId : '',
      runtimeGeneration: base.runtimeGeneration,
    };
  }
  // 核心提交集中处理阈值、诊断与身份；序列化/传输失败仅改变日志计数。
  emit(
    level: LogLevel,
    event: string,
    category: LogCategory,
    msg: string,
    fields: EventFields,
    trace?: TraceContext,
    diagnostic = false,
    component: string = category
  ): boolean {
    try {
      return this.safeEmit(level, event, category, msg, fields, trace, diagnostic, component);
    } catch {
      this.drops[category]++;
      return false;
    }
  }
  private safeEmit(
    level: LogLevel,
    event: string,
    category: LogCategory,
    msg: string,
    fields: EventFields,
    trace: TraceContext | undefined,
    diagnostic: boolean,
    component: string
  ): boolean {
    if (!this.allowed(level, event, category, trace, diagnostic)) return false;
    if ((diagnostic || level === 'debug') && !this.sample(event, category, msg, fields, trace))
      return false;
    const identity = {
      ...trace,
      schemaVersion: 1,
      event,
      component,
      level,
      time: this.now(),
      msg,
      instanceId: this.instanceId,
    };
    const record = { ...identity, ...fields, ...identity };
    const serialized = recordLine(record, this.settings.maxRecordBytes, this.options.extraRedactor);
    if (serialized.truncated) this.truncated++;
    this.buffer.enqueue(
      serialized.line,
      diagnostic || level === 'debug',
      category,
      this.settings.maxQueuedBytes
    );
    return true;
  }
  private allowed(
    level: LogLevel,
    event: string,
    category: LogCategory,
    trace: TraceContext | undefined,
    diagnostic: boolean
  ): boolean {
    if (event === 'agent.detail' && !this.diagnostic(trace)) {
      this.suppress('agent', trace?.executionId);
      return false;
    }
    if (LEVEL_ORDER[level] >= LEVEL_ORDER[this.settings.level] || this.diagnostic(trace))
      return true;
    if (diagnostic) this.suppress(category, trace?.executionId);
    return false;
  }
  private sample(
    event: string,
    category: LogCategory,
    msg: string,
    fields: EventFields,
    trace?: TraceContext
  ): boolean {
    if (event === 'agent.detail' && !this.detail(trace?.executionId)) return false;
    const key = this.sampleKey(event, category, msg, fields, trace);
    const previous = this.duplicates.get(key);
    if (previous !== undefined && this.now() - previous < this.settings.dedupeWindowMs) {
      this.deduplicated++;
      this.suppress(category, trace?.executionId);
      return false;
    }
    if (this.duplicates.size >= 512)
      this.duplicates.delete(this.duplicates.keys().next().value ?? '');
    this.duplicates.set(key, this.now());
    return true;
  }
  private sampleKey(
    event: string,
    category: LogCategory,
    msg: string,
    fields: EventFields,
    trace?: TraceContext
  ): string {
    const parts = ['reason', 'eventType', 'action', 'trigger'].map((key) =>
      typeof fields[key] === 'string' ? fields[key].slice(0, 80) : ''
    );
    const execution = event === 'agent.detail' ? (trace?.executionId ?? '') : '';
    return `${category}:${event}:${msg}:${parts.join(':')}:${execution}`;
  }

  private detail(id?: string): boolean {
    if (!id) {
      this.suppress('agent');
      return false;
    }
    const budget = this.executionBudget(id);
    if (!budget) {
      this.suppress('agent');
      return false;
    }
    if (budget.used >= this.settings.agentDetailLimit) {
      this.suppress('agent', id);
      return false;
    }
    budget.used++;
    return true;
  }
  private executionBudget(id: string): ExecutionBudget | undefined {
    let budget = this.executions.get(id);
    if (!budget && this.executions.size < 256) {
      budget = {
        used: 0,
        suppressed: 0,
        counts: Object.fromEntries(LOG_CATEGORIES.map((c) => [c, 0])) as Record<
          LogCategory,
          number
        >,
      };
      this.executions.set(id, budget);
    }
    return budget;
  }
  private suppress(category: LogCategory, id?: string): void {
    this.aggregated++;
    this.counts[category]++;
    const budget = id && this.executionBudget(id);
    if (budget) {
      budget.suppressed++;
      budget.counts[category]++;
    }
  }
  finishExecution(id: string, trace?: TraceContext): void {
    const budget = this.executions.get(id);
    if (budget?.suppressed)
      this.emit(
        'info',
        'logging.suppressed',
        'system',
        EVENTS['logging.suppressed'].msg,
        { counts: budget.counts, executionId: id },
        trace
      );
    this.executions.delete(id);
  }
  cause(
    error: unknown,
    classification: string | undefined,
    fields: EventFields,
    base: EventFields,
    trace?: TraceContext
  ): string {
    if (error instanceof LoggedError) return error.errorId;
    const object = error !== null && typeof error === 'object' ? error : undefined;
    const existing = object && this.causes.get(object);
    if (existing) return existing;
    const errorId = this.id();
    if (object) this.causes.set(object, errorId);
    this.event(
      'root.error',
      { ...fields, errorId, errorClass: classification ?? errorClass(error) },
      base,
      trace
    );
    return errorId;
  }
  tick(): void {
    if (this.expiresAt !== undefined && this.now() >= this.expiresAt) this.expiresAt = undefined;
    if (this.now() - this.lastSummary < 60000) return;
    this.lastSummary = this.now();
    const counts = this.counts;
    this.counts = Object.fromEntries(LOG_CATEGORIES.map((c) => [c, 0])) as Record<
      LogCategory,
      number
    >;
    if (Object.values(counts).some(Boolean))
      this.emit('info', 'logging.suppressed', 'system', EVENTS['logging.suppressed'].msg, {
        counts,
      });
    for (const [key, at] of this.duplicates)
      if (this.now() - at >= this.settings.dedupeWindowMs) this.duplicates.delete(key);
  }
  snapshot(): LoggingSnapshot {
    this.tick();
    return readonlySnapshot({
      emitted: this.buffer.emitted,
      deduplicated: this.deduplicated,
      aggregated: this.aggregated,
      truncated: this.truncated,
      dropped: Object.values(this.drops).reduce((sum, n) => sum + n, 0),
      droppedByCategory: { ...this.drops },
      sinkFailures: this.buffer.sinkFailures,
      queuedBytes: this.buffer.queuedBytes,
      diagnostics: {
        active: this.expiresAt !== undefined,
        targets: this.expiresAt === undefined ? 0 : this.targets(),
        expiresAt: this.expiresAt,
      },
    });
  }
  async flush(timeout = this.settings.flushTimeoutMs): Promise<boolean> {
    this.tick();
    const deadline = Date.now() + Math.min(2000, Math.max(0, timeout));
    while (this.buffer.queuedBytes && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    return this.buffer.queuedBytes === 0;
  }
}
function derive(core: LoggerCore, base: EventFields = {}, trace?: TraceContext): Logger {
  const legacy = (level: LogLevel, msg: string, fields: EventFields = {}) => {
    try {
      core.emit(
        level,
        'legacy.log',
        'legacy',
        msg,
        { ...fields, ...base },
        trace,
        level === 'debug',
        typeof base.component === 'string' ? base.component : 'legacy'
      );
    } catch {
      /* 不将异常字段传播到业务。 */
    }
  };
  return {
    debug: (msg, fields) => {
      legacy('debug', msg, fields);
    },
    info: (msg, fields) => {
      legacy('info', msg, fields);
    },
    warn: (msg, fields) => {
      legacy('warn', msg, fields);
    },
    error: (msg, fields) => {
      legacy('error', msg, fields);
    },
    child: (fields) => derive(core, { ...base, ...fields }, trace),
    withTrace: (context) => derive(core, base, Object.freeze({ ...context })),
    event: (name, fields = {}) => core.event(name, fields, base, trace),
    cause: (error, classification, fields = {}) => {
      try {
        return core.cause(error, classification, fields, base, trace);
      } catch {
        return 'logging-unavailable';
      }
    },
    finishExecution: (id) => {
      core.finishExecution(id, trace);
    },
  };
}
export function createLogger(options: LoggerOptions = {}): RootLogger {
  const core = new LoggerCore(options);
  return {
    ...derive(core, options.fields),
    configure: (settings) => {
      core.configure(settings);
    },
    snapshot: () => core.snapshot(),
    flush: (timeout) => core.flush(timeout),
    tick: () => {
      core.tick();
    },
  };
}
export function createNullLogger(): RootLogger {
  return createLogger({ level: 'error', sink: () => {}, autoTick: false });
}
