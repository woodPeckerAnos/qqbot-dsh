import type { DeepReadonly } from '@qqbot/contracts';
/**
 * Task 产物出口：正文规范化与精确去重、原消息引用、可靠附件副本、一次性提醒。
 * 只负责形成候选消息并入队，不持有平台发送锁，也不改写 Task 执行状态。
 * 管理器和队列变化共同触发预算结算，执行结束与投递结束分别判断。
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { originalSlices, prepareRecordDelivery } from '../delivery/record.js';
import type { ReplyPolicy } from '@qqbot/contracts';
import { traceSpan, legacyTrace } from '../observability/index.js';
import { createHash } from 'node:crypto';
import { normalizeWhitespace, stripControlChars } from '../content/index.js';
import { segmentText } from '../content/index.js';
import type { TaskBudget } from '@qqbot/contracts';
import { SYSTEM_CLOCK } from '@qqbot/contracts';
import type { TaskClock } from '@qqbot/contracts';
import type { TaskLifeCycleManagerV3 as TaskLifeCycleManager } from '@qqbot/contracts';
import type { MessageQueue } from '@qqbot/contracts';
import { isTaskTerminal } from '@qqbot/contracts';
import type {
  DeliveryResult,
  Lane,
  LaneResultV3 as LaneResult,
  ReplyCandidate,
  QueuedMessage,
  TaskSnapshotV3 as TaskSnapshot,
} from '@qqbot/contracts';

/** Match each successfully delivered occurrence once, preserving repeated segments. */
function deliveredBodyCounts(rows: DeepReadonly<QueuedMessage[]>, lane: Lane): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const candidate = row.candidate;
    if (
      row.status !== 'sent' ||
      candidate.lane === lane ||
      !candidate.body ||
      candidate.notification ||
      candidate.attachment
    )
      continue;
    for (const part of candidate.body.segments ?? [{ text: candidate.text }])
      counts.set(part.text, (counts.get(part.text) ?? 0) + 1);
  }
  return counts;
}
function consumeDeliveredBody(counts: Map<string, number>, text: string): boolean {
  const remaining = counts.get(text) ?? 0;
  if (!remaining) return false;
  counts.set(text, remaining - 1);
  return true;
}

export class SessionOutputCoordinator {
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
      maxChars: (task: DeepReadonly<TaskSnapshot>) => number;
      policy?: (task: DeepReadonly<TaskSnapshot>) => ReplyPolicy;
      maxFileBytes?: number;
      clock?: TaskClock;
      reminderMs?: number;
      onDelivered?: (candidate: DeepReadonly<ReplyCandidate>, ts: number) => void;
      onBudgetSettled?: (taskId: string, outcome: 'committed' | 'released') => void;
    }
  ) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.unsubscribe = [
      options.manager.onChange((task) => {
        this.reconcile(task.taskId);
        this.scheduleReminder(task);
      }),
      options.queue.onDelivery((result, candidate) => {
        this.onDelivery(result, candidate);
      }),
    ];
  }
  /** runner 已完成协作闸门；跨 lane 去重只依据成功送达原始正文，附件独立幂等。 */
  async accept(
    task: DeepReadonly<TaskSnapshot>,
    lane: Lane,
    result: LaneResult,
    resultId?: string
  ): Promise<void> {
    if (result.kind === 'silent') return;
    if (this.suppressSlowError(task, lane, result) && result.kind === 'failed')
      result = { ...result, text: result.requiredExplanation ?? '', attention: undefined };
    const policy = this.options.policy?.(task);
    if (policy?.record) {
      await this.acceptRecordCapable(task, lane, result, policy, resultId);
      return;
    }
    await this.acceptLegacy(task, lane, result, resultId);
  }
  private suppressSlowError(
    task: DeepReadonly<TaskSnapshot>,
    lane: Lane,
    result: LaneResult
  ): boolean {
    if (task.input.source !== 'proactive' || lane !== 'slow' || result.kind !== 'failed')
      return false;
    const fast = this.options.manager.get(task.taskId)?.lanes.fast ?? task.lanes.fast;
    if (fast.status !== 'completed' || fast.result?.kind !== 'reply') return false;
    const bodies = this.options.queue
      .messages(task.taskId)
      .filter(
        (row) =>
          row.candidate.lane === 'fast' &&
          row.candidate.body &&
          !row.candidate.notification &&
          !row.candidate.attachment
      );
    return (
      bodies.some((row) =>
        (row.candidate.body?.segments ?? [{ text: row.candidate.text }]).some((p) => !!p.text)
      ) && bodies.every((row) => row.status === 'sent')
    );
  }
  private mention(task: DeepReadonly<TaskSnapshot>, result: LaneResult): string | undefined {
    const ref = task.input.reference;
    if (
      result.attention !== 'strong' ||
      task.input.message.target.kind !== 'group' ||
      !ref.messageId ||
      !ref.senderId ||
      ref.senderId !== task.input.message.senderId
    )
      return undefined;
    return this.options.queue
      .messages(task.taskId)
      .some((row) => row.candidate.mention === ref.senderId)
      ? undefined
      : ref.senderId;
  }
  private async acceptLegacy(
    task: DeepReadonly<TaskSnapshot>,
    lane: Lane,
    result: Exclude<LaneResult, { kind: 'silent' }>,
    resultId?: string
  ): Promise<void> {
    const text =
      result.kind === 'reply' || result.kind === 'failed'
        ? normalizeWhitespace(stripControlChars(result.text)).trim()
        : '';
    const kind = result.kind === 'failed' ? 'error' : 'final';
    const reference = task.input.reference;
    const quote = true;
    const current = this.options.manager.get(task.taskId);
    const trace =
      result.trace ??
      traceSpan(
        current?.lanes[lane].trace ??
          task.lanes[lane].trace ??
          task.input.trace ??
          legacyTrace(task.taskId),
        { lane }
      );
    const base = {
      trace,
      taskId: task.taskId,
      lane,
      message: task.input.message,
      reference,
      quote,
      kind,
    } as const;
    const bodyId = `${task.taskId}:${lane}:body:${resultId ?? createHash('sha256').update(text).digest('hex')}`;
    if (text) {
      let i = 0;
      let mention = this.mention(task, result);
      const spokenText = !reference.messageId
        ? `（关于 ${reference.senderName ?? reference.senderId} 的「${reference.excerpt.slice(0, 120)}」）\n${text}`
        : text;
      const delivered = deliveredBodyCounts(this.options.queue.messages(task.taskId), lane);
      for (const part of segmentText(spokenText, {
        maxChars: this.options.maxChars(task),
        maxSegments: Math.max(1, spokenText.length),
      }).segments) {
        const index = i++;
        if (!consumeDeliveredBody(delivered, part)) {
          this.options.queue.enqueue(
            { ...base, mention, text: part, body: { id: bodyId, index } },
            `${bodyId}:text:${index}`
          );
          mention = undefined;
        }
      }
    }
    for (const [index, attachment] of (result.attachments ?? []).entries()) {
      const attachmentId = `${bodyId}:attachment:${index}`;
      if (this.options.queue.messages(task.taskId).some((row) => row.id === attachmentId)) continue;
      // 先复制到队列专属目录，Task 工作区到期清理后待发附件仍能取到字节。
      const directory = join(this.options.filesDir, task.taskId);
      await mkdir(directory, { recursive: true });
      const absPath = join(
        directory,
        `${lane}-${createHash('sha256').update(attachmentId).digest('hex')}-${basename(attachment.fileName)}`
      );
      await copyFile(attachment.absPath, absPath);
      const ref = task.input.reference;
      this.options.queue.enqueue(
        {
          ...base,
          text: `附件「${attachment.fileName}」对应 ${ref.senderName ?? ref.senderId} 的「${ref.excerpt.slice(0, 100)}」。`,
          reference: ref,
        },
        `${attachmentId}:description`
      );
      this.options.queue.enqueue(
        {
          ...base,
          text: '',
          attachment: { ...attachment, absPath },
          reference: task.input.reference,
        },
        attachmentId
      );
    }
  }
  private async acceptRecordCapable(
    task: DeepReadonly<TaskSnapshot>,
    lane: Lane,
    result: Exclude<LaneResult, { kind: 'silent' }>,
    policy: ReplyPolicy,
    resultId?: string
  ): Promise<void> {
    const text = result.kind === 'reply' || result.kind === 'failed' ? result.text.trim() : '';
    const bodyId = `${task.taskId}:${lane}:body:${resultId ?? createHash('sha256').update(text).digest('hex')}`;
    // Stable original slices are chosen before deduplication or wrapping. Never repair fences or drop separators.
    const delivered = deliveredBodyCounts(this.options.queue.messages(task.taskId), lane);
    const parts = originalSlices(text, policy.maxChars)
      .map((text, index) => ({ text, index }))
      .filter((part) => !consumeDeliveredBody(delivered, part.text));
    const body = parts.map((part) => part.text).join('');
    const attachments = result.attachments ?? [];
    if (!body && !attachments.length) return;
    const groupId = `${bodyId}:delivery`;
    if (
      this.options.queue
        .messages(task.taskId)
        .some((row) => row.candidate.delivery?.groupId === groupId)
    )
      return;
    const base = this.recordBase(task, lane, result);
    const candidates = await prepareRecordDelivery(base, bodyId, parts, attachments, {
      filesDir: this.options.filesDir,
      maxFileBytes: this.options.maxFileBytes,
      policy,
    });
    const entries = candidates.map((candidate, index) => ({
      candidate: { ...candidate, delivery: { groupId, index } },
      id: `${groupId}:${index}`,
    }));
    if (this.options.queue.enqueueGroup) this.options.queue.enqueueGroup(entries);
    else entries.forEach(({ candidate, id }) => this.options.queue.enqueue(candidate, id));
  }
  private recordBase(
    task: DeepReadonly<TaskSnapshot>,
    lane: Lane,
    result: LaneResult
  ): ReplyCandidate {
    return {
      trace: result.trace ?? task.lanes[lane].trace ?? task.input.trace ?? legacyTrace(task.taskId),
      taskId: task.taskId,
      lane,
      message: task.input.message,
      reference: task.input.reference,
      quote: true,
      mention: this.mention(task, result),
      text: '',
      kind: result.kind === 'failed' ? 'error' : 'final',
    };
  }
  /** 任一送达即可提交；释放则必须同时满足执行结束与所有消息均终结未成功。 */
  reconcile(taskId: string): void {
    const task = this.options.manager.get(taskId);
    const delivery = this.options.queue.taskDelivery(taskId);
    if (!task || isTaskTerminal(task)) this.options.budget.finish(taskId);
    const settled = this.options.budget.settle(
      taskId,
      delivery.success,
      !!this.options.budget.get(taskId)?.executionFinished && !delivery.pending
    );
    if (settled) this.options.onBudgetSettled?.(taskId, settled);
  }
  close(): void {
    this.unsubscribe.forEach((fn) => {
      fn();
    });
    this.timers.forEach((t) => {
      this.clock.clearTimeout(t);
    });
    this.timers.clear();
  }
  /** 只回收协调器缓存和提醒，保留队列拥有的消息及附件。 */
  forget(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) this.clock.clearTimeout(timer);
    this.timers.delete(taskId);
    this.fastSent.delete(taskId);
    this.reminded.delete(taskId);
  }
  private onDelivery(
    result: DeepReadonly<DeliveryResult>,
    candidate: DeepReadonly<ReplyCandidate>
  ): void {
    const deliveredAt = result.deliveredAt;
    if (result.status === 'sent' && deliveredAt !== undefined) {
      // 先保存实际送达内容，再触发预算回调，主动 adapter 才能记录真实发言。
      this.options.onDelivered?.(candidate, deliveredAt);
      if (isFastBody(candidate)) {
        if (!this.fastSent.has(candidate.taskId)) this.fastSent.set(candidate.taskId, deliveredAt);
        const task = this.options.manager.get(candidate.taskId);
        if (task) this.scheduleReminder(task);
      }
    }
    this.reconcile(result.taskId);
  }
  /** 从快回复送达与慢执行开始的较晚时刻计时；结束、取消或无即时出口均放弃。 */
  private scheduleReminder(task: DeepReadonly<TaskSnapshot>): void {
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
            trace: current.lanes.slow.trace ?? current.input.trace ?? legacyTrace(task.taskId),
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

function isFastBody(candidate: DeepReadonly<ReplyCandidate>): boolean {
  return (
    candidate.lane === 'fast' &&
    candidate.kind === 'final' &&
    !candidate.notification &&
    !!candidate.body &&
    !candidate.attachment &&
    !!candidate.text
  );
}
