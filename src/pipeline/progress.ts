/**
 * 回复配额账本与进度回执调度。
 *
 * 这是整个系统里最"产品化"的一块，因为 QQ 群的硬约束非常紧：
 *
 *   - 被动回复窗口 **5 分钟**（超过后消息发不出去）；
 *   - 每条用户消息最多回复 **5 次**；
 *   - 同一 `(msg_id, msg_seq)` 组合重复发送会被平台去重（40054005）。
 *
 * 所以必须把"回复次数"当成稀缺资源来分配：
 *
 *   总额配 = maxRepliesPerMsg（默认 4，官方硬上限 5，留 1 条机动）
 *   ├─ 进度回执：最多 progressMax 条（默认 3）
 *   └─ 最终答案：至少 1 条，剩余额度可用于分段
 *
 * 时间线（默认值）：
 *
 *   t=0      收到提问，开始 turn
 *   t=90s    第 1 条进度回执
 *   t=180s   第 2 条
 *   t=270s   第 3 条
 *   t≤295s   最终答案（若已用 k 条进度，还剩 4-k 条用于分段）
 *
 * `msg_seq` 一律由本账本分配，调用方不得自己拼——这是保证去重不误伤的唯一办法。
 */

import type { Logger } from '../logger.js';

export interface ReplyLedgerOptions {
  msgId: string;
  /** 总额配（含进度回执） */
  totalQuota: number;
  /** 进度回执条数上限，必须 < totalQuota */
  progressQuota: number;
}

export type ReplyKind = 'progress' | 'final' | 'error';

export interface ReplyTicket {
  kind: ReplyKind;
  /** 分配给本条消息的 msg_seq（从 1 开始单调递增） */
  msgSeq: number;
  /** 分配后剩余的配额 */
  remaining: number;
}

export class ReplyQuotaExhaustedError extends Error {
  constructor(
    readonly kind: ReplyKind,
    readonly used: number,
    readonly total: number,
  ) {
    super(`回复配额已用尽（${used}/${total}），无法再发送 ${kind} 消息`);
    this.name = 'ReplyQuotaExhaustedError';
  }
}

export class ReplyLedger {
  private readonly usedSeq: number[] = [];
  private sentCount = 0;
  private progressCount = 0;
  private nextSeq = 1;

  constructor(private readonly options: ReplyLedgerOptions) {
    if (options.progressQuota >= options.totalQuota) {
      throw new Error('progressQuota 必须小于 totalQuota，否则最终答案没有配额');
    }
  }

  get total(): number {
    return this.options.totalQuota;
  }

  get sent(): number {
    return this.sentCount;
  }

  get progressSent(): number {
    return this.progressCount;
  }

  /** 还能发几条 */
  get remaining(): number {
    return Math.max(0, this.options.totalQuota - this.sentCount);
  }

  /** 还能发几条进度回执 */
  get progressRemaining(): number {
    return Math.max(0, this.options.progressQuota - this.progressCount);
  }

  /** 是否还能发最终答案（必须至少留 1 条） */
  get canSendFinal(): boolean {
    return this.remaining > 0;
  }

  /** 已用掉的 msg_seq 列表（测试与诊断用） */
  get usedSequences(): readonly number[] {
    return this.usedSeq;
  }

  /**
   * 分配一张回复票。
   * @throws ReplyQuotaExhaustedError 配额不足时抛出，调用方应转为"截断/放弃"路径
   */
  allocate(kind: ReplyKind): ReplyTicket {
    if (kind === 'progress') {
      if (this.progressCount >= this.options.progressQuota) {
        throw new ReplyQuotaExhaustedError(kind, this.progressCount, this.options.progressQuota);
      }
      // 进度回执绝不能吃掉最终答案的配额
      if (this.remaining <= 1) {
        throw new ReplyQuotaExhaustedError(kind, this.sentCount, this.options.totalQuota);
      }
    } else if (this.remaining <= 0) {
      throw new ReplyQuotaExhaustedError(kind, this.sentCount, this.options.totalQuota);
    }

    const msgSeq = this.nextSeq;
    this.nextSeq += 1;
    this.usedSeq.push(msgSeq);
    this.sentCount += 1;
    if (kind === 'progress') this.progressCount += 1;

    return { kind, msgSeq, remaining: this.remaining };
  }
}

// ---------------------------------------------------------------------------
// 进度回执调度
// ---------------------------------------------------------------------------

export interface ProgressSchedulerOptions {
  /** turn 开始后多久发第一条进度回执 */
  afterMs: number;
  /** 之后的间隔 */
  intervalMs: number;
  /** 进度文本生成器，可拿到已用时长 */
  renderText: (elapsedMs: number) => string;
  /** 实际发送动作 */
  send: (text: string) => Promise<void>;
  /** 取票（配额不足时返回 undefined 表示不再发进度） */
  allocateTicket: () => ReplyTicket | undefined;
  logger: Logger;
  now?: () => number;
}

/**
 * 进度回执调度器：由外部在收到事件时调用 `tick()`，或让它自己起定时器。
 * 用显式定时器而不是轮询，避免与事件处理耦合。
 */
export class ProgressScheduler {
  private timer: NodeJS.Timeout | undefined;
  private startedAt: number;
  private sentProgress = 0;
  private stopped = false;
  private lastError: unknown;

  constructor(private readonly options: ProgressSchedulerOptions) {
    this.startedAt = this.now();
  }

  get count(): number {
    return this.sentProgress;
  }

  get failure(): unknown {
    return this.lastError;
  }

  /** 启动调度。幂等。 */
  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setTimeout(() => {
      void this.fire();
    }, this.options.afterMs);
    this.timer.unref?.();
  }

  /** 停止调度（turn 结束时调用）。 */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async fire(): Promise<void> {
    this.timer = undefined;
    if (this.stopped) return;

    const ticket = this.options.allocateTicket();
    if (ticket === undefined) {
      this.options.logger.debug('进度回执配额已用尽，停止调度');
      return;
    }

    const elapsed = this.now() - this.startedAt;
    try {
      await this.options.send(this.options.renderText(elapsed));
      this.sentProgress += 1;
    } catch (error) {
      // 进度回执失败不致命（例如配额被平台判超限），记录后继续等最终答案
      this.lastError = error;
      this.options.logger.warn('发送进度回执失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!this.stopped) {
      this.timer = setTimeout(() => {
        void this.fire();
      }, this.options.intervalMs);
      this.timer.unref?.();
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** 默认进度文案。 */
export function defaultProgressText(elapsedMs: number, toolsInvoked: number): string {
  const seconds = Math.round(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const timeText = minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  const toolText = toolsInvoked > 0 ? `，已执行 ${toolsInvoked} 个操作` : '';
  return `仍在处理中（已用 ${timeText}${toolText}）…`;
}
