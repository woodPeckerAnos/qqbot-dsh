import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDshRuntime } from '../src/runtime/index.js';
import { createLogger, createTrace } from '../src/observability/index.js';
import { JsonRpcRequestTimeoutError, LoggedError } from '@qqbot/contracts';

function harness(
  options: {
    failInitialize?: boolean;
    ignoreInitialize?: boolean;
    ignoreTerm?: boolean;
    ignoreShutdown?: boolean;
    onSpawn?: () => void;
    onInitialize?: () => void;
  } = {}
) {
  const calls: string[] = [];
  const logs: {
    event: string;
    errorId?: string;
    errorClass?: string;
    taskId?: string;
    lane?: string;
  }[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: undefined as unknown as Writable,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    pid: 888,
    kill: (signal: NodeJS.Signals) => {
      calls.push(signal);
      if (signal === 'SIGTERM' && options.ignoreTerm) return true;
      child.signalCode = signal;
      child.emit('exit', null, signal);
      return true;
    },
  });
  child.stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const frame = JSON.parse(chunk.toString()) as { id: number; method: string };
      calls.push(frame.method);
      if (frame.method === 'initialize' && options.ignoreInitialize) {
        callback();
        return;
      }
      const error = options.failInitialize && frame.method === 'initialize';
      const result =
        frame.method === 'initialize'
          ? { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'mock' } }
          : {};
      child.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          ...(error
            ? {
                error: {
                  code: -32603,
                  message:
                    'provider "arc-code" model "ark-code-latest" does not support reasoning effort "off"',
                },
              }
            : { result }),
        }) + '\n'
      );
      if (frame.method === 'initialize') options.onInitialize?.();
      callback();
      if (frame.method === 'shutdown' && !options.ignoreShutdown) {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      }
    },
  });
  const logger = createLogger({
    autoTick: false,
    sink: (line) => {
      const log = JSON.parse(line);
      logs.push(log);
      if (log.event === 'root.error') calls.push('root.error');
    },
  });
  const spawnImpl = vi.fn(() => {
    options.onSpawn?.();
    return child;
  });
  const runtime = createDshRuntime({
    bin: 'mock',
    profilePatch: 'none',
    cwd: '/tmp',
    dshHome: '/tmp',
    provider: 'arc-code',
    model: 'ark-code-latest',
    reasoningEffort: 'off',
    startTimeoutMs: 1000,
    shutdownTimeoutMs: 15_000,
    logger: logger.withTrace(createTrace({ taskId: 'test-task', lane: 'fast' })),
    spawnImpl: spawnImpl as unknown as typeof spawn,
  });
  return { runtime, calls, logs, child, spawnImpl };
}

afterEach(() => vi.useRealTimers());

describe('DSH 初始化失败回收', () => {
  it('启动前已取消时不启动进程，也不留下计时器', async () => {
    vi.useFakeTimers();
    const { runtime, calls, spawnImpl } = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.start(controller.signal)).rejects.toBe(controller.signal.reason);
    expect(controller.signal.reason).toMatchObject({ name: 'AbortError' });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await runtime.dispose();
    expect(runtime.state).toBe('closed');
  });

  it('spawn 期间取消时不发送 initialize，先记根因再回收进程', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error('启动取消');
    const { runtime, calls, child } = harness({
      onSpawn: () => {
        controller.abort(reason);
      },
    });
    const error = await runtime.start(controller.signal).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LoggedError);
    expect((error as Error).cause).toBe(reason);
    expect(calls).toEqual(['root.error', 'SIGTERM']);
    expect(runtime.state).toBe('closed');
    expect(runtime.serverInfo).toBeUndefined();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stdin.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('等待 initialize 时取消，及时移除握手请求并回收进程', async () => {
    vi.useFakeTimers();
    const { runtime, calls, logs, child } = harness({ ignoreInitialize: true });
    const controller = new AbortController();
    const starting = runtime.start(controller.signal).catch((value: unknown) => value);
    expect(calls).toEqual(['initialize']);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    controller.abort();
    const error = await starting;
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toBeInstanceOf(LoggedError);
    expect((error as Error).cause).toBe(controller.signal.reason);
    expect(calls).toEqual(['initialize', 'root.error', 'SIGTERM']);
    expect(logs.filter((log) => log.event === 'root.error')).toHaveLength(1);
    expect(runtime.state).toBe('closed');
    expect(runtime.serverInfo).toBeUndefined();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    for (const event of ['data', 'end', 'error']) expect(child.stdout.listenerCount(event)).toBe(0);
    expect(child.stdin.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('握手回执收到后、标记 ready 前取消，仍按未就绪进程回收', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error('服务停止');
    const { runtime, calls, logs } = harness({
      onInitialize: () => {
        controller.abort(reason);
      },
    });
    const error = await runtime.start(controller.signal).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LoggedError);
    expect((error as Error).cause).toBe(reason);
    expect(calls).toEqual(['initialize', 'root.error', 'SIGTERM']);
    expect(logs.some((log) => log.event === 'runtime.ready')).toBe(false);
    expect(runtime.state).toBe('closed');
    expect(runtime.serverInfo).toBeUndefined();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('初始化取消后忽略 SIGTERM，等待原宽限再 SIGKILL', async () => {
    vi.useFakeTimers();
    const { runtime, calls } = harness({ ignoreInitialize: true, ignoreTerm: true });
    const controller = new AbortController();
    const starting = runtime.start(controller.signal).catch((value: unknown) => value);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['initialize', 'root.error', 'SIGTERM']);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    const error = await starting;
    expect(error).toBeInstanceOf(LoggedError);
    expect((error as Error).cause).toBe(controller.signal.reason);
    expect(calls).toEqual(['initialize', 'root.error', 'SIGTERM', 'SIGKILL']);
    expect(runtime.state).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('初始化超时保留类型化原因，并清理取消监听和进程', async () => {
    vi.useFakeTimers();
    const { runtime, calls } = harness({ ignoreInitialize: true });
    const controller = new AbortController();
    const starting = runtime.start(controller.signal).catch((value: unknown) => value);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await starting;
    expect(error).toBeInstanceOf(LoggedError);
    expect((error as Error).cause).toBeInstanceOf(JsonRpcRequestTimeoutError);
    expect((error as Error).cause).toMatchObject({ method: 'initialize', timeoutMs: 1_000 });
    expect(calls).toEqual(['initialize', 'root.error', 'SIGTERM']);
    expect(runtime.state).toBe('closed');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('初始化成功后移除启动取消监听，随后取消不改变 ready 状态', async () => {
    vi.useFakeTimers();
    const { runtime, calls } = harness();
    const controller = new AbortController();
    await runtime.start(controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    controller.abort();
    expect(runtime.state).toBe('ready');
    await runtime.dispose();
    expect(calls).toEqual(['initialize', 'shutdown']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('initialize -32603 先记录根因、立即 SIGTERM，不等初始 15 秒，也不误发 SIGKILL', async () => {
    vi.useFakeTimers();
    const { runtime, calls, logs, child } = harness({ failInitialize: true });
    const error = await runtime.start().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LoggedError);
    expect((error as Error).cause).toMatchObject({ code: -32603 });
    expect(calls).toEqual(['initialize', 'root.error', 'SIGTERM']);
    expect(child.exitCode).toBeNull();
    expect(runtime.state).toBe('closed');
    expect(logs.filter((record) => record.event === 'root.error')).toEqual([
      expect.objectContaining({
        errorId: runtime.lastErrorId,
        errorClass: 'runtime-initialize',
        taskId: 'test-task',
        lane: 'fast',
      }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
    await Promise.all([runtime.dispose(), runtime.dispose()]);
    expect(calls).toEqual(['initialize', 'root.error', 'SIGTERM']);
  });

  it('initialize 失败时进程已退出，仍清理协议的流监听', async () => {
    vi.useFakeTimers();
    const { runtime, calls, child } = harness({
      failInitialize: true,
      onInitialize: () => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      },
    });
    await expect(runtime.start()).rejects.toBeInstanceOf(LoggedError);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['initialize', 'root.error']);
    expect(runtime.state).toBe('closed');
    for (const event of ['data', 'end', 'error']) expect(child.stdout.listenerCount(event)).toBe(0);
    expect(child.stdin.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('未就绪进程忽略 SIGTERM 时只等待一次信号宽限，再升级 SIGKILL', async () => {
    vi.useFakeTimers();
    const { runtime, calls } = harness({ failInitialize: true, ignoreTerm: true });
    const starting = runtime.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['initialize', 'root.error', 'SIGTERM']);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(calls).not.toContain('SIGKILL');
    await vi.advanceTimersByTimeAsync(1);
    expect(await starting).toBeInstanceOf(LoggedError);
    expect(calls).toEqual(['initialize', 'root.error', 'SIGTERM', 'SIGKILL']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('就绪后仍先 shutdown；成功退出无信号', async () => {
    const { runtime, calls } = harness();
    await runtime.start();
    await runtime.dispose();
    expect(calls).toEqual(['initialize', 'shutdown']);
    expect(runtime.state).toBe('closed');
  });

  it('就绪后 shutdown 回执未退出，保留退出宽限并正确识别 SIGTERM 退出', async () => {
    vi.useFakeTimers();
    const { runtime, calls } = harness({ ignoreShutdown: true });
    await runtime.start();
    const closing = runtime.dispose();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(calls).toEqual(['initialize', 'shutdown']);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(calls).toEqual(['initialize', 'shutdown', 'SIGTERM']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
