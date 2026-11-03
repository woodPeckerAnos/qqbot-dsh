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
import type { Result } from '@qqbot/contracts';
import type { Logger } from '../logger.js';
import type { StorePaths } from './paths.js';
export interface SeenStoreOptions {
  paths: StorePaths;
  logger: Logger;
  /** 磁盘标记保留时长，默认 24 小时 */
  retentionMs?: number;
  /** 内存 LRU 容量 */
  memoryLimit?: number;
  now?: () => number;
}
export interface SeenStore {
  /**
   * 声明"我要处理这个事件"。
   * @returns true = 首次见到（调用方应处理）；false = 重复（调用方应丢弃）
   */
  claim(eventId: string): boolean;
  claimVolatile(eventId: string): boolean;
  /** 显式返回磁盘故障；claim兼容层负责现行内存降级策略。 */
  claimResult(eventId: string): Result<boolean>;
  /** 清理过期的磁盘标记。 */
  sweep(): number;
  get memorySize(): number;
}
export type createSeenStoreFactory = (options: SeenStoreOptions) => SeenStore;
