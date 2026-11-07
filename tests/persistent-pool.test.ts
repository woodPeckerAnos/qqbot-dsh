import { describe, expect, it, vi } from 'vitest';
import { createRuntimePoolV2, createRuntimeExecutionGate } from '../src/runtime/index.js';
import { createNullLogger } from '../src/observability/index.js';
import { MockDshRuntime } from './helpers/task-mocks.js';
import type { RuntimePoolOptionsV2 } from '@qqbot/contracts';

function fixture(extra: Partial<RuntimePoolOptionsV2> = {}) {
  const runtimes: MockDshRuntime[] = [];
  const pool = createRuntimePoolV2({
    maxRuntimes: 4,
    runtimeIdleMs: 1,
    logger: createNullLogger(),
    base: {
      bin: 'mock',
      profilePatch: 'mock',
      dshHome: '/tmp',
      provider: 'mock',
      model: 'mock',
      startTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
    },
    runtimeFactory: (options) => {
      const runtime = new MockDshRuntime(options);
      runtimes.push(runtime);
      return runtime.asRuntime();
    },
    ...extra,
  });
  return { pool, runtimes };
}
describe('常驻 lane 资源契约', () => {
  it('驻留超过并发限制，无 LRU；新租约复用会话并撤销旧写能力', async () => {
    const { pool, runtimes } = fixture();
    try {
      const first = await pool.acquireLease('a:fast', '/tmp/a');
      pool.markReplayed(first);
      pool.release(first);
      for (let i = 0; i < 8; i++) {
        const lease = await pool.acquireLease(`s${i}:fast`, `/tmp/s${i}`);
        pool.release(lease);
      }
      const next = await pool.acquireLease('a:fast', '/tmp/a');
      expect(pool.size).toBe(9);
      expect(next.sessionId).toBe(first.sessionId);
      expect(next.generation).toBe(first.generation);
      expect(next.leaseId).not.toBe(first.leaseId);
      expect(next.replayed).toBe(true);
      expect(runtimes.every((r) => r.disposed === 0)).toBe(true);
      expect(() => first.runtime.prompt(first.sessionId, [])).toThrow('失效');
      pool.release(first);
      await pool.drop(first);
      expect(pool.snapshot(next)?.busy).toBe(true);
      pool.release(next);
    } finally {
      await pool.disposeAll();
    }
  });
  it('四项并发及共享总额度，取消排队不释放别人的名额', async () => {
    const total = createRuntimeExecutionGate(2);
    const a = fixture({ executionGate: total }),
      b = fixture({ executionGate: total });
    try {
      const one = await a.pool.acquireLease('one', '/tmp/one');
      const two = await b.pool.acquireLease('two', '/tmp/two');
      let admitted = false;
      const controller = new AbortController();
      const cancelled = a.pool.acquireLease('cancelled', '/tmp/cancelled', {}, controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toThrow();
      const waiting = a.pool.acquireLease('three', '/tmp/three').then((lease) => {
        admitted = true;
        return lease;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(admitted).toBe(false);
      a.pool.release(one);
      const three = await waiting;
      expect(a.pool.size + b.pool.size).toBe(3);
      a.pool.release(three);
      b.pool.release(two);
    } finally {
      await Promise.all([a.pool.disposeAll(), b.pool.disposeAll()]);
    }
  });
  it('重置等待所属资源关闭，其他会话仍可创建；旧 epoch 拒绝', async () => {
    const { pool, runtimes } = fixture();
    try {
      const old = await pool.acquireLease('reset', '/tmp/reset');
      pool.release(old);
      let close!: () => void;
      const gate = new Promise<void>((resolve) => {
        close = resolve;
      });
      const dispose = runtimes[0]!.dispose.bind(runtimes[0]);
      vi.spyOn(runtimes[0]!, 'dispose').mockImplementation(async () => {
        await gate;
        await dispose();
      });
      pool.reset('reset', 2);
      let replaced = false;
      const pending = pool.acquireLease('reset', '/tmp/reset', {}, undefined, 2).then((lease) => {
        replaced = true;
        return lease;
      });
      const other = await pool.acquireLease('other', '/tmp/other');
      expect(replaced).toBe(false);
      pool.release(other);
      close();
      const next = await pending;
      expect(next.sessionId).not.toBe(old.sessionId);
      expect(next.generation).not.toBe(old.generation);
      await expect(pool.acquireLease('reset', '/tmp/reset', {}, undefined, 1)).rejects.toThrow(
        'epoch'
      );
      await pool.drop(old);
      expect(pool.snapshot(next)?.busy).toBe(true);
      pool.release(next);
    } finally {
      await pool.disposeAll();
    }
  });
  it('初始化期间重置淘汰迟到租约，故障重建使用全新 session 并重新回放', async () => {
    let start!: () => void;
    const startup = new Promise<void>((resolve) => {
      start = resolve;
    });
    const runtimes: MockDshRuntime[] = [];
    const { pool } = fixture({
      runtimeFactory: (options) => {
        const runtime = new MockDshRuntime(options);
        runtimes.push(runtime);
        if (runtimes.length === 1) {
          const actual = runtime.start.bind(runtime);
          runtime.start = async () => {
            await startup;
            return actual();
          };
        }
        return runtime.asRuntime();
      },
    });
    try {
      const cancelled = pool.acquireLease('lane', '/tmp/lane');
      await vi.waitFor(() => {
        expect(runtimes).toHaveLength(1);
      });
      pool.reset('lane', 2);
      start();
      await expect(cancelled).rejects.toThrow();
      const next = await pool.acquireLease('lane', '/tmp/lane', {}, undefined, 2);
      pool.markReplayed(next);
      pool.release(next);
      runtimes[1]!.ready = false;
      const rebuilt = await pool.acquireLease('lane', '/tmp/lane', {}, undefined, 2);
      expect(rebuilt.sessionId).not.toBe(next.sessionId);
      expect(rebuilt.replayed).toBe(false);
      pool.release(rebuilt);
    } finally {
      await pool.disposeAll();
    }
  });
});
