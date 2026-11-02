/**
 * 独立持久化的单次投递队列，也是平台锚点条数与 seq 的唯一账本。
 * 不查询 Task 是否仍在运行：尚未尝试的消息可等待合法出口，尝试失败则终结。
 * 文本和附件按 Session 使用不同通道，慢上传不占用快正文的发送通道。
 */
import { randomUUID } from 'node:crypto';
import type { BotConnector, NormalizedMessage, ReplyContext } from '../core/connector.js';
import type { Logger } from '../logger.js';
import type { TaskStore } from '../store/tasks.js';
import { SYSTEM_CLOCK, type TaskClock } from './clock.js';
import { readonlySnapshot, type DeliveryResult, type ReplyCandidate } from './types.js';

/** 发送前持久化 sending 和锚点；重启时该状态代表结果未知，禁止自动重发。 */
export interface QueuedMessage {
  id: string;
  candidate: ReplyCandidate;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'discarded';
  createdAt: number;
  attemptedAt?: number;
  finishedAt?: number;
  /** 实际发送使用的锚点，可能不同于 candidate.reference 的原消息。 */
  anchor?: { msgId: string; seq: number };
  error?: string;
  failureNoticeId?: string;
}
interface Route { connector: BotConnector; context: ReplyContext }
export class MessageQueue {
  private readonly records = new Map<string, QueuedMessage>();
  private readonly anchors = new Map<string, NormalizedMessage>();
  private readonly sequences = new Map<string, number>();
  private readonly sending = new Set<string>();
  private readonly listeners = new Set<(result: DeliveryResult, candidate: Readonly<ReplyCandidate>) => void>();
  private readonly clock: TaskClock;
  private closed = false;
  constructor(private readonly options: {
    connectors: ReadonlyMap<string, BotConnector>; store?: TaskStore<QueuedMessage>;
    logger: Logger; clock?: TaskClock; timeoutMs?: number;
    transport?: (connector: BotConnector, context: ReplyContext, candidate: ReplyCandidate) => Promise<void>;
  }) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    for (const record of options.store?.load() ?? []) {
      this.records.set(record.id, record);
      if (record.anchor) {
        const key = this.anchorKey(record.candidate.message, record.anchor.msgId);
        this.sequences.set(key, Math.max(this.sequences.get(key) ?? 0, record.anchor.seq));
      }
    }
    // 发送中消息的远端结果无法确认，恢复为失败并补一条通知，不重发原消息。
    for (const record of this.records.values()) if (record.status === 'sending') {
      record.status = 'failed'; record.error = '服务重启，发送结果无法确认'; record.finishedAt = this.clock.now();
    }
    for (const record of [...this.records.values()]) if (record.status === 'failed' && !record.candidate.notification && !record.failureNoticeId) this.failureNotice(record);
    this.persist();
  }
  onDelivery(fn: (result: DeliveryResult, candidate: Readonly<ReplyCandidate>) => void): () => void {
    this.listeners.add(fn); return () => { this.listeners.delete(fn); };
  }
  /** 新输入只提供更新的合法出口，不把已失败的消息重新变成待发送。 */
  observe(message: NormalizedMessage): void {
    if (message.msgId && (!this.anchors.get(message.target.key) || this.anchors.get(message.target.key)!.ts <= message.ts)) this.anchors.set(message.target.key, structuredClone(message));
    this.wake();
  }
  /** 先落盘再唤醒发送；固定 ID 供恢复产物幂等入队。 */
  enqueue(candidate: ReplyCandidate, id: string = randomUUID()): string {
    if (this.closed) throw new Error('消息队列已关闭');
    if (this.records.has(id)) return id;
    const record: QueuedMessage = { id, candidate: structuredClone(candidate), status: 'pending', createdAt: this.clock.now() };
    if (candidate.immediateOnly && !this.route(candidate, false)) {
      record.status = 'discarded'; record.finishedAt = this.clock.now();
    }
    this.records.set(id, record);
    try { this.persist(); } catch (error) { this.records.delete(id); throw error; }
    if (record.status === 'discarded') this.publish(record);
    this.wake(); return id;
  }
  canSend(candidate: ReplyCandidate): boolean { return !!this.route(candidate, false); }
  messages(taskId?: string): Readonly<QueuedMessage>[] {
    return [...this.records.values()].filter(r => !taskId || r.candidate.taskId === taskId).map(readonlySnapshot);
  }
  /** 给预算结算聚合所有产物，正文、附件、提醒和失败通知都属于同一 Task。 */
  taskDelivery(taskId: string): { success: boolean; pending: boolean; count: number } {
    const rows = [...this.records.values()].filter(r => r.candidate.taskId === taskId);
    return { success: rows.some(r => r.status === 'sent'), pending: rows.some(r => r.status === 'pending' || r.status === 'sending'), count: rows.length };
  }
  snapshot() {
    const rows = [...this.records.values()];
    return { pending: rows.filter(r => r.status === 'pending').length, sending: rows.filter(r => r.status === 'sending').length, sent: rows.filter(r => r.status === 'sent').length, failed: rows.filter(r => r.status === 'failed').length };
  }
  wake(): void { queueMicrotask(() => this.pump()); }
  close(): void { this.closed = true; }
  private anchorKey(message: NormalizedMessage, msgId: string): string { return `${message.target.key}\u0000${msgId}`; }
  /** canSend 只探测；实际尝试才预留 seq，原锚点失效后可使用最新有效锚点。 */
  private route(candidate: ReplyCandidate, reserve: boolean): Route | undefined {
    const message = candidate.message;
    const connector = this.options.connectors.get(message.target.platform);
    if (!connector || !(connector.canReply?.(message.target) ?? connector.health().connected)) return;
    const policy = connector.policy(message.target.kind);
    if (!Number.isFinite(policy.passiveWindowMs)) return { connector, context: { target: message.target, msgId: message.msgId || undefined, seq: 0, kind: candidate.kind } };
    const options = [message, this.anchors.get(message.target.key)].filter((m): m is NormalizedMessage => !!m);
    for (const anchor of options) {
      if (!anchor.msgId || this.clock.now() >= anchor.ts + policy.passiveWindowMs) continue;
      const key = this.anchorKey(message, anchor.msgId);
      const seq = (this.sequences.get(key) ?? 0) + 1;
      if (seq > policy.maxRepliesPerMsg) continue;
      if (reserve) this.sequences.set(key, seq);
      return { connector, context: { target: message.target, msgId: anchor.msgId, seq, kind: candidate.kind } };
    }
    return;
  }
  private channel(candidate: ReplyCandidate): string {
    // 上传与附件传输独立于短正文；平台 seq 仍由同一个队列同步分配。
    return `${candidate.message.target.key}:${candidate.attachment ? 'attachment' : 'text'}`;
  }
  private pump(): void {
    if (this.closed) return;
    for (const record of this.records.values()) {
      if (record.status !== 'pending') continue;
      const channel = this.channel(record.candidate);
      if (this.sending.has(channel)) {
        if (record.candidate.immediateOnly) { record.status = 'discarded'; record.finishedAt = this.clock.now(); this.persist(); this.publish(record); }
        continue;
      }
      const route = this.route(record.candidate, true);
      if (!route) {
        if (record.candidate.immediateOnly) { record.status = 'discarded'; record.finishedAt = this.clock.now(); this.persist(); this.publish(record); }
        continue;
      }
      record.status = 'sending'; record.attemptedAt = this.clock.now();
      if (record.candidate.quote === false && this.clock.now() - record.candidate.message.ts >= 30_000) record.candidate.quote = true;
      if (route.context.msgId) record.anchor = { msgId: route.context.msgId, seq: route.context.seq };
      // 必须先记录尝试再调用平台，崩溃后才能识别结果未知的消息。
      this.persist(); this.sending.add(channel);
      void this.send(record, route).finally(() => { this.sending.delete(channel); this.wake(); });
    }
  }
  /** 一次调用，无重试循环；超时后即使远端迟到成功，也不重新结算本消息。 */
  private async send(record: QueuedMessage, route: Route): Promise<void> {
    const controller = new AbortController();
    const context = { ...route.context, signal: controller.signal };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = Promise.resolve().then(() => this.options.transport
        ? this.options.transport(route.connector, context, record.candidate)
        : route.connector.reply(context, { text: record.candidate.text, reference: record.candidate.quote === false ? undefined : record.candidate.reference, ...(record.candidate.attachment ? { attachments: [record.candidate.attachment] } : {}) }));
      await Promise.race([work, new Promise<never>((_, reject) => {
        timer = this.clock.setTimeout(() => { controller.abort(); reject(new Error('消息发送超时')); }, this.options.timeoutMs ?? 120_000);
      })]);
      record.status = 'sent'; record.finishedAt = this.clock.now();
    } catch (error) {
      record.status = 'failed'; record.error = error instanceof Error ? error.message : String(error); record.finishedAt = this.clock.now();
      this.options.logger.warn('消息发送失败，不重试', { messageId: record.id, taskId: record.candidate.taskId, error: record.error });
      if (!record.candidate.notification) this.failureNotice(record);
    } finally { if (timer) this.clock.clearTimeout(timer); }
    this.persist(); this.publish(record);
  }
  /** 通知有固定 ID 且带 notification 标记，保证只生成一次、失败不递归。 */
  private failureNotice(record: QueuedMessage): void {
    const id = `${record.id}:failure-notice`;
    record.failureNoticeId = id;
    if (this.records.has(id)) return;
    const c = record.candidate;
    const name = c.attachment ? `附件「${c.attachment.fileName}」` : c.kind === 'progress' ? '存活提醒' : c.text.slice(0, 30);
    this.records.set(id, { id, candidate: { ...c, attachment: undefined, text: `发送 ${name} 消息失败。`, notification: true, immediateOnly: c.immediateOnly, kind: 'error' }, status: 'pending', createdAt: this.clock.now() });
  }
  private publish(record: QueuedMessage): void {
    if (record.status !== 'sent' && record.status !== 'failed' && record.status !== 'discarded') return;
    const result: DeliveryResult = { messageId: record.id, taskId: record.candidate.taskId, lane: record.candidate.lane, status: record.status, deliveredAt: record.status === 'sent' ? record.finishedAt : undefined, error: record.error };
    for (const fn of this.listeners) {
      try { fn(result, readonlySnapshot(record.candidate)); } catch (error) { this.options.logger.error('投递回调失败', { error: String(error) }); }
    }
  }
  private persist(): void { this.options.store?.save([...this.records.values()]); }
}
