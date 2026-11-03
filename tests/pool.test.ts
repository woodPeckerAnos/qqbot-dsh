/**
 * runtime 池单测（假 runtime 工厂，全离线）。
 *
 * 池的行为直接决定"会话与会话之间会不会串味"以及"进程会不会泄漏"，
 * 所以重点测：每会话独立、死进程重建、LRU 回收、空闲回收、忙碌时不被强杀。
 */

/**
 * runtime 池单测（假 runtime 工厂，全离线）。
 *
 * 池的行为直接决定"会话与会话之间会不会串味"以及"进程会不会泄漏"，
 * 所以重点测：每会话独立、死进程重建、LRU 回收、空闲回收、忙碌时不被强杀。
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

  /** 测试驱动：触发已注册的事件 handler。 */
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers[event] ?? []) {
      (handler as unknown as (...a: unknown[]) => void)(...args);
    }
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

function makePool(
  options: { maxRuntimes?: number; runtimeIdleMs?: number; now?: () => number } = {}
) {
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
  it('租约与协议能力不暴露可写池记录，集合快照隔离且只读', async () => {
    const { pool, created } = makePool();
    const lease = await pool.acquireLease('G1', '/ws/1');
    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.isFrozen(lease.runtime)).toBe(true);
    expect(lease).not.toHaveProperty('busy');
    expect(lease).not.toHaveProperty('activeChildren');
    expect(lease.runtime).not.toHaveProperty('dispose');
    expect(lease.runtime).not.toHaveProperty('start');
    expect(lease.runtime).not.toHaveProperty('emit');
    expect(() => Object.assign(lease, { generation: 'forged' })).toThrow(TypeError);
    created[0]!.emit('subagent.started', { parentSessionId: 'p', childSessionId: 'c' });
    const before = pool.snapshot(lease)!;
    expect(() => (before.activeChildren as string[]).push('forged')).toThrow(TypeError);
    created[0]!.emit('subagent.finished', { parentSessionId: 'p', childSessionId: 'c' });
    expect(before.activeChildren).toEqual(['c']);
    expect(pool.snapshot(lease)!.activeChildren).toEqual([]);
    await pool.disposeAll();
  });
  it('同一进程重新准入也铸新租约；复制身份与旧租约无写入能力', async () => {
    const { pool, created } = makePool();
    const first = await pool.acquireLease('G1', '/ws/1');
    pool.release(first);
    const next = await pool.acquireLease('G1', '/ws/1');
    expect(created).toHaveLength(1);
    expect(next.leaseId).not.toBe(first.leaseId);
    expect(next.generation).toBe(first.generation);
    pool.release(first);
    pool.release({ ...next });
    await pool.drop(first);
    await pool.drop({ ...next });
    expect(pool.snapshot(next)!.busy).toBe(true);
    expect(next.runtime.isReady).toBe(true);
    expect(pool.snapshot(first)).toBeUndefined();
    await pool.disposeAll();
  });
  it('重复关闭等待同一次释放，关闭期间重建不突破进程硬上限', async () => {
    const { pool, created } = makePool({ maxRuntimes: 1 });
    const lease = await pool.acquireLease('G1', '/ws/1');
    let finishDispose!: () => void;
    created[0]!.dispose = () =>
      new Promise<void>((resolve) => {
        finishDispose = () => {
          created[0]!.disposeCount += 1;
          created[0]!.ready = false;
          resolve();
        };
      });
    const closing = pool.drop(lease);
    const duplicate = pool.drop(lease);
    const replacement = pool.acquireLease('G1', '/ws/1');
    await Promise.resolve();
    expect(created).toHaveLength(1);
    finishDispose();
    await Promise.all([closing, duplicate]);
    const next = await replacement;
    expect(created[0]!.disposeCount).toBe(1);
    expect(created).toHaveLength(2);
    expect(next.runtime.isReady).toBe(true);
    expect(pool.size).toBe(1);
    await pool.disposeAll();
  });
  it('初始化失败释放创建中的 runtime，不占硬额度', async () => {
    const { pool, created } = makePool({ maxRuntimes: 1 });
    const originalStart = FakeRuntime.prototype.start;
    FakeRuntime.prototype.start = async () => {
      throw new Error('initialize-failed');
    };
    try {
      await expect(pool.acquireLease('failure', '/workspace')).rejects.toThrow('initialize-failed');
    } finally {
      FakeRuntime.prototype.start = originalStart;
    }
    expect(created[0]!.disposeCount).toBe(1);
    expect(pool.size).toBe(0);
    await pool.acquireLease('next', '/workspace');
    expect(pool.size).toBe(1);
    await pool.disposeAll();
  });
  it('并发租约在返回前已标 busy，满池等待；旧租约不能释放新实例', async () => {
    const { pool, created } = makePool({ maxRuntimes: 2 });
    const [a, b] = await Promise.all([pool.acquireLease('A', '/a'), pool.acquireLease('B', '/b')]);
    expect(pool.snapshot(a)!.busy).toBe(true);
    expect(pool.snapshot(b)!.busy).toBe(true);
    const waiting = pool.acquireLease('C', '/c');
    await Promise.resolve();
    await Promise.resolve();
    expect(created).toHaveLength(2);
    expect(pool.size).toBe(2);
    pool.release(a);
    await waiting;
    expect(pool.size).toBe(2);
    await pool.drop(b);
    const replacement = await pool.acquireLease('B', '/b');
    pool.release(b);
    await pool.drop(b);
    expect(pool.snapshot(replacement)!.busy).toBe(true);
    expect(replacement.runtime.isReady).toBe(true);
    await pool.disposeAll();
  });
  it('取消满池等待不新建进程，也不等待正在执行的任务结束', async () => {
    const { pool, created } = makePool({ maxRuntimes: 1 });
    await pool.acquireLease('A', '/a');
    const controller = new AbortController();
    const waiting = pool.acquireLease('B', '/b', {}, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(waiting).rejects.toThrow();
    expect(created).toHaveLength(1);
    await pool.disposeAll();
  });
  it('同一会话复用同一个 runtime', async () => {
    const { pool, created } = makePool();
    const first = await pool.acquire('GROUP-A', '/ws/a');
    const second = await pool.acquire('GROUP-A', '/ws/a');

    expect(created).toHaveLength(1);
    expect(first.runtime).toBe(second.runtime);
    expect(pool.size).toBe(1);
    await pool.disposeAll();
  });

  it('不同会话得到不同 runtime（这是会话间隔离的前提）', async () => {
    const { pool, created } = makePool();
    const a = await pool.acquire('GROUP-A', '/ws/a');
    const b = await pool.acquire('GROUP-B', '/ws/b');

    expect(created).toHaveLength(2);
    expect(a.runtime).not.toBe(b.runtime);
    // cwd 必须是各自的工作区
    expect(created[0]!.options.cwd).toBe('/ws/a');
    expect(created[1]!.options.cwd).toBe('/ws/b');
    await pool.disposeAll();
  });

  it('runtime 死掉后自动重建，而不是把坏 runtime 交出去', async () => {
    const { pool, created } = makePool();
    const first = await pool.acquire('GROUP-A', '/ws/a');
    created[0]!.ready = false;

    const second = await pool.acquire('GROUP-A', '/ws/a');
    expect(created).toHaveLength(2);
    expect(second.runtime).not.toBe(first.runtime);
    expect(second.runtime.isReady).toBe(true);
    // 旧的那个应该被 dispose 过
    expect(created[0]!.disposeCount).toBeGreaterThanOrEqual(1);
    await pool.disposeAll();
  });

  it('会话 id 由会话键稳定推导', async () => {
    const { pool } = makePool();
    const entry = await pool.acquire('GROUP-A', '/ws/a');
    expect(entry.sessionId).toBe(stableSessionId('GROUP-A'));
    expect(pool.snapshot(entry)!.replayed).toBe(false);
    await pool.disposeAll();
  });

  it('release 只标记空闲，不立即销毁', async () => {
    const { pool, created } = makePool();
    const lease = await pool.acquire('GROUP-A', '/ws/a');
    pool.release(lease);
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
    expect(pool.activeConversationKeys()).toContain('G3');
    expect(pool.activeConversationKeys()).not.toContain('G1');
    expect((created[0] as unknown as FakeRuntime).disposeCount).toBe(1);
    await pool.disposeAll();
  });

  it('全部 runtime 都在忙时等待，始终不突破硬上限', async () => {
    const { pool } = makePool({ maxRuntimes: 1 });
    const entry = await pool.acquireLease('G1', '/ws/1');

    // 池已满且唯一成员在忙：不应丢弃 G1
    const waiting = pool.acquire('G2', '/ws/2');
    await Promise.resolve();
    await Promise.resolve();
    expect(pool.activeConversationKeys()).toContain('G1');
    expect(pool.size).toBe(1);
    pool.release(entry);
    await waiting;
    expect(pool.size).toBe(1);
    await pool.disposeAll();
  });

  it('空闲回收会关掉超时的 runtime', async () => {
    vi.useFakeTimers();
    try {
      let nowMs = 0;
      const { pool } = makePool({ runtimeIdleMs: 1_000, now: () => nowMs });
      const lease = await pool.acquire('G1', '/ws/1');
      pool.release(lease);

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
      await pool.acquireLease('G1', '/ws/1');

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
    const { pool, created } = makePool();
    const onExit = vi.fn();
    pool.on('runtime.exit', onExit);
    await pool.acquire('G1', '/ws/1');

    const handlers = created[0]!.handlers['exit'] ?? [];
    for (const handler of handlers)
      (handler as unknown as (c: number, s: string) => void)(1, 'SIGTERM');

    expect(onExit).toHaveBeenCalledWith('G1', 1, 'SIGTERM');
    await pool.disposeAll();
  });

  // -------------------------------------------------------------------------
  // 后台子代理记账（回收豁免的依据，见 RuntimeEntry.activeChildren）
  // -------------------------------------------------------------------------

  const STARTED = { parentSessionId: 'parent-1', childSessionId: 'child-1' };
  const FINISHED = {
    provider: 'spawn',
    agentId: 'child-1',
    parentSessionId: 'parent-1',
    childSessionId: 'child-1',
    status: 'ok' as const,
    stopReason: 'completed',
  };

  it('subagent.started/finished 维护 activeChildren 并按会话冒泡', async () => {
    const { pool, created } = makePool();
    const onStarted = vi.fn();
    const onFinished = vi.fn();
    pool.on('subagent.started', onStarted);
    pool.on('subagent.finished', onFinished);

    const entry = await pool.acquire('G1', '/ws/1');
    const runtime = created[0]!;

    runtime.emit('subagent.started', STARTED);
    expect(pool.snapshot(entry)!.activeChildren).toEqual(['child-1']);
    expect(onStarted).toHaveBeenCalledWith('G1', STARTED);

    // 重复 started 幂等（Set 语义），finished 后清零
    runtime.emit('subagent.started', STARTED);
    expect(pool.snapshot(entry)!.activeChildren.length).toBe(1);
    runtime.emit('subagent.finished', FINISHED);
    expect(pool.snapshot(entry)!.activeChildren.length).toBe(0);
    expect(onFinished).toHaveBeenCalledWith('G1', FINISHED);

    // 未知子代理的 finished 不会把计数打成负数
    runtime.emit('subagent.finished', { ...FINISHED, childSessionId: 'child-unknown' });
    expect(pool.snapshot(entry)!.activeChildren.length).toBe(0);
    await pool.disposeAll();
  });

  it('承载后台子代理的 runtime 不会被空闲回收（回收 = 静默杀任务）', async () => {
    vi.useFakeTimers();
    try {
      let nowMs = 0;
      const { pool, created } = makePool({ runtimeIdleMs: 1_000, now: () => nowMs });
      const entry = await pool.acquire('G1', '/ws/1');
      pool.release(entry);
      created[0]!.emit('subagent.started', STARTED);

      nowMs += 60_000;
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();

      expect(pool.size).toBe(1);

      // 子代理结束后恢复可回收
      created[0]!.emit('subagent.finished', FINISHED);
      nowMs += 60_000;
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
      expect(pool.size).toBe(0);
      await pool.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('LRU 回收跳过承载后台子代理的 runtime', async () => {
    const { pool, created } = makePool({ maxRuntimes: 1 });
    const g1 = await pool.acquire('G1', '/ws/1');
    created[0]!.emit('subagent.started', STARTED);

    // 池已满且唯一成员承载后台任务：与 busy 同样豁免，不强杀
    const waiting = pool.acquire('G2', '/ws/2');
    await Promise.resolve();
    await Promise.resolve();
    expect(pool.activeConversationKeys()).toContain('G1');
    expect((created[0] as unknown as FakeRuntime).disposeCount).toBe(0);
    created[0]!.emit('subagent.finished', FINISHED);
    pool.release(g1);
    await waiting;
    expect(pool.size).toBe(1);
    await pool.disposeAll();
  });
});
