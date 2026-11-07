import { failure, type Result } from '@qqbot/contracts';
import type { DeepReadonly } from '@qqbot/contracts';
import type { ProactiveBudgetScope, ProactiveTaskRequest } from '@qqbot/contracts';
/**
 * 主动判定到 Task 的适配边界，保留触发依据、引用和旧话题预算范围。
 * 持久预算由 TaskBudget 结算；本模块把首次实际送达反馈给 watcher 的原范围。
 * 后来的话题翻篇不撤销已准入请求，也不把旧结果扣到新范围。
 */
import type { BotConnector, NormalizedMessage } from '@qqbot/contracts';
import { createTrace, traceSpan } from '../observability/index.js';
import type { TraceContext, Logger } from '@qqbot/contracts';
import type { MessageContext } from '@qqbot/contracts';

import type { SessionActorV3 as SessionActor } from '@qqbot/contracts';
import type { ReplyCandidate } from '@qqbot/contracts';

/** watcher 的触发时预算投影，回调闭包始终指向原话题对象。 */
export type { ProactiveBudgetScope } from '@qqbot/contracts';
export type { ProactiveTaskRequest } from '@qqbot/contracts';
export class ProactiveTaskAdapter {
  private readonly callbacks = new Map<
    string,
    {
      scope: ProactiveBudgetScope;
      onSpoke: ProactiveTaskRequest['onSpoke'];
      delivered?: { text: string; ts: number };
    }
  >();
  constructor(
    private readonly options: {
      actor: SessionActor;
      connectors: ReadonlyMap<string, BotConnector>;
      logger: Logger;
      context: (
        message: NormalizedMessage,
        connector: BotConnector,
        trace?: TraceContext
      ) => MessageContext;
    }
  ) {}
  /** true 只表示双 lane Task 已准入；发言记账等待 DeliveryResult 成功。 */
  async submit(request: ProactiveTaskRequest): Promise<boolean> {
    const result = await this.submitResult(request);
    return result.ok && result.value;
  }
  async submitResult(request: ProactiveTaskRequest): Promise<Result<boolean>> {
    const connector = this.options.connectors.get(request.input.target.platform);
    if (!connector) return { ok: false, error: failure('NOT_FOUND') };
    try {
      const handle = await this.options.actor.submit(
        this.inputContext(request, connector),
        {
          directive: request.input.directive,
          evidence: request.input.evidence,
          scene: request.input.scene,
          budgetScope: request.scope.id,
        },
        request.scope.limit
      );
      request.scope.reserve();
      this.callbacks.set(handle.taskId, {
        scope: request.scope,
        onSpoke: (text, ts) => {
          request.onSpoke(text, ts);
        },
      });
      return { ok: true, value: true };
    } catch (cause) {
      return {
        ok: false,
        error: failure('UPSTREAM_FAILED', cause, this.options.logger.cause(cause, 'task-submit')),
      };
    }
  }
  private inputContext(request: ProactiveTaskRequest, connector: BotConnector): MessageContext {
    const message: NormalizedMessage = request.reference
      ? structuredClone(request.reference)
      : {
          kind: 'group-message',
          target: request.input.target,
          eventId: '',
          msgId: '',
          senderId: 'proactive',
          ts: Date.now(),
          raw: {},
          content: request.input.evidence ?? request.input.reason,
        };
    const identity = {
      sessionKey: message.target.key,
      inputMessageId: message.msgId,
      inputEventId: message.eventId,
    };
    const trace = request.trace ? traceSpan(request.trace, identity) : createTrace(identity);
    const logger = this.options.logger.withTrace(trace);
    logger.event('input.received', {
      source: 'proactive',
      contentLength: request.input.directive.length,
      attachmentCount: 0,
    });
    return { ...this.options.context(message, connector, trace), trace, logger };
  }
  /** 输出协调器先调用此方法保存真实内容，再通知预算结算。 */
  delivered(candidate: DeepReadonly<ReplyCandidate>, ts: number): void {
    const callback = this.callbacks.get(candidate.taskId);
    if (callback && !callback.delivered)
      callback.delivered = {
        text: candidate.text || `已发送附件：${candidate.attachment?.fileName ?? ''}`,
        ts,
      };
  }
  /** 删除回调后只提交或释放一次；同 Task 后续正文、附件不重复记账。 */
  settled(taskId: string, result: 'committed' | 'released'): void {
    const callback = this.callbacks.get(taskId);
    if (!callback) return;
    this.callbacks.delete(taskId);
    if (result === 'released') callback.scope.release();
    else {
      const delivered = callback.delivered;
      if (delivered === undefined) return;
      callback.scope.commit(delivered.ts);
      callback.onSpoke(delivered.text, delivered.ts);
    }
  }
}
