import { readonlySnapshot } from '@qqbot/contracts';
/** 只读实时通知；与父会话结果累积器独立。DSH 构造时继承历史不回灌。 */
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry';
import type { SessionEventMap } from '@deepseek-ai/dsh-session';
import { traceSpan } from '../observability/index.js';
import type { Logger, TraceContext } from '@qqbot/contracts';
import { parseSessionEvent } from './protocol.js';
import type {
  SessionEventNotification,
  SubagentStartedNotification,
  SubagentFinishedNotification,
} from '@qqbot/contracts';

const CORE_EVENTS = [
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'user/message',
  'system/message',
  'request/header',
  'request/context',
  'session/end-seed',
  'llm/retry',
  'llm/retry-started',
] as const satisfies readonly (keyof SessionEventMap)[];
const TOKEN_KEYS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const;
interface SessionTrace {
  trace: TraceContext;
  parent?: string;
  seq: number;
  finished: boolean;
  turn?: TraceContext;
  step?: TraceContext;
}
interface ToolTrace {
  trace: TraceContext;
  startedAt: number;
}
export class AgentTraceObserver {
  private readonly sessions = new Map<string, SessionTrace>();
  private readonly calls = new Map<string, ToolTrace>();
  private readonly toolCounts = new Map<string, number>();
  private readonly errors: string[] = [];
  private readonly usage: Record<string, number> = {};
  private closed = false;
  private stats = {
    turns: 0,
    steps: 0,
    tools: 0,
    retries: 0,
    subagents: 0,
    suppressed: 0,
    invalid: 0,
    unknown: 0,
    late: 0,
    duplicate: 0,
    overflow: 0,
    incomplete: false,
  };
  constructor(
    private readonly options: {
      trace: TraceContext;
      logger: Logger;
      isCurrent: () => boolean;
      now?: () => number;
      deferBudgetRelease?: boolean;
    }
  ) {
    const sessionId = options.trace.dshSessionId;
    if (sessionId) this.sessions.set(sessionId, { trace: options.trace, seq: -1, finished: false });
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private current(): boolean {
    if (this.closed || !this.options.isCurrent()) {
      this.stats.late += 1;
      return false;
    }
    return true;
  }
  observe(raw: unknown): boolean {
    if (!this.current()) return false;
    const n = parseSessionEvent(raw);
    if (!n) {
      this.stats.invalid += 1;
      return false;
    }
    const session = this.sessions.get(n.sessionId);
    if (!session || session.finished) {
      this.stats.late += 1;
      return false;
    }
    if (n.event.seq <= session.seq) {
      this.stats.duplicate += 1;
      return false;
    }
    session.seq = n.event.seq;
    this.metadata(n, session);
    return true;
  }
  started(n: SubagentStartedNotification): boolean {
    if (!this.current()) return false;
    const parent = this.sessions.get(n.parentSessionId);
    if (!parent || parent.finished) {
      this.stats.late += 1;
      return false;
    }
    if (this.sessions.has(n.childSessionId)) {
      this.stats.duplicate += 1;
      return false;
    }
    if (this.sessions.size >= 129) {
      this.overflow();
      return false;
    }
    const trace = traceSpan(parent.trace, { dshSessionId: n.childSessionId });
    this.sessions.set(n.childSessionId, {
      trace,
      parent: n.parentSessionId,
      seq: -1,
      finished: false,
    });
    this.recordStarted(trace, n.parentSessionId);
    return true;
  }
  private recordStarted(trace: TraceContext, parentDshSessionId: string): void {
    this.stats.subagents += 1;
    this.options.logger.withTrace(trace).event('agent.started', { parentDshSessionId });
  }
  finished(n: SubagentFinishedNotification): boolean {
    if (!this.current()) return false;
    const session = this.sessions.get(n.childSessionId);
    if (!session || session.parent !== n.parentSessionId) {
      this.stats.late += 1;
      return false;
    }
    if (session.finished) {
      this.stats.duplicate += 1;
      return false;
    }
    session.finished = true;
    this.options.logger.withTrace(session.trace).event('agent.ended', {
      status: n.status,
      parentDshSessionId: n.parentSessionId,
      dshSeq: session.seq >= 0 ? session.seq : undefined,
    });
    if (n.status === 'error') this.failure('subagent-failed');
    return true;
  }
  invalid(): void {
    if (this.current()) this.stats.invalid += 1;
  }
  unknown(): void {
    if (this.current()) this.stats.unknown += 1;
  }
  private metadata(n: SessionEventNotification, session: SessionTrace): void {
    const { type, data, seq } = n.event;
    this.boundaries(type, session);
    const tool = this.tool(type, data, session);
    const trace = tool?.trace ?? session.step ?? session.turn ?? session.trace;
    this.recordCounters(type, data);
    const emitted = this.options.logger.withTrace(trace).event('agent.detail', {
      dshSeq: seq,
      durationMs: type === 'tool/result' && tool ? this.now() - tool.startedAt : undefined,
      eventType: CORE_EVENTS.includes(type as (typeof CORE_EVENTS)[number]) ? type : 'extension',
      turn: number(data.turn),
      step: number(data.step),
      toolClass: type === 'tool/call' ? toolClass(data.name) : undefined,
    });
    if (!emitted) this.stats.suppressed += 1;
  }
  private recordCounters(type: string, data: Record<string, unknown>): void {
    if (type === 'assistant/message') this.tokens(data.usage);
    if (type === 'llm/retry') this.retry(data);
    if (type === 'turn/end' && object(data.reason)?.kind === 'error') this.failure('turn-failed');
    if (!(CORE_EVENTS as readonly string[]).includes(type)) this.stats.unknown += 1;
  }
  private retry(data: Partial<LlmRetryEventData>): void {
    if (typeof data.retry === 'number') this.stats.retries += 1;
  }
  private boundaries(type: string, session: SessionTrace): void {
    if (type === 'turn/start') {
      this.stats.turns += 1;
      session.turn = traceSpan(session.trace);
      session.step = undefined;
    }
    if (type === 'step/start') {
      this.stats.steps += 1;
      session.step = traceSpan(session.turn ?? session.trace);
    }
  }
  private tool(
    type: string,
    data: Record<string, unknown>,
    session: SessionTrace
  ): ToolTrace | undefined {
    if (type === 'tool/call') return this.toolCall(data, session);
    if (type !== 'tool/result') return;
    const { block, id } = toolResultIdentity(data);
    if (typeof id !== 'string') return;
    const key = `${session.trace.dshSessionId}:${id}`;
    const tool = this.calls.get(key);
    this.calls.delete(key);
    if (data.error || block?.isError) this.failure('tool-failed');
    return tool;
  }
  private toolCall(data: Record<string, unknown>, session: SessionTrace): ToolTrace {
    this.stats.tools += 1;
    const category = toolClass(data.name);
    if (this.toolCounts.size < 32 || this.toolCounts.has(category))
      this.toolCounts.set(category, (this.toolCounts.get(category) ?? 0) + 1);
    const trace = traceSpan(session.step ?? session.turn ?? session.trace);
    const tool = { trace, startedAt: this.now() };
    if (typeof data.callId !== 'string') return tool;
    if (this.calls.size >= 256) {
      this.overflow();
      return tool;
    }
    this.calls.set(`${session.trace.dshSessionId}:${data.callId}`, tool);
    return tool;
  }
  private tokens(raw: unknown): void {
    const usage = object(raw);
    if (!usage) return;
    for (const key of TOKEN_KEYS) {
      const value = number(usage[key]);
      if (value !== undefined) this.usage[key] = (this.usage[key] ?? 0) + value;
    }
  }
  private failure(classification: string): void {
    if (this.errors.length < 8 && !this.errors.includes(classification))
      this.errors.push(classification);
  }
  private overflow(): void {
    this.stats.overflow += 1;
    this.stats.incomplete = true;
  }
  snapshot() {
    return readonlySnapshot({
      ...this.stats,
      sessions: this.sessions.size,
      pendingTools: this.calls.size,
      toolCategories: this.toolCounts.size,
      errorExamples: this.errors.length,
      usage: { ...this.usage },
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stats.incomplete ||= this.calls.size > 0;
    this.options.logger.withTrace(this.options.trace).event('agent.summary', {
      dshSeq: this.sessions.get(this.options.trace.dshSessionId ?? '')?.seq,
      ...this.stats,
      usage: this.usage,
      toolCounts: Object.fromEntries(this.toolCounts),
      errors: this.errors,
    });
    if (!this.options.deferBudgetRelease)
      this.options.logger
        .withTrace(this.options.trace)
        .finishExecution(this.options.trace.executionId ?? '');
    this.sessions.clear();
    this.calls.clear();
    this.toolCounts.clear();
    this.errors.length = 0;
  }
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function toolClass(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  if (/query_tasks|cancel_task/.test(value)) return 'control';
  if (/agent|delegate/.test(value)) return 'subagent';
  if (/shell|bash|exec|command/.test(value)) return 'shell';
  if (/web|fetch|http|search/.test(value)) return 'network';
  if (/file|read|write|edit|patch|directory/.test(value)) return 'filesystem';
  return 'other';
}

function toolResultIdentity(data: Record<string, unknown>) {
  const message = object(data.message);
  const source = object(message?.source);
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const block = blocks.map(object).find((b) => typeof b?.toolCallId === 'string');
  const id = block?.toolCallId;
  return { block, id: source?.callId !== undefined && source.callId !== id ? undefined : id };
}
