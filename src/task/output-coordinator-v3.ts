import { copyFile, mkdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { SYSTEM_CLOCK, isTaskTerminal } from '@qqbot/contracts';
import type {
  DeepReadonly,
  DeliveryResult,
  FrontendReply,
  MessageQueue,
  ReplyCandidate,
  ReplyPolicy,
  TaskBudget,
  TaskClock,
  TaskLifeCycleManagerV3,
  TaskSnapshotV3,
  WorkerReceipt,
  OutgoingAttachment,
} from '@qqbot/contracts';
import { renderReplyText, renderReference } from '../content/index.js';
import { originalSlices, prepareRecordDelivery } from '../delivery/record.js';

type Task = DeepReadonly<TaskSnapshotV3>;
interface OutputOptions {
  manager: TaskLifeCycleManagerV3;
  queue: MessageQueue;
  budget: TaskBudget;
  filesDir: string;
  maxChars: (task: Task) => number;
  policy?: (task: Task) => ReplyPolicy;
  maxFileBytes?: number;
  clock?: TaskClock;
  reminderMs?: number;
  onDelivered?: (candidate: DeepReadonly<ReplyCandidate>, ts: number) => void;
  onBudgetSettled?: (taskId: string, outcome: 'committed' | 'released') => void;
}

/** 前台固定回复的交付出口；worker 原始结果只作为保存材料。 */
export class SessionOutputCoordinatorV3 {
  private readonly clock: TaskClock;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reminded = new Set<string>();
  private readonly unsubscribe: (() => void)[];
  constructor(private readonly options: OutputOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.unsubscribe = [
      options.manager.onChange((task) => {
        this.reconcile(task.taskId);
        this.scheduleReminder(task);
      }),
      options.queue.onDelivery((result, candidate) => {
        this.recordDelivery(result, candidate);
      }),
    ];
  }

  async accept(task: Task, reply: DeepReadonly<FrontendReply>): Promise<void> {
    const groupId = `${reply.replyId}:delivery`;
    if (
      this.options.queue
        .messages(task.taskId)
        .some((r) => r.candidate.delivery?.groupId === groupId)
    )
      return;
    const policy = this.options.policy?.(task);
    const textFormat = policy?.textFormat;
    const text = renderReplyText(reply.text, textFormat);
    if (!text) throw new Error('前台回复正文为空');
    const base: ReplyCandidate = {
      trace: task.input.trace,
      taskId: task.taskId,
      lane: 'fast',
      message: task.input.message,
      reference: task.input.reference,
      quote: true,
      mention: replyMention(task, reply),
      text: '',
      kind: task.finalStatus === 'failed' ? 'error' : 'final',
    };
    const attachments = reply.attachments ?? [];
    const candidates = policy?.record
      ? await prepareRecordDelivery(
          base,
          reply.replyId,
          originalSlices(text, policy.maxChars).map((text, index) => ({ text, index })),
          attachments,
          { filesDir: this.options.filesDir, maxFileBytes: this.options.maxFileBytes, policy }
        )
      : await this.prepareLegacyDelivery(task, base, reply.replyId, text, attachments);
    const entries = candidates.map((candidate, index) => ({
      id: `${groupId}:${index}`,
      candidate: {
        ...candidate,
        body: candidate.body ? { ...candidate.body, textFormat: textFormat ?? 'plain' } : undefined,
        delivery: { groupId, index },
      },
    }));
    if (!this.options.queue.enqueueGroup) throw new Error('V3 交付需要支持整组保存的消息队列');
    this.options.queue.enqueueGroup(entries);
  }

  /** 仅在保存派发回执后尝试；窗口或通道忙时立即放弃。 */
  acknowledge(task: Task, receipt: DeepReadonly<WorkerReceipt>): void {
    const text = task.worker?.handoff.assignment.acknowledgement;
    if (!text?.trim() || task.cancelAccepted) return;
    const id = `${receipt.workerId}:acknowledgement`;
    if (this.options.queue.messages(task.taskId).some((row) => row.id === id)) return;
    const candidate: ReplyCandidate = {
      trace: task.input.trace,
      taskId: task.taskId,
      lane: 'fast',
      message: task.input.message,
      reference: task.input.reference,
      quote: true,
      text,
      kind: 'progress',
      immediateOnly: true,
    };
    if (this.options.queue.canSend(candidate)) this.options.queue.enqueue(candidate, id);
  }

  private async prepareLegacyDelivery(
    task: Task,
    base: ReplyCandidate,
    replyId: string,
    text: string,
    attachments: readonly OutgoingAttachment[]
  ): Promise<ReplyCandidate[]> {
    const reference = task.input.reference;
    const prefix = reference.messageId ? '' : renderReference(reference);
    const body = prefix ? `${prefix}\n${text}` : text;
    const candidates: ReplyCandidate[] = originalSlices(body, this.options.maxChars(task)).map(
      (text, index) => ({
        ...base,
        text,
        mention: index === 0 ? base.mention : undefined,
        body: { id: replyId, index },
      })
    );
    const directory = join(this.options.filesDir, task.taskId);
    if (attachments.length) await mkdir(directory, { recursive: true });
    for (const [index, attachment] of attachments.entries()) {
      const source = await stat(attachment.absPath);
      if (!source.isFile() || source.size > (this.options.maxFileBytes ?? Infinity))
        throw new Error('交付附件无效或超过容量');
      const absPath = join(
        directory,
        `${createHash('sha256').update(`${replyId}:${index}`).digest('hex')}-${basename(attachment.fileName)}`
      );
      await copyFile(attachment.absPath, absPath);
      const { size: sizeBytes } = await stat(absPath);
      if (sizeBytes > (this.options.maxFileBytes ?? Infinity)) throw new Error('交付附件超过容量');
      candidates.push(
        {
          ...base,
          mention: undefined,
          text: `附件「${attachment.fileName}」${renderReference(reference)}。`,
        },
        {
          ...base,
          mention: undefined,
          quote: false,
          text: '',
          attachment: { ...attachment, absPath, sizeBytes },
        }
      );
    }
    return candidates;
  }

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

  private recordDelivery(
    result: DeepReadonly<DeliveryResult>,
    candidate: DeepReadonly<ReplyCandidate>
  ): void {
    if (result.status === 'sent' && result.deliveredAt !== undefined) {
      this.options.onDelivered?.(candidate, result.deliveredAt);
      const task = this.options.manager.get(result.taskId);
      if (task) this.scheduleReminder(task);
    }
    this.reconcile(result.taskId);
  }

  private scheduleReminder(task: Task): void {
    const worker = runningWorker(task);
    if (!worker) {
      this.forget(task.taskId);
      return;
    }
    const id = `${worker.receipt.workerId}:reminder`;
    const acknowledgement = this.options.queue
      .messages(task.taskId)
      .find(
        (row) => row.id === `${worker.receipt.workerId}:acknowledgement` && row.status === 'sent'
      );
    if (
      acknowledgement?.finishedAt === undefined ||
      this.timers.has(task.taskId) ||
      this.reminded.has(task.taskId) ||
      this.options.queue.messages(task.taskId).some((row) => row.id === id)
    )
      return;
    const due =
      Math.max(acknowledgement.finishedAt, worker.startedAt ?? acknowledgement.finishedAt) +
      (this.options.reminderMs ?? 300_000);
    this.timers.set(
      task.taskId,
      this.clock.setTimeout(
        () => {
          this.timers.delete(task.taskId);
          this.reminded.add(task.taskId);
          this.sendReminder(task.taskId, id);
        },
        Math.max(0, due - this.clock.now())
      )
    );
  }

  private sendReminder(taskId: string, id: string): void {
    const current = this.options.manager.get(taskId);
    if (!current || !runningWorker(current)) return;
    const candidate: ReplyCandidate = {
      trace: current.input.trace,
      taskId,
      lane: 'fast',
      message: current.input.message,
      reference: current.input.reference,
      text: '这项任务还在执行，完成后会把结果发到这里。',
      kind: 'progress',
      immediateOnly: true,
    };
    if (this.options.queue.canSend(candidate)) this.options.queue.enqueue(candidate, id);
  }

  forget(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) this.clock.clearTimeout(timer);
    this.timers.delete(taskId);
    this.reminded.delete(taskId);
  }
  close(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    for (const id of this.timers.keys()) this.forget(id);
  }
}

/** 强烈提醒仅定向真实原作者；普通回复沿用原引用。 */
function replyMention(task: Task, reply: DeepReadonly<FrontendReply>): string | undefined {
  const reference = task.input.reference;
  if (
    reply.attention !== 'strong' ||
    task.input.message.target.kind !== 'group' ||
    !reference.messageId
  )
    return undefined;
  return reference.senderId === task.input.message.senderId ? reference.senderId : undefined;
}

function runningWorker(task: Task): Task['worker'] {
  const worker = task.worker;
  return worker && !task.cancelAccepted && worker.receipt.status === 'running' && !worker.result
    ? worker
    : undefined;
}
