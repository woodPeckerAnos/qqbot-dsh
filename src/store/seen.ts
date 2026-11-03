import type { SeenStoreOptions } from '@qqbot/contracts';
/**
 * 事件去重。
 *
 * 为什么需要两层：
 *   - **内存 LRU**：绝大多数重复是网关重连/resume 时的短时间重放，内存足够；
 *   - **磁盘标记**：内存 LRU 在进程重启后失效，而重启恰好是网关最容易重放的时刻。
 *
 * 磁盘层用 `open(path, 'wx')`（O_EXCL）原子创建空文件：创建成功 = 首次见到，
 * 抛 EEXIST = 已处理过。这个原子性由内核保证，不需要额外加锁。
 *
 * 定期按 mtime 清理超过保留期的标记，避免无界增长。
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { failure, readonlySnapshot, type Result } from '@qqbot/contracts';

export type { SeenStoreOptions } from '@qqbot/contracts';

export class SeenStore {
  private readonly options: SeenStoreOptions;
  private readonly memory = new Set<string>();
  private readonly memoryOrder: string[] = [];
  private readonly retentionMs: number;
  private readonly memoryLimit: number;
  private lastSweepAt = 0;

  constructor(options: SeenStoreOptions) {
    this.options = { ...options, paths: readonlySnapshot(options.paths) };
    this.retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1000;
    this.memoryLimit = options.memoryLimit ?? 2_000;
    // 目录建不出来不是致命错误：claim() 会退化为纯内存去重。
    // 存储属于"尽力而为"，不能成为进程启动失败的原因。
    try {
      mkdirSync(options.paths.seenDir, { recursive: true });
    } catch (error) {
      options.logger.warn('去重标记目录不可用，将退化为内存去重', {
        dir: options.paths.seenDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 声明"我要处理这个事件"。
   * @returns true = 首次见到（调用方应处理）；false = 重复（调用方应丢弃）
   */
  claim(eventId: string): boolean {
    const result = this.claimResult(eventId);
    if (result.ok) return result.value;
    this.options.logger.warn('事件去重标记写入失败，退化为内存去重', {
      eventId,
      error:
        result.error.cause instanceof Error
          ? result.error.cause.message
          : String(result.error.cause),
    });
    return this.claimVolatile(eventId);
  }

  claimVolatile(eventId: string): boolean {
    if (this.memory.has(eventId)) return false;
    this.rememberInMemory(eventId);
    return true;
  }

  /** 显式返回磁盘故障；claim兼容层负责现行内存降级策略。 */
  claimResult(eventId: string): Result<boolean> {
    if (eventId === '') return { ok: true, value: true };
    if (this.memory.has(eventId)) return { ok: true, value: false };

    const markerPath = this.markerPath(eventId);
    try {
      const fd = openSync(markerPath, 'wx');
      // 写入处理时间戳，便于人工排查
      try {
        writeSync(fd, String(this.now()));
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        this.rememberInMemory(eventId);
        return { ok: true, value: false };
      }
      return { ok: false, error: failure('PERSISTENCE_FAILED', error) };
    }

    this.rememberInMemory(eventId);
    this.maybeSweep();
    return { ok: true, value: true };
  }

  /** 清理过期的磁盘标记。 */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    let entries: string[];
    try {
      entries = readdirSync(this.options.paths.seenDir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      const path = join(this.options.paths.seenDir, name);
      try {
        const stat = statSync(path);
        if (now - stat.mtimeMs > this.retentionMs) {
          unlinkSync(path);
          removed += 1;
        }
      } catch {
        /* 并发删除，忽略 */
      }
    }
    this.lastSweepAt = now;
    if (removed > 0) this.options.logger.debug('清理过期去重标记', { removed });
    return removed;
  }

  get memorySize(): number {
    return this.memory.size;
  }

  private markerPath(eventId: string): string {
    // eventId 可能含 `/` 等字符，用 encodeURIComponent 保证是合法文件名
    return join(this.options.paths.seenDir, encodeURIComponent(eventId));
  }

  private rememberInMemory(eventId: string): void {
    if (this.memory.has(eventId)) return;
    this.memory.add(eventId);
    this.memoryOrder.push(eventId);
    while (this.memoryOrder.length > this.memoryLimit) {
      const evicted = this.memoryOrder.shift();
      if (evicted !== undefined) this.memory.delete(evicted);
    }
  }

  private maybeSweep(): void {
    const sweepIntervalMs = 60 * 60 * 1000;
    if (this.now() - this.lastSweepAt < sweepIntervalMs) return;
    this.sweep();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
