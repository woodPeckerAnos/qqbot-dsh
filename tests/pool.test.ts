/**
 * runtime 池单测（假 runtime 工厂，全离线）。
 *
 * 池的行为直接决定"群与群之间会不会串味"以及"进程会不会泄漏"，
 * 所以重点测：每群独立、死进程重建、LRU 回收、空闲回收、忙碌时不被强杀。
 */

import { describe, expect, it, vi } from 'vitest';

import { createNullLogger } from '../src/logger.js';
import { stableSessionId, RuntimePool } from '../src/dsh/pool.js';
import type { DshRuntime, DshRuntimeOptions } from '../src/dsh/process.js';

/** 假 runtime：可控制存活状态，记录调用。 */
class FakeRuntime {
  readonly handlers: Record<string, Array<(...args: never[]) => void>> = {};
  ready = true;
  disposeCount = 0;
  startCount = 0;

  constructor(readonly options: DshRuntimeOptions) {}

  get isReady(): boolean {
    return this.ready;
  }

  get pid(): number {
    return 1000 + this.startCount;
  }

  get state(): string {
    return this.ready ? 'ready' : 'failed';
  }

  on(event: string, handler: (...args: never[]) => void): void {
    (this.handlers[event] ??= []).push(handler);
  }

  async start(): Promise<unknown> {
    this.startCount += 1;
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } };
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    this.ready = false;
  }
}

function makePool(options: { maxRuntimes?: number; runtimeIdleMs?: number; now?: () => number } = {}) {
  const created: FakeRuntime[] = [];
  const pool = new RuntimePool({
    maxRuntimes: options.maxRuntimes ?? 4,
    runtimeIdleMs: options.runtimeIdleMs ?? 0,
    base: {
      bin: 'dsh',
      profilePatch: '/patch.yml',
      dshHome: '/data/dsh',
      provider: 'p',
      model: 'm',
      startTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
    },
    logger: createNullLogger(),
    ...(options.now !== undefined ? { now: options.now } : {}),
    runtimeFactory: (runtimeOptions) => {
      const runtime = new FakeRuntime(runtimeOptions);
      created.push(runtime);
      return runtime as unknown as DshRuntime;
    },
  });
  return { pool, created };
}

describe('RuntimePool', () => {
  it('同一群复用同一个 runtime', async () => {
    const { pool, created } = makePool();
    const first = await pool.acquire('GROUP-A', '/ws/a');
    const second = await pool.acquire('GROUP-A', '/ws/a');

    expect(created).toHaveLength(1);
    expect(first.runtime).toBe(second.runtime);
    expect(pool.size).toBe(1);
    await pool.disposeAll();
  });

  it('不同群得到不同 runtime（这是群间隔离的前提）', async () => {
    const { pool, created } = makePool();
    const a = await pool.acquire('GROUP-A', '/ws/a');
    const b = await pool.acquire('GROUP-B', '/ws/b');

    expect(created).toHaveLength(2);
    expect(a.runtime).not.toBe(b.runtime);
    // cwd 必须是各自的工作区
    expect((a.runtime as unknown as FakeRuntime).options.cwd).toBe('/ws/a');
    expect((b.runtime as unknown as FakeRuntime).options.cwd).toBe('/ws/b');
    await pool.disposeAll();
  });

  it('runtime 死掉后自动重建，而不是把坏 runtime 交出去', async () => {
    const { pool, created } = makePool();
    const first = await pool.acquire('GROUP-A', '/ws/a');
    (first.runtime as unknown as FakeRuntime).ready = false;

    const second = await pool.acquire('GROUP-A', '/ws/a');
    expect(created).toHaveLength(2);
    expect(second.runtime).not.toBe(first.runtime);
    expect(second.runtime.isReady).toBe(true);
    // 旧的那个应该被 dispose 过
    expect((first.runtime as unknown as FakeRuntime).disposeCount).toBeGreaterThanOrEqual(1);
    await pool.disposeAll();
  });

  it('会话 id 由 groupKey 稳定推导', async () => {
    const { pool } = makePool();
    const entry = await pool.acquire('GROUP-A', '/ws/a');
    expect(entry.sessionId).toBe(stableSessionId('GROUP-A'));
    expect(entry.replayed).toBe(false);
    await pool.disposeAll();
  });

  it('release 只标记空闲，不立即销毁', async () => {
    const { pool, created } = makePool();
    await pool.acquire('GROUP-A', '/ws/a');
    pool.release('GROUP-A');
    expect(pool.size).toBe(1);
    expect((created[0] as unknown as FakeRuntime).disposeCount).toBe(0);
    await pool.disposeAll();
  });

  it('超过 maxRuntimes 时按 LRU 回收最久未使用的', async () => {
    let nowMs = 1_000;
    const { pool, created } = makePool({ maxRuntimes: 2, now: () => nowMs });

    await pool.acquire('G1', '/ws/1');
    nowMs += 100;
    await pool.acquire('G2', '/ws/2');

    // 三者都空闲；G1 最久未用，应被回收
    nowMs += 100;
    await pool.acquire('G3', '/ws/3');

    expect(pool.size).toBeLessThanOrEqual(2);
    expect(pool.activeGroupKeys()).toContain('G3');
    expect(pool.activeGroupKeys()).not.toContain('G1');
    expect((created[0] as unknown as FakeRuntime).disposeCount).toBe(1);
    await pool.disposeAll();
  });

  it('全部 runtime 都在忙时，不强杀正在干活的（只告警并放行）', async () => {
    const { pool } = makePool({ maxRuntimes: 1 });
    const entry = await pool.acquire('G1', '/ws/1');
    entry.busy = true;

    // 池已满且唯一成员在忙：不应丢弃 G1
    await pool.acquire('G2', '/ws/2');
    expect(pool.activeGroupKeys()).toContain('G1');
    await pool.disposeAll();
  });

  it('空闲回收会关掉超时的 runtime', async () => {
    vi.useFakeTimers();
    try {
      let nowMs = 0;
      const { pool } = makePool({ runtimeIdleMs: 1_000, now: () => nowMs });
      await pool.acquire('G1', '/ws/1');
      pool.release('G1');

      // 触发 reclaim 定时器（间隔 = max(30s, idleMs/2) = 30s）
      nowMs += 60_000;
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();

      expect(pool.size).toBe(0);
      await pool.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('busy 的 runtime 不会被空闲回收', async () => {
    vi.useFakeTimers();
    try {
      let nowMs = 0;
      const { pool } = makePool({ runtimeIdleMs: 1_000, now: () => nowMs });
      const entry = await pool.acquire('G1', '/ws/1');
      entry.busy = true;

      nowMs += 60_000;
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();

      expect(pool.size).toBe(1);
      await pool.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposeAll 关掉全部 runtime 并拒绝新的 acquire', async () => {
    const { pool, created } = makePool();
    await pool.acquire('G1', '/ws/1');
    await pool.acquire('G2', '/ws/2');
    await pool.disposeAll();

    expect(pool.size).toBe(0);
    for (const runtime of created) expect(runtime.disposeCount).toBe(1);
    await expect(pool.acquire('G3', '/ws/3')).rejects.toThrow(/已关闭/);
  });

  it('runtime 退出事件会向上冒泡（供健康检查与日志）', async () => {
    const { pool } = makePool();
    const onExit = vi.fn();
    pool.on('runtime.exit', onExit);
    const entry = await pool.acquire('G1', '/ws/1');

    const handlers = (entry.runtime as unknown as FakeRuntime).handlers['exit'] ?? [];
    for (const handler of handlers) (handler as unknown as (c: number, s: string) => void)(1, 'SIGTERM');

    expect(onExit).toHaveBeenCalledWith('G1', 1, 'SIGTERM');
    await pool.disposeAll();
  });
});
