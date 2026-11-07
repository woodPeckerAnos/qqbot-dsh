import type {
  RuntimeHandle,
  RuntimeLease,
  RuntimeLeaseSnapshot,
  RuntimePoolOptions,
} from '@qqbot/contracts';
/**
 * 按调用方隔离键管理 DSH runtime 租约，带硬上限、LRU 和空闲回收。
 *
 * 为什么必须隔离进程：DSH 的 `initialize.cwd` 是进程级的，同进程内
 * 所有会话共用同一个 cwd（见 dsh-sdk-jsonrpc-server 的 `HarnessSdkJsonRpcServer.cwd`）。
 * 共用不同 Task 的工作区会导致文件串属。DshLaneRunner 使用 Session/lane/Task
 * 隔离键获取独占租约，生成唯一执行 sessionId，并在执行结束后销毁具体租约。
 *
 * 代价是进程数与内存随活跃会话数增长，因此需要：
 *   - `maxRuntimes` 上限，超出按 LRU 回收最久未使用的（回收前先优雅 shutdown）；
 *   - `runtimeIdleMs` 空闲回收（0 表示不回收）；
 *   - 处理"进程自己死了"的情况：下次取用自动重建。
 *
 * runtime 回收不恢复 DSH 历史；Task 输入由 PromptPreparer 固定上下文与回放。
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { DshRuntime as RuntimeImplementation } from './process.js';
import type { DshRuntime } from '@qqbot/contracts';
import type { DshRuntimeEvents, DshRuntimeOptions } from '@qqbot/contracts';
import type {
  PromptContentBlock,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@qqbot/contracts';

/** 租约消费者只获得协议操作，不能启动、关闭或改写池内 runtime。 */
export type { RuntimeHandle } from '@qqbot/contracts';

/** 每次准入产生独立身份；相同进程上的旧租约不能释放新的占用。 */
export type { RuntimeLease } from '@qqbot/contracts';

export type { RuntimeLeaseSnapshot } from '@qqbot/contracts';

interface RuntimeEntry {
  generation: string;
  conversationKey: string;
  runtime: DshRuntime;
  /** 该会话当前使用的 DSH sessionId */
  sessionId: string;
  /** 是否已做过冷启动回放（每个 sessionId 只回放一次） */
  replayed: boolean;
  createdAt: number;
  lastUsedAt: number;
  /** 该租约是否被执行独占 */
  busy: boolean;
  /**
   * 该 runtime 进程内仍在运行的子代理会话 id 集合。
   * 所属 lane 前台等待子代理。池额外检查该集合，避免自动回收仍有子代理的进程。
   * 非空 = 视同 busy，豁免一切自动回收（手动 drop / disposeAll 仍会杀，带告警）。
   */
  activeChildren: Set<string>;
  handle: RuntimeHandle;
  lease?: RuntimeLease;
  closing: boolean;
  disposal?: Promise<void>;
  readonly disposers: (() => void)[];
}

export type { RuntimePoolOptions } from '@qqbot/contracts';

export type { RuntimePoolEvents } from '@qqbot/contracts';

/**
 * 为一个会话生成稳定的 sessionId。
 *
 * 注意：进程重启后**不会**因为这个 id 相同而恢复上下文（见 docs/ARCHITECTURE.md 的「平台前提」）。
 * 用稳定 id 只是为了让 DSH 的会话日志目录可读、便于排查。
 *
 * 做字符净化：单聊的会话键形如 `c2c:<openid>`，冒号等字符可能出现在 DSH 的
 * 会话文件名里，统一替换为 `_` 以免踩到路径解析。
 */
export function stableSessionId(conversationKey: string): string {
  return `qq-${conversationKey.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export class RuntimePool extends EventEmitter {
  private readonly entries = new Map<string, RuntimeEntry>();
  private reclaimTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private acquisition: Promise<void> = Promise.resolve();
  private readonly waiters = new Set<() => void>();

  constructor(private readonly options: RuntimePoolOptions) {
    super();
    if (!Number.isInteger(options.maxRuntimes) || options.maxRuntimes < 1)
      throw new Error('runtime 池硬上限必须 >= 1');
  }

  get size(): number {
    return this.entries.size;
  }

  /** 当前所有活跃会话的 key（用于 health 展示） */
  activeConversationKeys(): string[] {
    return [...this.entries.keys()];
  }

  /** 全部 runtime 内仍在运行的子代理总数（health 展示）。 */
  activeSubagents(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.activeChildren.size;
    return total;
  }

  /** 只读非独占租约，用于最小协议检查；执行使用 acquireLease。 */
  async acquire(
    conversationKey: string,
    workspacePath: string,
    overrides: Partial<DshRuntimeOptions> = {},
    exclusive = false,
    signal?: AbortSignal
  ): Promise<RuntimeLease> {
    const before = this.acquisition;
    let unlock!: () => void;
    this.acquisition = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await before;
    try {
      signal?.throwIfAborted();
      const entry = await this.acquireSerial(
        conversationKey,
        workspacePath,
        overrides,
        exclusive,
        signal
      );
      return this.issueLease(entry);
    } finally {
      unlock();
    }
  }

  acquireLease(
    conversationKey: string,
    workspacePath: string,
    overrides: Partial<DshRuntimeOptions> = {},
    signal?: AbortSignal
  ): Promise<RuntimeLease> {
    return this.acquire(conversationKey, workspacePath, overrides, true, signal);
  }

  private async acquireSerial(
    conversationKey: string,
    workspacePath: string,
    overrides: Partial<DshRuntimeOptions>,
    exclusive: boolean,
    signal?: AbortSignal
  ): Promise<RuntimeEntry> {
    if (this.disposed) throw new Error('runtime 池已关闭');

    const existing = this.entries.get(conversationKey);
    if (existing !== undefined) {
      if (existing.runtime.isReady && !existing.closing) {
        if (existing.busy) throw new Error('runtime 租约已占用');
        if (exclusive) existing.busy = true;
        existing.lastUsedAt = this.now();
        return existing;
      }
      // 进程死了或未就绪：清掉重建，保证调用方总能拿到可用运行时
      this.options.logger.warn('runtime 不可用，重建', {
        conversation: conversationKey,
        state: existing.runtime.state,
      });
      await this.dropEntry(existing);
    }

    while (!(await this.evictIfNeeded())) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener('abort', wake);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
        signal?.addEventListener('abort', wake, { once: true });
        if (signal?.aborted) wake();
      });
      signal?.throwIfAborted();
      if (this.disposed) throw new Error('runtime 池已关闭');
    }
    const entry = await this.create(conversationKey, workspacePath, overrides);
    if (this.disposed || signal?.aborted) {
      await entry.runtime.dispose();
      throw new Error('runtime 池已关闭或租约已取消');
    }
    if (exclusive) entry.busy = true;
    this.entries.set(conversationKey, entry);
    this.scheduleReclaim();
    return entry;
  }

  /** 标记具体租约空闲并撤销其写入能力；重复或伪造身份无副作用。 */
  release(lease: RuntimeLease): void {
    const entry = this.currentEntry(lease);
    if (!entry) return;
    entry.lease = undefined;
    entry.busy = false;
    entry.lastUsedAt = this.now();
    this.wakeWaiters();
  }

  /** 关闭具体租约；调用者不能用会话键误伤后续执行。 */
  async drop(lease: RuntimeLease): Promise<void> {
    const entry = this.currentEntry(lease);
    if (!entry) {
      await this.leases.get(lease)?.disposal;
      return;
    }
    await this.dropEntry(entry);
  }

  snapshot(lease: RuntimeLease): RuntimeLeaseSnapshot | undefined {
    const entry = this.currentEntry(lease);
    if (!entry) return undefined;
    return Object.freeze({
      leaseId: lease.leaseId,
      busy: entry.busy,
      replayed: entry.replayed,
      lastUsedAt: entry.lastUsedAt,
      activeChildren: Object.freeze([...entry.activeChildren]),
    });
  }

  private readonly leases = new WeakMap<RuntimeLease, RuntimeEntry>();

  private issueLease(entry: RuntimeEntry): RuntimeLease {
    const lease: RuntimeLease = Object.freeze({
      leaseId: (this.options.idFactory ?? randomUUID)(),
      generation: entry.generation,
      conversationKey: entry.conversationKey,
      runtime: entry.handle,
      sessionId: entry.sessionId,
      createdAt: entry.createdAt,
    });
    this.leases.set(lease, entry);
    entry.lease = lease;
    return lease;
  }

  private currentEntry(lease: RuntimeLease): RuntimeEntry | undefined {
    const entry = this.leases.get(lease);
    if (entry?.lease !== lease || entry.closing) return undefined;
    return this.entries.get(lease.conversationKey) === entry ? entry : undefined;
  }

  private async dropEntry(entry: RuntimeEntry): Promise<void> {
    if (entry.disposal) return entry.disposal;
    entry.closing = true;
    entry.lease = undefined;
    const conversationKey = entry.conversationKey;
    if (entry.activeChildren.size > 0) {
      // 关闭进程会连带停止驻留其中的子代理。自动回收路径已豁免这种情况，
      // 能走到这里说明是手动 drop（超时终止 / disposeAll / runtime 死亡重建），
      // 明确告警便于排查所属 Task 的中断。
      this.options.logger.warn('关闭 runtime 将终止其承载的子代理', {
        conversation: conversationKey,
        active: entry.activeChildren.size,
        children: [...entry.activeChildren],
      });
    }
    this.options.logger.info('关闭 runtime', {
      conversation: conversationKey,
      pid: entry.runtime.pid,
    });
    entry.disposal = entry.runtime.dispose().catch((error: unknown) => {
      this.options.logger.warn('关闭 runtime 时出错', {
        conversation: conversationKey,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await entry.disposal;
    entry.disposers.forEach((dispose) => {
      dispose();
    });
    entry.disposers.length = 0;
    if (this.entries.get(conversationKey) === entry) this.entries.delete(conversationKey);
    this.wakeWaiters();
  }

  /** 关闭所有 runtime。用于进程退出。 */
  async disposeAll(): Promise<void> {
    this.disposed = true;
    this.wakeWaiters();
    if (this.reclaimTimer !== undefined) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = undefined;
    }
    const entries = [...this.entries.values()];
    await Promise.allSettled(entries.map((entry) => this.dropEntry(entry)));
    await this.acquisition;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async create(
    conversationKey: string,
    workspacePath: string,
    overrides: Partial<DshRuntimeOptions>
  ): Promise<RuntimeEntry> {
    const { base, logger } = this.options;
    const generation = (this.options.idFactory ?? randomUUID)();
    const runtimeOptions: DshRuntimeOptions = {
      ...base,
      ...overrides,
      env: { ...base.env, ...overrides.env, QQBOT_RUNTIME_GENERATION: generation },
      cwd: workspacePath,
      logger: (overrides.logger ?? logger).child({
        conversation: conversationKey,
        runtimeGeneration: generation,
      }),
    };
    const factory =
      this.options.runtimeFactory ?? ((opts: DshRuntimeOptions) => new RuntimeImplementation(opts));
    const runtime = factory(runtimeOptions);

    // 先建 entry 再接线：subagent 计数要写进 entry.activeChildren，
    // 而事件可能在 start() 期间就到达，所以 handler 必须闭包引用同一个 entry。
    const at = this.now();
    const entry: RuntimeEntry = {
      generation,
      conversationKey,
      runtime,
      sessionId: (this.options.sessionIdFactory ?? stableSessionId)(conversationKey),
      replayed: false,
      createdAt: at,
      lastUsedAt: at,
      busy: false,
      activeChildren: new Set<string>(),
      handle: this.runtimeHandle(runtime),
      closing: false,
      disposers: [],
    };
    const listen = <K extends keyof DshRuntimeEvents>(event: K, listener: DshRuntimeEvents[K]) => {
      runtime.on(event, listener);
      entry.disposers.push(() => {
        runtime.off(event, listener);
      });
    };
    listen('session.event', (n) => this.emit('session.event', conversationKey, n));
    listen('session.status', (n) => this.emit('session.status', conversationKey, n));
    // 子代理进出：维护 activeChildren（回收豁免的依据），并向上冒泡供统计/日志。
    listen('subagent.started', (n: SubagentStartedNotification) => {
      entry.activeChildren.add(n.childSessionId);
      this.emit('subagent.started', conversationKey, n);
    });
    listen('subagent.finished', (n: SubagentFinishedNotification) => {
      entry.activeChildren.delete(n.childSessionId);
      if (!entry.busy && !entry.activeChildren.size) this.wakeWaiters();
      this.emit('subagent.finished', conversationKey, n);
    });
    listen('exit', (code, signal) => {
      this.emit('runtime.exit', conversationKey, code, signal);
    });

    try {
      await runtime.start();
    } catch (error) {
      await runtime.dispose().catch(() => {});
      entry.disposers.forEach((dispose) => {
        dispose();
      });
      throw error;
    }
    return entry;
  }

  private runtimeHandle(runtime: DshRuntime): RuntimeHandle {
    return Object.freeze({
      get isReady() {
        return runtime.isReady;
      },
      get state() {
        return runtime.state;
      },
      get pid() {
        return runtime.pid;
      },
      get lastErrorId() {
        return runtime.lastErrorId;
      },
      prompt: (sessionId: string, blocks: PromptContentBlock[]) =>
        runtime.prompt(sessionId, structuredClone(blocks)),
      notifyTaskCooperation: (update: import('@qqbot/contracts').TaskCooperationUpdate) =>
        runtime.notifyTaskCooperation?.(structuredClone(update)),
      onTaskChannelClose: (listener: () => void) =>
        runtime.onTaskChannelClose?.(listener) ?? (() => {}),
      on: <K extends keyof DshRuntimeEvents>(event: K, listener: DshRuntimeEvents[K]): void => {
        runtime.on(event, listener);
      },
      off: <K extends keyof DshRuntimeEvents>(event: K, listener: DshRuntimeEvents[K]): void => {
        runtime.off(event, listener);
      },
    });
  }

  /** 超过上限时回收最久未使用、不忙且无子代理的 runtime。 */
  private async evictIfNeeded(): Promise<boolean> {
    const { maxRuntimes, logger } = this.options;
    while (this.entries.size >= maxRuntimes) {
      const candidates = [...this.entries.values()]
        .filter((entry) => !entry.busy && entry.activeChildren.size === 0)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const victim = candidates[0];
      if (victim === undefined) {
        // 全部在忙或仍有子代理：让调用方排队等待，不突破硬上限。
        logger.warn('runtime 池已满且全部在忙/承载子代理，等待空闲后再回收', {
          size: this.entries.size,
          max: maxRuntimes,
        });
        return false;
      }
      logger.info('按 LRU 回收 runtime', {
        conversation: victim.conversationKey,
        size: this.entries.size,
      });
      await this.dropEntry(victim);
    }
    return true;
  }

  private wakeWaiters(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    waiters.forEach((fn) => {
      fn();
    });
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
      // 有子代理的进程不回收：所属执行必须等它结束。
      if (entry.activeChildren.size > 0) continue;
      if (now - entry.lastUsedAt < idleMs) continue;
      this.options.logger.info('空闲回收 runtime', {
        conversation: entry.conversationKey,
        idleMs: now - entry.lastUsedAt,
      });
      await this.dropEntry(entry);
    }
  }
}
