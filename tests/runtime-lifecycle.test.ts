import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDshRuntime } from '../src/runtime/index.js';
import { createLogger, createTrace } from '../src/observability/index.js';
import { LoggedError } from '@qqbot/contracts';

function harness(
  options: { failInitialize?: boolean; ignoreTerm?: boolean; ignoreShutdown?: boolean } = {}
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
    spawnImpl: (() => child) as unknown as typeof spawn,
  });
  return { runtime, calls, logs, child };
}

afterEach(() => vi.useRealTimers());

describe('DSH 初始化失败回收', () => {
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
