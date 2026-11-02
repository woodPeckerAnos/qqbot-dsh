/**
 * Task 产物出口：正文规范化与精确去重、原消息引用、可靠附件副本、一次性提醒。
 * 只负责形成候选消息并入队，不持有平台发送锁，也不改写 Task 执行状态。
 * 管理器和队列变化共同触发预算结算，执行结束与投递结束分别判断。
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeWhitespace, stripControlChars } from '../pipeline/markdown.js';
import { segmentText } from '../pipeline/egress/chunk.js';
import type { TaskBudget } from './budget.js';
import { SYSTEM_CLOCK, type TaskClock } from './clock.js';
import type { TaskLifeCycleManager } from './lifecycle.js';
import type { MessageQueue } from './message-queue.js';
import {
  isTaskTerminal,
  type DeliveryResult,
  type Lane,
  type LaneResult,
  type ReplyCandidate,
  type TaskSnapshot,
} from './types.js';

export class SessionOutputCoordinator {
  private readonly texts = new Map<string, Set<string>>();
  private readonly fastSent = new Map<string, number>();
  private readonly reminded = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly clock: TaskClock;
  private readonly unsubscribe: (() => void)[];
  constructor(
    private readonly options: {
      manager: TaskLifeCycleManager;
      queue: MessageQueue;
      budget: TaskBudget;
      filesDir: string;
      maxChars: (task: Readonly<TaskSnapshot>) => number;
      clock?: TaskClock;
      reminderMs?: number;
      onDelivered?: (candidate: Readonly<ReplyCandidate>, ts: number) => void;
      onBudgetSettled?: (taskId: string, outcome: 'committed' | 'released') => void;
    }
  ) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.unsubscribe = [
      options.manager.onChange((task) => {
        this.reconcile(task.taskId);
        this.scheduleReminder(task);
      }),
      options.queue.onDelivery((result, candidate) => this.onDelivery(result, candidate)),
    ];
    for (const row of options.queue.messages()) {
      const texts = this.texts.get(row.candidate.taskId) ?? new Set<string>();
      // Body identity is also reconstructed below by accepting the same result chunks.
      texts.add(row.candidate.text);
      this.texts.set(row.candidate.taskId, texts);
    }
  }
  /** runner 已验证静默契约；不同 lane 的不同正文分别保留，附件不参与正文去重。 */
  async accept(
    task: Readonly<TaskSnapshot>,
    lane: Lane,
    result: LaneResult,
    resultId?: string
  ): Promise<void> {
    if (result.kind === 'silent') return;
    const text =
      result.kind === 'reply' || result.kind === 'failed'
        ? normalizeWhitespace(stripControlChars(result.text)).trim()
        : '';
    const kind = result.kind === 'failed' ? 'error' : 'final';
    const reference = task.input.reference;
    const quote =
      lane === 'slow' ||
      task.input.source === 'proactive' ||
      this.clock.now() - task.createdAt >= 30_000;
    const base = {
      taskId: task.taskId,
      lane,
      message: task.input.message,
      reference,
      quote,
      kind,
    } as const;
    const seen = this.texts.get(task.taskId) ?? new Set<string>();
    this.texts.set(task.taskId, seen);
    if (text && !seen.has(text)) {
      seen.add(text);
      let i = 0;
      const spokenText =
        quote && !reference.messageId
          ? `（关于 ${reference.senderName ?? reference.senderId} 的「${reference.excerpt.slice(0, 120)}」）\n${text}`
          : text;
      for (const part of segmentText(spokenText, {
        maxChars: this.options.maxChars(task),
        maxSegments: Math.max(1, spokenText.length),
      }).segments)
        this.options.queue.enqueue(
          { ...base, text: part },
          resultId ? `${resultId}:text:${i++}` : undefined
        );
    }
    for (const attachment of result.attachments ?? []) {
      // 先复制到队列专属目录，Task 工作区到期清理后待发附件仍能取到字节。
      const directory = join(this.options.filesDir, task.taskId);
      await mkdir(directory, { recursive: true });
      const absPath = join(directory, `${lane}-${randomUUID()}-${basename(attachment.fileName)}`);
      await copyFile(attachment.absPath, absPath);
      const ref = task.input.reference;
      this.options.queue.enqueue({
        ...base,
        text: `附件「${attachment.fileName}」对应 ${ref.senderName ?? ref.senderId} 的「${ref.excerpt.slice(0, 100)}」。`,
        reference: ref,
      });
      this.options.queue.enqueue({
        ...base,
        text: '',
        attachment: { ...attachment, absPath },
        reference: task.input.reference,
      });
    }
  }
  /** 任一送达即可提交；释放则必须同时满足执行结束与所有消息均终结未成功。 */
  reconcile(taskId: string): void {
    const task = this.options.manager.get(taskId);
    const delivery = this.options.queue.taskDelivery(taskId);
    if (task && isTaskTerminal(task)) this.options.budget.finish(taskId);
    const settled = this.options.budget.settle(
      taskId,
      delivery.success,
      !!this.options.budget.get(taskId)?.executionFinished && !delivery.pending
    );
    if (settled) this.options.onBudgetSettled?.(taskId, settled);
  }
  close(): void {
    this.unsubscribe.forEach((fn) => fn());
    this.timers.forEach((t) => this.clock.clearTimeout(t));
    this.timers.clear();
  }
  /** 只回收协调器缓存和提醒，保留队列拥有的消息及附件。 */
  forget(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) this.clock.clearTimeout(timer);
    this.timers.delete(taskId);
    this.texts.delete(taskId);
    this.fastSent.delete(taskId);
    this.reminded.delete(taskId);
  }
  private onDelivery(result: DeliveryResult, candidate: Readonly<ReplyCandidate>): void {
    if (result.status === 'sent') {
      // 先保存实际送达内容，再触发预算回调，主动 adapter 才能记录真实发言。
      this.options.onDelivered?.(candidate, result.deliveredAt!);
      if (
        candidate.lane === 'fast' &&
        candidate.kind === 'final' &&
        !candidate.notification &&
        !candidate.attachment &&
        candidate.text
      ) {
        if (!this.fastSent.has(candidate.taskId))
          this.fastSent.set(candidate.taskId, result.deliveredAt!);
        const task = this.options.manager.get(candidate.taskId);
        if (task) this.scheduleReminder(task);
      }
    }
    this.reconcile(result.taskId);
  }
  /** 从快回复送达与慢执行开始的较晚时刻计时；结束、取消或无即时出口均放弃。 */
  private scheduleReminder(task: Readonly<TaskSnapshot>): void {
    const fastSent = this.fastSent.get(task.taskId);
    const slow = task.lanes.slow;
    if (slow.status !== 'running' || slow.executionEndedAt !== undefined) {
      const timer = this.timers.get(task.taskId);
      if (timer) this.clock.clearTimeout(timer);
      this.timers.delete(task.taskId);
      return;
    }
    if (
      fastSent === undefined ||
      slow.startedAt === undefined ||
      this.reminded.has(task.taskId) ||
      this.timers.has(task.taskId)
    )
      return;
    const due = Math.max(fastSent, slow.startedAt) + (this.options.reminderMs ?? 300_000);
    this.timers.set(
      task.taskId,
      this.clock.setTimeout(
        () => {
          this.timers.delete(task.taskId);
          this.reminded.add(task.taskId);
          const current = this.options.manager.get(task.taskId);
          if (
            !current ||
            current.cancelAccepted ||
            current.lanes.slow.status !== 'running' ||
            current.lanes.slow.executionEndedAt !== undefined
          )
            return;
          const candidate: ReplyCandidate = {
            taskId: task.taskId,
            lane: 'slow',
            message: task.input.message,
            reference: task.input.reference,
            text: '这项任务还在执行，完成后会把结果发到这里。',
            kind: 'progress',
            immediateOnly: true,
          };
          if (this.options.queue.canSend(candidate)) this.options.queue.enqueue(candidate);
        },
        Math.max(0, due - this.clock.now())
      )
    );
  }
}
