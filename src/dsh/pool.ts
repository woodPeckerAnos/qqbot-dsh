/**
 * 每群一个 DSH runtime 的进程池，带 LRU 回收与空闲回收。
 *
 * 为什么必须"每群一个进程"：DSH 的 `initialize.cwd` 是**进程级**的，同进程内
 * 所有会话共用同一个 cwd（见 dsh-sdk-jsonrpc-server 的 `HarnessSdkJsonRpcServer.cwd`）。
 * 若多个群共用一个进程，群 A 的 agent 能读到群 B 工作区的文件。
 *
 * 代价是进程数与内存随活跃群数增长，因此需要：
 *   - `maxRuntimes` 上限，超出按 LRU 回收最久未使用的（回收前先优雅 shutdown）；
 *   - `runtimeIdleMs` 空闲回收（0 表示不回收）；
 *   - 处理"进程自己死了"的情况：下次取用自动重建。
 *
 * 回收后该群会失忆（DSH 侧历史不续），由桥接层的对话记录回放补偿（见 store/）。
 */

import { EventEmitter } from 'node:events';

import type { Logger } from '../logger.js';
import { DshRuntime, type DshRuntimeOptions } from './process.js';
import type { SessionEventNotification, SessionStatusNotification } from './protocol.js';

export interface RuntimeEntry {
  groupKey: string;
  runtime: DshRuntime;
  /** 该群当前使用的 DSH sessionId */
  sessionId: string;
  /** 是否已做过冷启动回放（每个 sessionId 只回放一次） */
  replayed: boolean;
  createdAt: number;
  lastUsedAt: number;
  /** 该群正在进行中的 turn 数（串行化后应为 0 或 1） */
  busy: boolean;
}

export interface RuntimePoolOptions {
  maxRuntimes: number;
  runtimeIdleMs: number;
  /** new DshRuntime 用的模板（cwd 与 logger 由池按群替换） */
  base: Omit<DshRuntimeOptions, 'cwd' | 'logger'>;
  logger: Logger;
  /** 注入时钟，便于单测 */
  now?: () => number;
  /** 注入 runtime 工厂，便于单测 */
  runtimeFactory?: (options: DshRuntimeOptions) => DshRuntime;
  /** sessionId 生成器，便于单测断言 */
  sessionIdFactory?: (groupKey: string) => string;
}

export interface RuntimePoolEvents {
  'session.event': (groupKey: string, notification: SessionEventNotification) => void;
  'session.status': (groupKey: string, notification: SessionStatusNotification) => void;
  'runtime.exit': (groupKey: string, code: number | null, signal: NodeJS.Signals | null) => void;
}

/**
 * 为一个群生成稳定的 sessionId。
 *
 * 注意：进程重启后**不会**因为这个 id 相同而恢复上下文（见 DESIGN 2.3）。
 * 用稳定 id 只是为了让 DSH 的会话日志目录可读、便于排查。
 */
export function stableSessionId(groupKey: string): string {
  return `qq-${groupKey}`;
}

export class RuntimePool extends EventEmitter {
  private readonly entries = new Map<string, RuntimeEntry>();
  private reclaimTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly options: RuntimePoolOptions) {
    super();
  }

  get size(): number {
    return this.entries.size;
  }

  /** 当前所有活跃群的 key（用于 health 展示） */
  activeGroupKeys(): string[] {
    return [...this.entries.keys()];
  }

  /** 取该群的条目，不存在则创建运行时并完成 initialize。 */
  async acquire(groupKey: string, workspacePath: string): Promise<RuntimeEntry> {
    if (this.disposed) throw new Error('runtime 池已关闭');

    const existing = this.entries.get(groupKey);
    if (existing !== undefined) {
      if (existing.runtime.isReady) {
        existing.lastUsedAt = this.now();
        return existing;
      }
      // 进程死了或未就绪：清掉重建，保证调用方总能拿到可用运行时
      this.options.logger.warn('runtime 不可用，重建', {
        group: groupKey,
        state: existing.runtime.state,
      });
      await this.drop(groupKey);
    }

    await this.evictIfNeeded();
    const entry = await this.create(groupKey, workspacePath);
    this.entries.set(groupKey, entry);
    this.scheduleReclaim();
    return entry;
  }

  /** 标记该群空闲（turn 结束）。 */
  release(groupKey: string): void {
    const entry = this.entries.get(groupKey);
    if (entry === undefined) return;
    entry.busy = false;
    entry.lastUsedAt = this.now();
  }

  /** 立即移除并关闭某群的 runtime。 */
  async drop(groupKey: string): Promise<void> {
    const entry = this.entries.get(groupKey);
    if (entry === undefined) return;
    this.entries.delete(groupKey);
    this.options.logger.info('关闭 runtime', { group: groupKey, pid: entry.runtime.pid });
    await entry.runtime.dispose().catch((error: unknown) => {
      this.options.logger.warn('关闭 runtime 时出错', {
        group: groupKey,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** 关闭所有 runtime。用于进程退出。 */
  async disposeAll(): Promise<void> {
    this.disposed = true;
    if (this.reclaimTimer !== undefined) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = undefined;
    }
    const keys = [...this.entries.keys()];
    await Promise.allSettled(keys.map((key) => this.drop(key)));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async create(groupKey: string, workspacePath: string): Promise<RuntimeEntry> {
    const { base, logger } = this.options;
    const runtimeOptions: DshRuntimeOptions = {
      ...base,
      cwd: workspacePath,
      logger: logger.child({ group: groupKey }),
    };
    const factory = this.options.runtimeFactory ?? ((opts: DshRuntimeOptions) => new DshRuntime(opts));
    const runtime = factory(runtimeOptions);

    runtime.on('session.event', (n) => this.emit('session.event', groupKey, n));
    runtime.on('session.status', (n) => this.emit('session.status', groupKey, n));
    runtime.on('exit', (code, signal) => {
      this.options.logger.warn('runtime 退出', { group: groupKey, code, signal });
      this.emit('runtime.exit', groupKey, code, signal);
    });

    await runtime.start();
    const at = this.now();
    return {
      groupKey,
      runtime,
      sessionId: (this.options.sessionIdFactory ?? stableSessionId)(groupKey),
      replayed: false,
      createdAt: at,
      lastUsedAt: at,
      busy: false,
    };
  }

  /** 超过上限时回收最久未使用且不忙的 runtime。 */
  private async evictIfNeeded(): Promise<void> {
    const { maxRuntimes, logger } = this.options;
    while (this.entries.size >= maxRuntimes) {
      const candidates = [...this.entries.values()]
        .filter((entry) => !entry.busy)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const victim = candidates[0];
      if (victim === undefined) {
        // 全部在忙：不强行杀掉正在干活的任务，让调用方排队等待
        logger.warn('runtime 池已满且全部在忙，等待空闲后再回收', {
          size: this.entries.size,
          max: maxRuntimes,
        });
        return;
      }
      logger.info('按 LRU 回收 runtime', { group: victim.groupKey, size: this.entries.size });
      await this.drop(victim.groupKey);
    }
  }

  private scheduleReclaim(): void {
    if (this.reclaimTimer !== undefined) return;
    const idleMs = this.options.runtimeIdleMs;
    if (idleMs <= 0) return;
    // 检查间隔取空闲阈值的一半，但不小于 30s，避免过于频繁
    const interval = Math.max(30_000, Math.floor(idleMs / 2));
    this.reclaimTimer = setInterval(() => {
      void this.reclaimIdle();
    }, interval);
    this.reclaimTimer.unref?.();
  }

  private async reclaimIdle(): Promise<void> {
    const idleMs = this.options.runtimeIdleMs;
    if (idleMs <= 0) return;
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.busy) continue;
      if (now - entry.lastUsedAt < idleMs) continue;
      this.options.logger.info('空闲回收 runtime', {
        group: entry.groupKey,
        idleMs: now - entry.lastUsedAt,
      });
      await this.drop(entry.groupKey);
    }
  }
}
