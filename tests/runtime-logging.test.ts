import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DshRuntime } from '../src/dsh/process.js';
import { createLogger, createTrace } from '../src/logger.js';

function processMock() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: undefined as unknown as Writable,
    exitCode: null as number | null,
    pid: 777,
  });
  child.stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const frame = JSON.parse(chunk.toString()) as { id: number; method: string };
      const result =
        frame.method === 'initialize'
          ? { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'mock' } }
          : {};
      child.stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`);
      callback();
      if (frame.method === 'shutdown') {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      }
    },
  });
  return child;
}

describe('DSH runtime 日志元数据', () => {
  it('十万行 stderr、畸形通知和协议帧只产生有界元数据，不泄露原内容或密钥', async () => {
    const child = processMock();
    const lines: string[] = [];
    let now = 0;
    const logger = createLogger({
      now: () => now,
      autoTick: false,
      level: 'debug',
      sink: (line) => {
        lines.push(line);
      },
    });
    const runtime = new DshRuntime({
      bin: 'mock',
      profilePatch: 'none',
      cwd: '/tmp',
      dshHome: '/tmp',
      provider: 'mock',
      model: 'mock',
      startTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      logger: logger.withTrace(
        createTrace({
          sessionKey: 'session',
          executionId: 'execution',
          runtimeGeneration: 'runtime',
        })
      ),
      spawnImpl: (() => child) as unknown as typeof spawn,
    });
    await runtime.start();
    for (let i = 0; i < 100000; i++) child.stderr.write('STDERR_CONTENT sk-abcdefghijk\n');
    for (let i = 0; i < 1000; i++) child.stdout.write('{"method":"session.event","params":null}\n');
    child.stdout.write('RAW_FRAME_CONTENT sk-abcdefghijk\n');
    now = 60000;
    logger.tick();
    expect(runtime.recentStderr).toHaveLength(80);
    expect(runtime.recentStderr.every((line) => line.length <= 1024)).toBe(true);
    expect(lines.join('')).not.toMatch(/STDERR_CONTENT|RAW_FRAME_CONTENT|abcdefghijk/);
    expect(
      lines.map((line) => JSON.parse(line)).filter((record) => record.event === 'runtime.stderr')
    ).toHaveLength(1);
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(logger.snapshot().deduplicated).toBe(100998);
    const root = lines
      .map((line) => JSON.parse(line))
      .find((record) => record.event === 'root.error');
    expect(root).toMatchObject({
      errorId: runtime.lastErrorId,
      errorClass: 'protocol-violation',
      runtimeGeneration: 'runtime',
    });
    child.exitCode = 1;
    child.emit('exit', 1, null);
    expect(
      lines.map((line) => JSON.parse(line)).filter((record) => record.event === 'root.error')
    ).toHaveLength(1);
    expect(runtime.lastErrorId).toBe(root.errorId);
    await runtime.dispose();
  });
});
