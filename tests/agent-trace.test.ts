import { describe, expect, it } from 'vitest';
import { AgentTraceObserver } from '../src/dsh/agent-trace.js';
import { createLogger, createTrace } from '../src/logger.js';
import { parseSessionEvent } from '../src/dsh/protocol.js';

function harness() {
  const lines: string[] = [];
  const trace = createTrace({
    sessionKey: 'session',
    taskId: 'task',
    lane: 'slow',
    executionId: 'execution',
    runtimeGeneration: 'generation',
    dshSessionId: 'root',
  });
  const logger = createLogger({
    sink: (line) => {
      lines.push(line);
    },
    autoTick: false,
    settings: { diagnosticTraceIds: [trace.traceId] },
  });
  let current = true;
  const observer = new AgentTraceObserver({ trace, logger, isCurrent: () => current });
  const event = (
    sessionId: string,
    seq: number,
    type: string,
    data: Record<string, unknown> = {}
  ) => observer.observe({ sessionId, event: { seq, type, data } });
  const started = (parentSessionId: string, childSessionId: string) =>
    observer.started({ parentSessionId, childSessionId });
  const finished = (parentSessionId: string, childSessionId: string) =>
    observer.finished({
      parentSessionId,
      childSessionId,
      provider: 'dsh',
      agentId: childSessionId,
      status: 'ok',
      stopReason: 'completed',
    });
  return {
    trace,
    logger,
    observer,
    event,
    started,
    finished,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    lines,
    current: (value: boolean) => {
      current = value;
    },
  };
}

describe('实时 DSH 追踪观察器', () => {
  it('执行身份优先于独立会话水位；子会话首序号可大于零，父子/后代关联正确', () => {
    const h = harness();
    expect(h.started('root', 'child')).toBe(true);
    expect(h.started('child', 'grandchild')).toBe(true);
    expect(h.event('child', 200, 'step/start', { turn: 1, step: 1 })).toBe(true);
    expect(h.event('grandchild', 300, 'step/start', { turn: 1, step: 1 })).toBe(true);
    expect(h.event('root', 1, 'step/start', { turn: 1, step: 1 })).toBe(true);
    expect(h.event('child', 200, 'step/start')).toBe(false);
    expect(h.event('child', 199, 'step/start')).toBe(false);
    h.current(false);
    expect(h.event('root', 999, 'step/start')).toBe(false);
    h.current(true);
    expect(h.event('root', 2, 'step/end')).toBe(true);
    const started = h.records().filter((r) => r.event === 'agent.started');
    expect(started[0]).toMatchObject({
      traceId: h.trace.traceId,
      parentSpanId: h.trace.spanId,
      dshSessionId: 'child',
    });
    expect(started[1]).toMatchObject({
      parentSpanId: started[0]!.spanId,
      dshSessionId: 'grandchild',
    });
    expect(h.observer.snapshot()).toMatchObject({ steps: 3, subagents: 2, duplicate: 2, late: 1 });
    h.observer.close();
  });

  it('重复与错配子代理通知不重复终态，结束释放全部追踪缓存', () => {
    const h = harness();
    h.started('root', 'child');
    expect(h.started('root', 'child')).toBe(false);
    expect(h.finished('other', 'child')).toBe(false);
    expect(h.finished('root', 'child')).toBe(true);
    expect(h.finished('root', 'child')).toBe(false);
    expect(h.started('root', 'child')).toBe(false);
    expect(h.event('child', 100, 'step/start')).toBe(false);
    h.observer.close();
    h.observer.close();
    expect(h.records().filter((r) => r.event === 'agent.ended')).toHaveLength(1);
    expect(h.records().filter((r) => r.event === 'agent.summary')).toHaveLength(1);
    expect(h.observer.snapshot()).toMatchObject({
      sessions: 0,
      pendingTools: 0,
      toolCategories: 0,
      errorExamples: 0,
    });
  });

  it('复用 DSH token/retry 和 tool/result 类型，配对调用不保存工具内容', () => {
    const h = harness();
    h.event('root', 0, 'turn/start', { turn: 1 });
    h.event('root', 1, 'step/start', { turn: 1, step: 1 });
    h.event('root', 2, 'tool/call', { callId: 'call', name: 'read_file', arguments: 'TOOL_ARGS' });
    h.event('root', 3, 'tool/result', {
      message: { content: [{ callId: 'call', isError: true, content: 'TOOL_RESULT' }] },
    });
    h.event('root', 4, 'assistant/message', {
      usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60, reasoningTokens: 5 },
      message: { content: [{ text: 'ASSISTANT_BODY' }] },
    });
    h.event('root', 5, 'assistant/attempt');
    h.event('root', 6, 'llm/retry', { retry: 1 });
    h.event('root', 7, 'llm/retry-started', { retry: 1 });
    expect(h.observer.snapshot()).toMatchObject({
      turns: 1,
      steps: 1,
      tools: 1,
      pendingTools: 0,
      retries: 1,
      usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60, reasoningTokens: 5 },
    });
    h.observer.close();
    expect(h.lines.join('')).not.toMatch(/TOOL_ARGS|TOOL_RESULT|ASSISTANT_BODY/);
    expect(h.records().find((r) => r.event === 'agent.summary')).toMatchObject({
      errors: ['tool-failed'],
      usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
    });
  });

  it('十万事件与子代理/工具洪峰下所有缓存有界，超额标记汇总不完整', () => {
    const h = harness();
    for (let i = 0; i < 1000; i++) h.started('root', `child-${i}`);
    for (let i = 0; i < 100000; i++)
      h.event('root', i, 'tool/call', {
        callId: `call-${i}`,
        name: `tool-${i}`,
        arguments: 'PRIVATE_ARGS',
      });
    expect(h.observer.snapshot()).toMatchObject({
      sessions: 129,
      pendingTools: 256,
      tools: 100000,
      incomplete: true,
    });
    expect(h.observer.snapshot().toolCategories).toBeLessThanOrEqual(32);
    expect(h.observer.snapshot().errorExamples).toBeLessThanOrEqual(8);
    h.observer.close();
    expect(h.lines.length).toBeLessThanOrEqual(231);
    expect(h.lines.every((line) => Buffer.byteLength(line) + 1 <= 8192)).toBe(true);
    expect(h.lines.join('')).not.toContain('PRIVATE_ARGS');
  });

  it('非法、未知与迟到事件只计数，非法通知不能污染序号水位', () => {
    const h = harness();
    expect(
      h.observer.observe({ sessionId: 'root', event: { seq: 999, type: 'step/start', data: null } })
    ).toBe(false);
    expect(h.event('root', 1, 'unregistered-event')).toBe(true);
    expect(h.event('unrelated', 9999, 'step/start')).toBe(false);
    expect(h.event('root', 2, 'step/start')).toBe(true);
    expect(h.observer.snapshot()).toMatchObject({ invalid: 1, unknown: 1, late: 1, steps: 1 });
    h.observer.close();
  });

  it.each([
    null,
    [],
    1,
    {},
    { sessionId: 's', event: null },
    { sessionId: 's', event: { seq: -1, type: 'x', data: {} } },
    { sessionId: 's', event: { seq: 1.5, type: 'x', data: {} } },
    { sessionId: 's', event: { seq: 1, type: '', data: {} } },
  ])('通知形状校验拒绝 %j', (raw) => {
    expect(parseSessionEvent(raw)).toBeUndefined();
  });
});
