import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  createTrace,
  traceSpan,
  LoggedError,
  type LogTransport,
} from '../src/logger.js';
import { installLoggingReload } from '../src/logging/reload.js';
import { parseConfigFileText } from '../src/config-file.js';
import { resolveLoggingSettings } from '../src/config.js';

function capture(settings = {}) {
  const lines: string[] = [];
  let now = 0;
  let id = 0;
  const logger = createLogger({
    settings,
    sink: (line) => {
      lines.push(line);
    },
    now: () => now,
    id: () => `id-${++id}`,
    autoTick: false,
  });
  return {
    logger,
    lines,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    advance: (ms: number) => {
      now += ms;
      logger.tick();
    },
  };
}
const trace = createTrace({
  sessionKey: 'session',
  taskId: 'task',
  lane: 'slow',
  executionId: 'execution',
  dshSessionId: 'dsh',
});

describe('核心 Logger 契约', () => {
  it('共享配置与计数；调用字段不能覆盖身份、固定文案或事件白名单', () => {
    const h = capture();
    const child = h.logger.child({ component: 'caller' }).withTrace(trace);
    child.info('兼容日志', {
      level: 'error',
      time: -1,
      instanceId: 'forged',
      traceId: 'forged',
      spanId: 'forged',
      component: 'forged',
    });
    child.event('execution.ended', {
      resultKind: 'reply',
      event: 'forged',
      msg: 'forged',
      body: 'secret-body',
    });
    h.logger.configure({ level: 'error' });
    child.info('filtered');
    child.error('保留');
    const records = h.records();
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      level: 'info',
      time: 0,
      instanceId: 'id-1',
      traceId: trace.traceId,
      spanId: trace.spanId,
      component: 'caller',
    });
    expect(records[1]).toMatchObject({
      event: 'execution.ended',
      component: 'agent',
      msg: 'DSH 执行结束',
      resultKind: 'reply',
    });
    expect(h.lines.join('')).not.toContain('secret-body');
    expect(h.logger.snapshot().emitted).toBe(3);
  });

  it('全局 debug 仍不打开 agent 明细；目标局部 debug、自动到期与重载额度保持', () => {
    const h = capture({ level: 'debug', agentDetailLimit: 3, dedupeWindowMs: 1000 });
    const scoped = h.logger.withTrace(trace);
    scoped.event('agent.detail', { eventType: 'step/start', dshSeq: 0 });
    expect(h.lines).toHaveLength(0);
    h.logger.configure({
      level: 'warn',
      diagnosticTraceIds: [trace.traceId],
      diagnosticTtlMs: 2000,
    });
    for (let i = 1; i <= 2; i++)
      scoped.event('agent.detail', { eventType: `type-${i}`, dshSeq: i });
    h.logger.configure({ diagnosticTraceIds: [trace.traceId] });
    for (let i = 3; i <= 5; i++)
      scoped.event('agent.detail', { eventType: `type-${i}`, dshSeq: i });
    expect(h.records().filter((r) => r.event === 'agent.detail')).toHaveLength(3);
    h.advance(2001);
    expect(h.logger.snapshot().diagnostics.active).toBe(false);
    scoped.debug('到期后隐藏');
    expect(h.lines.join('')).not.toContain('到期后隐藏');
  });

  it('十万条 agent/stderr 诊断有界、定向额度父子共享、每分钟输出分类抑制统计', () => {
    const h = capture({ diagnosticSessionKeys: ['session'], level: 'debug' });
    const parent = h.logger.withTrace(trace);
    const child = h.logger.withTrace(traceSpan(trace, { dshSessionId: 'child' }));
    const stdout = vi.spyOn(process.stdout, 'write');
    for (let i = 0; i < 100000; i++) {
      (i % 2 ? parent : child).event('agent.detail', {
        eventType: `event-${i}`,
        dshSeq: i,
        body: 'MODEL_BODY',
      });
      parent.event('runtime.stderr', { bytes: 50, lines: 1, line: 'STDERR_BODY' });
    }
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
    h.advance(60000);
    parent.finishExecution('execution');
    expect(h.records().findLast((r) => r.event === 'logging.suppressed')).toMatchObject({
      executionId: 'execution',
      counts: { agent: 99900, runtime: 99999 },
    });
    expect(h.records().filter((r) => r.event === 'agent.detail')).toHaveLength(100);
    expect(h.records().filter((r) => r.event === 'runtime.stderr')).toHaveLength(1);
    expect(h.lines.length).toBeLessThanOrEqual(103);
    expect(h.logger.snapshot()).toMatchObject({ deduplicated: 99999, dropped: 0, queuedBytes: 0 });
    expect(h.lines.every((line) => Buffer.byteLength(line) + 1 <= 8192)).toBe(true);
    expect(h.lines.join('')).not.toMatch(/MODEL_BODY|STDERR_BODY/);
  });

  it('重复诊断首次记录，其余聚合；关键终态和同类首次根因不采样', () => {
    const h = capture({ level: 'debug' });
    for (let i = 0; i < 10; i++) h.logger.debug('固定诊断');
    for (let i = 0; i < 3; i++)
      h.logger.withTrace(trace).event('task.terminal', { status: 'completed' });
    const error = new Error('工具输出正文 sk-abcdefghijk');
    const id = h.logger.cause(error, 'protocol-failed');
    expect(h.logger.withTrace(trace).cause(error, 'upper-layer')).toBe(id);
    expect(h.logger.cause(new LoggedError(id, 'wrapper'))).toBe(id);
    expect(h.records().filter((r) => r.event === 'root.error')).toHaveLength(1);
    expect(h.records().filter((r) => r.event === 'task.terminal')).toHaveLength(3);
    expect(h.logger.snapshot().deduplicated).toBe(9);
    expect(h.lines.join('')).not.toContain('工具输出正文');
    h.logger.event('input.shortcut', { stage: 'dedupe', reason: 'duplicate-event' });
    h.logger.event('input.shortcut', { stage: 'dedupe', reason: 'duplicate-event' });
    h.advance(60000);
    expect(h.records().findLast((r) => r.event === 'logging.suppressed')).toMatchObject({
      counts: { input: 1, legacy: 9 },
    });
  });

  it('背压缓冲有界，优先丢诊断并保留终态；写完成和 drain 均满足后才继续', async () => {
    const emitter = new EventEmitter();
    const written: string[] = [];
    let done: ((error?: Error | null) => void) | undefined;
    const transport: LogTransport = {
      write: (line, callback) => {
        written.push(line);
        done = callback;
        return false;
      },
      on: (event, listener) => emitter.on(event, listener),
    };
    const logger = createLogger({
      transport,
      autoTick: false,
      settings: { maxQueuedBytes: 8192, level: 'debug', diagnosticSessionKeys: ['session'] },
    });
    const scoped = logger.withTrace(trace);
    for (let i = 0; i < 100; i++) scoped.event('agent.detail', { eventType: `type-${i}` });
    scoped.event('execution.ended', { resultKind: 'reply' });
    expect(logger.snapshot().queuedBytes).toBeLessThanOrEqual(8192);
    expect(logger.snapshot().dropped).toBeGreaterThan(0);
    expect(written).toHaveLength(1);
    done!();
    expect(written).toHaveLength(1);
    emitter.emit('drain');
    expect(written).toHaveLength(2);
    for (let i = 0; i < 100 && logger.snapshot().queuedBytes; i++) {
      done!();
      emitter.emit('drain');
    }
    expect(await logger.flush(0)).toBe(true);
    expect(written.some((line) => line.includes('execution.ended'))).toBe(true);
  });

  it('断流、同步输出异常、恶意字段与异常 redactor 不向业务抛错', async () => {
    const logger = createLogger({
      autoTick: false,
      sink: () => {
        throw new Error('EPIPE');
      },
    });
    expect(() => {
      logger.error('test');
    }).not.toThrow();
    expect(logger.snapshot()).toMatchObject({ sinkFailures: 1, dropped: 1, queuedBytes: 0 });
    expect(await logger.flush(0)).toBe(true);
    const h = capture();
    const cyclic: Record<string, unknown> = {
      integer: 5n,
      error: new Error('private'),
      toJSON: () => {
        throw new Error('no');
      },
    };
    cyclic.self = cyclic;
    Object.defineProperty(cyclic, 'bad', {
      enumerable: true,
      get: () => {
        throw new Error('no');
      },
    });
    h.logger.info('可序列化', { data: cyclic });
    expect(h.lines[0]).toContain('<circular>');
    expect(h.lines[0]).toContain('"integer":"5"');
    expect(h.lines[0]).not.toContain('private');
    expect(() =>
      h.logger.event(
        'task.terminal',
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('bad');
            },
          }
        )
      )
    ).not.toThrow();
    const broken = createLogger({
      sink: () => {},
      autoTick: false,
      extraRedactor: () => {
        throw new Error('bad');
      },
    });
    expect(() => {
      broken.info('safe');
    }).not.toThrow();
    expect(broken.snapshot().dropped).toBe(1);
  });

  it.each(['callback-first', 'event-first'])(
    '异步断流 %s 只计一次，旧回调不误伤下一条写入',
    async (order) => {
      const source = new EventEmitter();
      const callbacks: ((error?: Error | null) => void)[] = [];
      const logger = createLogger({
        autoTick: false,
        transport: {
          write: (_line, callback) => {
            callbacks.push(callback);
            return false;
          },
          on: (event, listener) => source.on(event, listener),
        },
      });
      logger.info('first');
      logger.info('second');
      const error = new Error('EPIPE');
      if (order === 'callback-first') {
        callbacks[0]!(error);
        source.emit('error', error);
      } else {
        source.emit('error', error);
        callbacks[0]!(error);
      }
      expect(callbacks).toHaveLength(2);
      expect(logger.snapshot()).toMatchObject({ sinkFailures: 1, dropped: 1, emitted: 0 });
      callbacks[1]!();
      source.emit('drain');
      expect(await logger.flush(0)).toBe(true);
      expect(logger.snapshot()).toMatchObject({ sinkFailures: 1, dropped: 1, emitted: 1 });
    }
  );

  it('密钥和业务内容先移除，UTF-8 截断后仍是有界 JSON 与可定位身份', () => {
    const h = capture({ maxRecordBytes: 1024 });
    h.logger.withTrace(trace).info('metadata', {
      raw: 'RAW_BODY',
      preview: 'USER_BODY',
      toolArguments: 'TOOL_ARGS',
      toolResults: 'TOOL_RESULTS',
      authorization: 'Bearer token-token',
      apiKey: 'plain-secret',
      ...Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`metadata-${i}`, '中'.repeat(300)])
      ),
    });
    expect(h.lines[0]).not.toMatch(
      /RAW_BODY|USER_BODY|TOOL_ARGS|TOOL_RESULTS|plain-secret|token-token/
    );
    expect(Buffer.byteLength(h.lines[0]!) + 1).toBeLessThanOrEqual(1024);
    expect(h.records()[0]).toMatchObject({
      traceId: trace.traceId,
      executionId: 'execution',
      dshSessionId: 'dsh',
      truncated: true,
    });
    expect(h.logger.snapshot().truncated).toBe(1);
  });

  it('没有 drain 时 flush 返回有界失败', async () => {
    const logger = createLogger({ autoTick: false, transport: { write: () => false } });
    logger.info('pending');
    expect(await logger.flush(20)).toBe(false);
    expect(logger.snapshot().queuedBytes).toBeGreaterThan(0);
  });
});

describe('日志配置与 SIGHUP', () => {
  it('YAML 预算、目标、QQ_LOG_LEVEL 兼容并执行范围校验', () => {
    const file = parseConfigFileText(
      'logLevel: debug\nlogging:\n  agentDetailLimit: 5\n  diagnosticTraceIds: [a]\n'
    );
    expect(resolveLoggingSettings({}, file)).toMatchObject({ level: 'debug', agentDetailLimit: 5 });
    expect(resolveLoggingSettings({ QQ_LOG_LEVEL: 'warn' }, file).level).toBe('warn');
    expect(() => resolveLoggingSettings({}, { logging: { diagnosticTtlMs: 1800001 } })).toThrow();
    expect(() =>
      resolveLoggingSettings({}, { logging: { diagnosticTraceIds: Array(9).fill('a') } })
    ).toThrow();
  });
  it('SIGHUP 更新共享子 logger；非法更新保留原值，目标到期，解绑后不重载', () => {
    const h = capture();
    const source = new EventEmitter();
    let settings = resolveLoggingSettings(
      {},
      { logLevel: 'debug', logging: { diagnosticTraceIds: [trace.traceId], diagnosticTtlMs: 1000 } }
    );
    const child = h.logger.withTrace(trace);
    const stop = installLoggingReload(source, h.logger, () => settings);
    source.emit('SIGHUP');
    child.debug('active');
    settings = { ...settings, diagnosticTtlMs: 1800001 };
    source.emit('SIGHUP');
    expect(h.records().filter((r) => r.event === 'logging.reload_failed')).toHaveLength(1);
    expect(h.logger.snapshot().diagnostics.active).toBe(true);
    h.advance(1001);
    expect(h.logger.snapshot().diagnostics.active).toBe(false);
    stop();
    source.emit('SIGHUP');
    expect(h.records().filter((r) => r.event === 'logging.reload_failed')).toHaveLength(1);
  });
});
