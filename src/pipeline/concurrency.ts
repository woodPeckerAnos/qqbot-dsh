/**
 * 并发原语：每会话串行 + 全局并发闸门 + 有界队列。
 *
 * 为什么需要三个不同的机制：
 *   - **每群串行**：同一个群里两条消息同时跑到一个 DSH 会话上会互相干扰
 *     （followup 会排队，但事件流混在一起，无法把"哪条 assistant 消息属于哪个提问"
 *     对应起来）。所以一个群同一时刻只处理一条。
 *   - **全局并发闸门**：每个群一个 DSH 进程，不限制会打爆 CPU/内存。
 *   - **有界队列**：超过容量就明确拒绝，而不是无限排队导致回复时早已过了
 *     5 分钟被动回复窗口（排到了也发不出去，纯浪费）。
 */

export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('Semaphore 容量必须 >= 1');
    this.available = capacity;
  }

  get inUse(): number {
    return this.capacity - this.available;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return () => this.release();
  }

  /** 非阻塞获取：有名额返回释放函数，没有返回 undefined（介入路径用，绝不排队）。 */
  tryAcquire(): (() => void) | undefined {
    if (this.available <= 0) return undefined;
    this.available -= 1;
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.available = Math.min(this.capacity, this.available + 1);
  }
}

/** 每 key 一把排他锁：同一 key 的任务严格串行，不同 key 并行。 */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<void>>();

  /** 该 key 当前是否有在途任务 */
  get activeKeys(): number {
    return this.chains.size;
  }

  isBusy(key: string): boolean {
    return this.chains.has(key);
  }

  /**
   * 在 key 上串行执行 fn。
   *
   * 返回值是 fn 的结果。前一个任务抛错不会阻塞后一个（错误被吸收进链）。
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 新链尾：等前一个完成后再等自己这把门
    const chained = previous.then(() => gate);
    this.chains.set(key, chained);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      // 只有当自己仍是链尾时才删除，避免误删后来者的链
      if (this.chains.get(key) === chained) this.chains.delete(key);
    }
  }

  /**
   * 非阻塞版 run：key 被占立即返回 false，否则执行 fn 并返回 true。
   * 检查与上锁之间无 await（单线程内原子），介入路径「绝不排队」用。
   */
  async tryRun(key: string, fn: () => Promise<unknown>): Promise<boolean> {
    if (this.chains.has(key)) return false;
    await this.run(key, fn);
    return true;
  }
}

export class QueueFullError extends Error {
  constructor(readonly limit: number) {
    super(`队列已满（上限 ${limit}），已拒绝新的请求`);
    this.name = 'QueueFullError';
  }
}

export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`操作超时（${timeoutMs}ms）`);
    this.name = 'TimeoutError';
  }
}

/** 给一个 promise 加超时。超时后原 promise 仍在跑，调用方需自行处理副作用。 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * 可超时的等待：轮询 predicate，直到为真或超时。
 * 用轮询而不是事件订阅，是因为调用方通常在"已收到若干事件后"才开始等待，
 * 轮询实现最简单且不会丢事件（状态由 accumulator 持有）。
 */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
