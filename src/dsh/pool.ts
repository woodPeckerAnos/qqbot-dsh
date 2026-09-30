/**
 * 每个会话（群聊/单聊）一个 DSH runtime 的进程池，带 LRU 回收与空闲回收。
 *
 * 为什么必须"每会话一个进程"：DSH 的 `initialize.cwd` 是**进程级**的，同进程内
 * 所有会话共用同一个 cwd（见 dsh-sdk-jsonrpc-server 的 `HarnessSdkJsonRpcServer.cwd`）。
 * 若多个会话共用一个进程，会话 A 的 agent 能读到会话 B 工作区的文件。
 *
 * 代价是进程数与内存随活跃会话数增长，因此需要：
 *   - `maxRuntimes` 上限，超出按 LRU 回收最久未使用的（回收前先优雅 shutdown）；
 *   - `runtimeIdleMs` 空闲回收（0 表示不回收）；
 *   - 处理"进程自己死了"的情况：下次取用自动重建。
 *
 * 回收后该会话会失忆（DSH 侧历史不续），由桥接层的对话记录回放补偿（见 store/）。
 */

import { EventEmitter } from 'node:events';

import type { Logger } from '../logger.js';
import { DshRuntime, type DshRuntimeOptions } from './process.js';
import type {
  SessionEventNotification,
  SessionStatusNotification,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from './protocol.js';

export interface RuntimeEntry {
  conversationKey: string;
  runtime: DshRuntime;
  /** 该会话当前使用的 DSH sessionId */
  sessionId: string;
  /** 是否已做过冷启动回放（每个 sessionId 只回放一次） */
  replayed: boolean;
  createdAt: number;
  lastUsedAt: number;
  /** 该会话正在进行中的 turn 数（串行化后应为 0 或 1） */
  busy: boolean;
  /**
   * 该 runtime 进程内仍在运行的后台子代理会话 id 集合。
   *
   * 为什么必须记账：后台子代理**驻留在 runtime 进程内**（DSH 的 residency 是
   * 进程本地的）。父 turn 结束后 `busy` 会变回 false，若无这个集合，空闲回收与
   * LRU 驱逐会把承载着后台任务的进程关掉——任务被静默杀掉，用户永远等不到结果。
   * 非空 = 视同 busy，豁免一切自动回收（手动 drop / disposeAll 仍会杀，带告警）。
   */
  activeChildren: Set<string>;
}

export interface RuntimePoolOptions {
  maxRuntimes: number;
  runtimeIdleMs: number;
  /** new DshRuntime 用的模板（cwd 与 logger 由池按会话替换） */
  base: Omit<DshRuntimeOptions, 'cwd' | 'logger'>;
  logger: Logger;
  /** 注入时钟，便于单测 */
  now?: () => number;
  /** 注入 runtime 工厂，便于单测 */
  runtimeFactory?: (options: DshRuntimeOptions) => DshRuntime;
  /** sessionId 生成器，便于单测断言 */
  sessionIdFactory?: (conversationKey: string) => string;
}

export interface RuntimePoolEvents {
  'session.event': (conversationKey: string, notification: SessionEventNotification) => void;
  'session.status': (conversationKey: string, notification: SessionStatusNotification) => void;
  'subagent.started': (conversationKey: string, notification: SubagentStartedNotification) => void;
  'subagent.finished': (conversationKey: string, notification: SubagentFinishedNotification) => void;
  'runtime.exit': (conversationKey: string, code: number | null, signal: NodeJS.Signals | null) => void;
}

/**
 * 为一个会话生成稳定的 sessionId。
 *
 * 注意：进程重启后**不会**因为这个 id 相同而恢复上下文（见 DESIGN 2.3）。
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

  constructor(private readonly options: RuntimePoolOptions) {
    super();
  }

  get size(): number {
    return this.entries.size;
  }

  /** 当前所有活跃会话的 key（用于 health 展示） */
  activeConversationKeys(): string[] {
    return [...this.entries.keys()];
  }

  /** 全部 runtime 内仍在跑的后台子代理总数（health 展示，见 DESIGN §13.4）。 */
  activeSubagents(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.activeChildren.size;
    return total;
  }

  /** 取该会话的条目，不存在则创建运行时并完成 initialize。 */
  async acquire(conversationKey: string, workspacePath: string): Promise<RuntimeEntry> {
    if (this.disposed) throw new Error('runtime 池已关闭');

    const existing = this.entries.get(conversationKey);
    if (existing !== undefined) {
      if (existing.runtime.isReady) {
        existing.lastUsedAt = this.now();
        return existing;
      }
      // 进程死了或未就绪：清掉重建，保证调用方总能拿到可用运行时
      this.options.logger.warn('runtime 不可用，重建', {
        conversation: conversationKey,
        state: existing.runtime.state,
      });
      await this.drop(conversationKey);
    }

    await this.evictIfNeeded();
    const entry = await this.create(conversationKey, workspacePath);
    this.entries.set(conversationKey, entry);
    this.scheduleReclaim();
    return entry;
  }

  /** 标记该会话空闲（turn 结束）。 */
  release(conversationKey: string): void {
    const entry = this.entries.get(conversationKey);
    if (entry === undefined) return;
    entry.busy = false;
    entry.lastUsedAt = this.now();
  }

  /** 立即移除并关闭某会话的 runtime。 */
  async drop(conversationKey: string): Promise<void> {
    const entry = this.entries.get(conversationKey);
    if (entry === undefined) return;
    this.entries.delete(conversationKey);
    if (entry.activeChildren.size > 0) {
      // 关闭进程会连带杀掉驻留其中的后台子代理。自动回收路径已豁免这种情况，
      // 能走到这里说明是手动 drop（超时终止 / disposeAll / runtime 死亡重建），
      // 明确告警便于排查"后台任务怎么没结果了"。
      this.options.logger.warn('关闭 runtime 将终止其承载的后台子代理', {
        conversation: conversationKey,
        active: entry.activeChildren.size,
        children: [...entry.activeChildren],
      });
    }
    this.options.logger.info('关闭 runtime', {
      conversation: conversationKey,
      pid: entry.runtime.pid,
    });
    await entry.runtime.dispose().catch((error: unknown) => {
      this.options.logger.warn('关闭 runtime 时出错', {
        conversation: conversationKey,
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

  private async create(conversationKey: string, workspacePath: string): Promise<RuntimeEntry> {
    const { base, logger } = this.options;
    const runtimeOptions: DshRuntimeOptions = {
      ...base,
      cwd: workspacePath,
      logger: logger.child({ conversation: conversationKey }),
    };
    const factory = this.options.runtimeFactory ?? ((opts: DshRuntimeOptions) => new DshRuntime(opts));
    const runtime = factory(runtimeOptions);

    // 先建 entry 再接线：subagent 计数要写进 entry.activeChildren，
    // 而事件可能在 start() 期间就到达，所以 handler 必须闭包引用同一个 entry。
    const at = this.now();
    const entry: RuntimeEntry = {
      conversationKey,
      runtime,
      sessionId: (this.options.sessionIdFactory ?? stableSessionId)(conversationKey),
      replayed: false,
      createdAt: at,
      lastUsedAt: at,
      busy: false,
      activeChildren: new Set<string>(),
    };

    runtime.on('session.event', (n) => this.emit('session.event', conversationKey, n));
    runtime.on('session.status', (n) => this.emit('session.status', conversationKey, n));
    // 后台子代理进出：维护 activeChildren（回收豁免的依据），并向上冒泡供统计/日志。
    runtime.on('subagent.started', (n) => {
      entry.activeChildren.add(n.childSessionId);
      this.options.logger.info('后台子代理已启动', {
        conversation: conversationKey,
        child: n.childSessionId,
        active: entry.activeChildren.size,
      });
      this.emit('subagent.started', conversationKey, n);
    });
    runtime.on('subagent.finished', (n) => {
      entry.activeChildren.delete(n.childSessionId);
      this.options.logger.info('后台子代理已结束', {
        conversation: conversationKey,
        child: n.childSessionId,
        status: n.status,
        stopReason: n.stopReason,
        active: entry.activeChildren.size,
      });
      this.emit('subagent.finished', conversationKey, n);
    });
    runtime.on('exit', (code, signal) => {
      this.options.logger.warn('runtime 退出', { conversation: conversationKey, code, signal });
      this.emit('runtime.exit', conversationKey, code, signal);
    });

    await runtime.start();
    return entry;
  }

  /** 超过上限时回收最久未使用、不忙且无后台子代理的 runtime。 */
  private async evictIfNeeded(): Promise<void> {
    const { maxRuntimes, logger } = this.options;
    while (this.entries.size >= maxRuntimes) {
      const candidates = [...this.entries.values()]
        .filter((entry) => !entry.busy && entry.activeChildren.size === 0)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const victim = candidates[0];
      if (victim === undefined) {
        // 全部在忙或都承载着后台任务：不强行杀掉正在干活的任务，让调用方排队等待
        logger.warn('runtime 池已满且全部在忙/承载后台子代理，等待空闲后再回收', {
          size: this.entries.size,
          max: maxRuntimes,
        });
        return;
      }
      logger.info('按 LRU 回收 runtime', { conversation: victim.conversationKey, size: this.entries.size });
      await this.drop(victim.conversationKey);
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
      // 承载着后台子代理的进程不回收：子代理驻留在进程内，回收 = 静默杀任务。
      if (entry.activeChildren.size > 0) continue;
      if (now - entry.lastUsedAt < idleMs) continue;
      this.options.logger.info('空闲回收 runtime', {
        conversation: entry.conversationKey,
        idleMs: now - entry.lastUsedAt,
      });
      await this.drop(entry.conversationKey);
    }
  }
}
