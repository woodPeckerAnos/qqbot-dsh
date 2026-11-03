import { failure } from '@qqbot/contracts';
import type { DeepReadonly } from '@qqbot/contracts';
import type { QueuedMessage } from '@qqbot/contracts';
/**
 * 独立持久化的单次投递队列，也是平台锚点条数与 seq 的唯一账本。
 * 不查询 Task 是否仍在运行：尚未尝试的消息可等待合法出口，尝试失败则终结。
 * 文本和附件按 Session 使用不同通道，慢上传不占用快正文的发送通道。
 */
import { randomUUID } from 'node:crypto';
import type { BotConnector, NormalizedMessage, ReplyContext } from '@qqbot/contracts';
import { traceSpan, legacyTrace } from '../observability/index.js';
import type { Logger } from '@qqbot/contracts';
import type { MessageStateWriter } from '@qqbot/contracts';
import { SYSTEM_CLOCK } from '@qqbot/contracts';
import type { TaskClock } from '@qqbot/contracts';
import { readonlySnapshot } from '@qqbot/contracts';
import type { DeliveryResult, ReplyCandidate } from '@qqbot/contracts';

/** 发送前持久化 sending 和锚点；重启时该状态代表结果未知，禁止自动重发。 */
export type { QueuedMessage } from '@qqbot/contracts';
interface Route {
  connector: BotConnector;
  context: ReplyContext;
}
export class MessageQueue {
  private readonly records = new Map<string, QueuedMessage>();
  private readonly anchors = new Map<string, NormalizedMessage>();
  private readonly sequences = new Map<string, number>();
  private readonly sending = new Set<string>();
  private readonly listeners = new Set<
    (result: DeepReadonly<DeliveryResult>, candidate: DeepReadonly<ReplyCandidate>) => void
  >();
  private readonly clock: TaskClock;
  private closed = false;
  private readonly noticesToLog = new Set<string>();
  private readonly settlements = new Map<
    string,
    { record: QueuedMessage; notice?: QueuedMessage }
  >();
  constructor(
    private readonly options: {
      connectors: ReadonlyMap<string, BotConnector>;
      store?: MessageStateWriter;
      logger: Logger;
      clock?: TaskClock;
      timeoutMs?: number;
      idFactory?: () => string;
      transport?: (
        connector: BotConnector,
        context: ReplyContext,
        candidate: ReplyCandidate
      ) => Promise<void>;
    }
  ) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.restore(structuredClone(options.store?.load() ?? []));
  }
  private restore(records: QueuedMessage[]): void {
    for (const record of records) {
      record.trace ??=
        record.candidate.trace ??
        traceSpan(
          legacyTrace(record.candidate.taskId, record.candidate.message.target.key),
          { messageId: record.id, lane: record.candidate.lane },
          () => `${record.id}:delivery`
        );
      record.candidate.trace = record.trace;
      this.records.set(record.id, record);
      if (record.anchor) {
        const key = this.anchorKey(record.candidate.message, record.anchor.msgId);
        this.sequences.set(key, Math.max(this.sequences.get(key) ?? 0, record.anchor.seq));
      }
    }
    this.recoverDelivery();
  }
  private recoverDelivery(): void {
    const next = new Map([...this.records].map(([id, record]) => [id, structuredClone(record)]));
    const recovered: QueuedMessage[] = [];
    // 发送中消息的远端结果无法确认，恢复为失败并补一条通知，不重发原消息。
    for (const record of next.values())
      if (record.status === 'sending') {
        record.status = 'failed';
        record.error = '服务重启，发送结果无法确认';
        record.errorId ??= this.log(record).cause(new Error('restart'), 'delivery-restart-unknown');
        record.outcome = 'unknown';
        record.failure = failure('UNKNOWN_OUTCOME', undefined, record.errorId);
        recovered.push(record);
        record.finishedAt = this.clock.now();
      }
    for (const record of [...next.values()])
      if (record.status === 'failed' && !record.candidate.notification && !record.failureNoticeId)
        this.addFailureNotice(next, record);
    this.commit(next);
    for (const record of recovered)
      this.log(record).event('delivery.terminal', {
        status: record.status,
        errorId: record.errorId,
        errorClass: 'restart-unknown',
        recovered: true,
      });
  }
  onDelivery(
    fn: (result: DeepReadonly<DeliveryResult>, candidate: DeepReadonly<ReplyCandidate>) => void
  ): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  /** 新输入只提供更新的合法出口，不把已失败的消息重新变成待发送。 */
  observe(message: NormalizedMessage): void {
    const anchor = this.anchors.get(message.target.key);
    if (message.msgId && (anchor === undefined || anchor.ts <= message.ts))
      this.anchors.set(message.target.key, structuredClone(message));
    this.wake();
  }
  /** 先落盘再唤醒发送；固定 ID 供恢复产物幂等入队。 */
  enqueue(
    candidate: ReplyCandidate,
    id: string = this.options.idFactory?.() ?? randomUUID()
  ): string {
    if (this.closed) throw new Error('消息队列已关闭');
    if (this.records.has(id)) return id;
    const record = this.newRecord(candidate, id);
    if (candidate.immediateOnly && !this.route(candidate, false)) {
      record.status = 'discarded';
      record.finishedAt = this.clock.now();
    }
    this.commitRecord(record);
    this.logEnqueued(record);
    if (record.status === 'discarded') this.publish(record);
    this.wake();
    return id;
  }
  private newRecord(candidate: ReplyCandidate, id: string): QueuedMessage {
    const trace = traceSpan(
      candidate.trace ?? legacyTrace(candidate.taskId, candidate.message.target.key),
      { messageId: id, lane: candidate.lane },
      this.options.idFactory
    );
    const record: QueuedMessage = {
      trace,
      id,
      candidate: structuredClone({ ...candidate, trace }),
      status: 'pending',
      createdAt: this.clock.now(),
    };
    return record;
  }
  private logEnqueued(record: QueuedMessage): void {
    const c = record.candidate;
    this.log(record).event('delivery.enqueued', {
      kind: c.kind,
      contentLength: c.text.length,
      attachmentCount: c.attachment ? 1 : 0,
      notification: !!c.notification,
    });
  }
  canSend(candidate: ReplyCandidate): boolean {
    return !!this.route(candidate, false);
  }
  messages(taskId?: string): DeepReadonly<QueuedMessage[]> {
    return readonlySnapshot(
      [...this.records.values()].filter((r) => !taskId || r.candidate.taskId === taskId)
    );
  }
  /** 给预算结算聚合所有产物，正文、附件、提醒和失败通知都属于同一 Task。 */
  taskDelivery(
    taskId: string
  ): DeepReadonly<{ success: boolean; pending: boolean; count: number }> {
    const rows = [...this.records.values()].filter((r) => r.candidate.taskId === taskId);
    return readonlySnapshot({
      success: rows.some((r) => r.status === 'sent'),
      pending: rows.some((r) => r.status === 'pending' || r.status === 'sending'),
      count: rows.length,
    });
  }
  snapshot() {
    const rows = [...this.records.values()];
    return readonlySnapshot({
      pending: rows.filter((r) => r.status === 'pending').length,
      sending: rows.filter((r) => r.status === 'sending').length,
      sent: rows.filter((r) => r.status === 'sent').length,
      failed: rows.filter((r) => r.status === 'failed').length,
    });
  }
  wake(): void {
    queueMicrotask(() => {
      if (this.closed || !this.flushSettlements()) return;
      try {
        this.pump();
      } catch (error) {
        this.options.logger.cause(error, 'delivery-persistence-failed');
      }
    });
  }
  close(): void {
    this.closed = true;
  }
  private anchorKey(message: NormalizedMessage, msgId: string): string {
    return `${message.target.key}\u0000${msgId}`;
  }
  /** canSend 只探测；实际尝试才预留 seq，原锚点失效后可使用最新有效锚点。 */
  private route(candidate: ReplyCandidate, reserve: boolean): Route | undefined {
    const message = candidate.message;
    const connector = this.options.connectors.get(message.target.platform);
    if (!connector || !(connector.canReply?.(message.target) ?? connector.health().connected))
      return;
    const policy = connector.policy(message.target.kind);
    if (!Number.isFinite(policy.passiveWindowMs))
      return {
        connector,
        context: {
          target: message.target,
          msgId: message.msgId || undefined,
          seq: 0,
          kind: candidate.kind,
        },
      };
    const options = [message, this.anchors.get(message.target.key)].filter(
      (m): m is NormalizedMessage => !!m
    );
    for (const anchor of options) {
      if (!anchor.msgId || this.clock.now() >= anchor.ts + policy.passiveWindowMs) continue;
      const key = this.anchorKey(message, anchor.msgId);
      const seq = (this.sequences.get(key) ?? 0) + 1;
      if (seq > policy.maxRepliesPerMsg) continue;
      if (reserve) this.sequences.set(key, seq);
      return {
        connector,
        context: { target: message.target, msgId: anchor.msgId, seq, kind: candidate.kind },
      };
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
        if (record.candidate.immediateOnly) {
          this.discard(record);
        }
        continue;
      }
      const route = this.route(record.candidate, false);
      if (!route) {
        if (record.candidate.immediateOnly) {
          this.discard(record);
        }
        continue;
      }
      this.attempt(record, route, channel);
    }
  }
  private discard(record: QueuedMessage): void {
    const next = { ...record, status: 'discarded' as const, finishedAt: this.clock.now() };
    this.commitRecord(next);
    this.publish(next);
  }
  private attempt(record: QueuedMessage, route: Route, channel: string): void {
    record = structuredClone(record);
    record.status = 'sending';
    record.attemptedAt = this.clock.now();
    if (
      record.candidate.quote === false &&
      this.clock.now() - record.candidate.message.ts >= 30_000
    )
      record.candidate.quote = true;
    if (route.context.msgId) record.anchor = { msgId: route.context.msgId, seq: route.context.seq };
    // 必须先记录尝试再调用平台，崩溃后才能识别结果未知的消息。
    this.commitRecord(record);
    if (route.context.msgId && route.context.seq > 0)
      this.sequences.set(
        this.anchorKey(record.candidate.message, route.context.msgId),
        route.context.seq
      );
    this.log(record).event('delivery.attempt', {
      anchorMessageId: route.context.msgId,
      seq: route.context.seq,
    });
    this.sending.add(channel);
    void this.send(record, route).finally(() => {
      this.sending.delete(channel);
      this.wake();
    });
  }
  /** 一次调用，无重试循环；超时后即使远端迟到成功，也不重新结算本消息。 */
  private async send(record: QueuedMessage, route: Route): Promise<void> {
    const next = structuredClone(record);
    const controller = new AbortController();
    const context = {
      ...route.context,
      target: structuredClone(route.context.target),
      signal: controller.signal,
    };
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = Promise.resolve().then(() =>
        this.options.transport
          ? this.options.transport(route.connector, context, structuredClone(record.candidate))
          : route.connector.reply(
              context,
              structuredClone({
                text: record.candidate.text,
                reference:
                  record.candidate.quote === false ? undefined : record.candidate.reference,
                ...(record.candidate.attachment
                  ? { attachments: [record.candidate.attachment] }
                  : {}),
              })
            )
      );
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = this.clock.setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('消息发送超时'));
          }, this.options.timeoutMs ?? 120_000);
        }),
      ]);
      next.status = 'sent';
      next.finishedAt = this.clock.now();
    } catch (error) {
      this.fail(next, error, timedOut);
    } finally {
      if (timer) this.clock.clearTimeout(timer);
    }
    this.settleDelivery(record, next);
  }
  /** 远端动作已完成，仅保存该次结果；保存失败时保留同一结果等待补写。 */
  private settleDelivery(record: QueuedMessage, next: QueuedMessage): void {
    const notice =
      next.status === 'failed' && !next.candidate.notification
        ? this.failureNotice(next)
        : undefined;
    this.settlements.set(record.id, { record: next, notice });
    if (!this.flushSettlements()) {
      this.records.set(record.id, {
        ...record,
        outcome: 'unknown',
        errorId: next.errorId,
        failure: failure('UNKNOWN_OUTCOME', undefined, next.errorId),
      });
    }
  }
  private fail(record: QueuedMessage, error: unknown, timedOut: boolean): void {
    record.status = 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    record.finishedAt = this.clock.now();
    record.errorId = this.log(record).cause(error, 'delivery-send-failed');
    if (timedOut) record.outcome = 'unknown';
    record.failure = {
      ...failure(timedOut ? 'TIMEOUT' : 'UPSTREAM_FAILED', undefined, record.errorId),
      retry: 'never',
    };
  }
  /** 通知有固定 ID 且带 notification 标记，保证只生成一次、失败不递归。 */
  private failureNotice(record: QueuedMessage): QueuedMessage {
    const id = `${record.id}:failure-notice`;
    record.failureNoticeId = id;
    const c = record.candidate;
    let name: string;
    if (c.attachment) name = `附件「${c.attachment.fileName}」`;
    else if (c.kind === 'progress') name = '存活提醒';
    else name = c.text.slice(0, 30);
    const trace = traceSpan(
      record.trace ?? legacyTrace(c.taskId),
      { messageId: id },
      this.options.idFactory
    );
    return {
      id,
      trace,
      errorId: record.errorId,
      candidate: {
        ...c,
        trace,
        attachment: undefined,
        text: `发送 ${name} 消息失败。`,
        notification: true,
        immediateOnly: c.immediateOnly,
        kind: 'error',
      },
      status: 'pending',
      createdAt: this.clock.now(),
    };
  }
  private publish(record: QueuedMessage): void {
    if (record.status !== 'sent' && record.status !== 'failed' && record.status !== 'discarded')
      return;
    this.log(record).event('delivery.terminal', {
      status: record.status,
      durationMs: (record.finishedAt ?? this.clock.now()) - record.createdAt,
      errorId: record.errorId,
      errorClass: record.status === 'failed' ? 'delivery-failed' : undefined,
    });
    const result: DeliveryResult = {
      messageId: record.id,
      taskId: record.candidate.taskId,
      lane: record.candidate.lane,
      status: record.status,
      deliveredAt: record.status === 'sent' ? record.finishedAt : undefined,
      error: record.error,
      failure: record.failure,
    };
    for (const fn of this.listeners) {
      try {
        fn(readonlySnapshot(result), readonlySnapshot(record.candidate));
      } catch (error) {
        this.options.logger.error('投递回调失败', { error: String(error) });
      }
    }
  }
  private log(record: QueuedMessage): Logger {
    return this.options.logger.withTrace(
      record.trace ?? legacyTrace(record.candidate.taskId, record.candidate.message.target.key)
    );
  }
  private addFailureNotice(next: Map<string, QueuedMessage>, record: QueuedMessage): void {
    const notice = this.failureNotice(record);
    if (next.has(notice.id)) return;
    this.noticesToLog.add(notice.id);
    next.set(notice.id, notice);
  }
  private commitRecord(record: QueuedMessage): void {
    const next = new Map(this.records);
    next.set(record.id, record);
    this.commit(next);
  }
  private commit(next: Map<string, QueuedMessage>): void {
    this.options.store?.save(structuredClone([...next.values()]));
    this.records.clear();
    for (const [id, record] of next) this.records.set(id, record);
    this.logNotices();
  }
  private flushSettlements(): boolean {
    for (const [id, settlement] of this.settlements) {
      const next = new Map(this.records);
      next.set(id, settlement.record);
      if (settlement.notice && !next.has(settlement.notice.id)) {
        next.set(settlement.notice.id, settlement.notice);
        this.noticesToLog.add(settlement.notice.id);
      }
      try {
        this.commit(next);
      } catch (error) {
        this.options.logger.cause(error, 'delivery-settlement-persistence-failed');
        return false;
      }
      this.settlements.delete(id);
      this.publish(settlement.record);
    }
    return true;
  }
  private logNotices(): void {
    for (const id of this.noticesToLog) {
      const notice = this.records.get(id);
      if (notice) this.logEnqueued(notice);
      if (notice)
        this.log(notice).event('delivery.notice', {
          sourceMessageId: id.slice(0, -15),
          errorId: notice.errorId,
        });
    }
    this.noticesToLog.clear();
  }
}
