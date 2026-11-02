/**
 * 主动判定到 Task 的适配边界，保留触发依据、引用和旧话题预算范围。
 * 持久预算由 TaskBudget 结算；本模块把首次实际送达反馈给 watcher 的原范围。
 * 后来的话题翻篇不撤销已准入请求，也不把旧结果扣到新范围。
 */
import type { BotConnector, NormalizedMessage } from '../core/connector.js';
import type { Logger } from '../logger.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { ProactiveComposeInput } from '../pipeline/proactive/contract.js';
import type { SessionActor } from './session-actor.js';
import type { ReplyCandidate } from './types.js';

/** watcher 的触发时预算投影，回调闭包始终指向原话题对象。 */
export interface ProactiveBudgetScope {
  id: string; limit: number;
  reserve(): void; release(): void; commit(ts: number): void;
}
export interface ProactiveTaskRequest {
  input: ProactiveComposeInput; scope: ProactiveBudgetScope; reference?: NormalizedMessage;
  onSpoke(text: string, ts: number): void;
}
export class ProactiveTaskAdapter {
  private readonly callbacks = new Map<string, { scope: ProactiveBudgetScope; onSpoke: ProactiveTaskRequest['onSpoke']; delivered?: { text: string; ts: number } }>();
  constructor(private readonly options: { actor: SessionActor; connectors: ReadonlyMap<string, BotConnector>; logger: Logger; context: (message: NormalizedMessage, connector: BotConnector) => MessageContext }) {}
  /** true 只表示双 lane Task 已准入；发言记账等待 DeliveryResult 成功。 */
  async submit(request: ProactiveTaskRequest): Promise<boolean> {
    const connector = this.options.connectors.get(request.input.target.platform);
    if (!connector) return false;
    const message: NormalizedMessage = request.reference ? structuredClone(request.reference) : {
      kind: 'group-message', target: request.input.target, eventId: '', msgId: '', senderId: 'proactive', ts: Date.now(), raw: {}, content: request.input.evidence ?? request.input.reason,
    };
    try {
      const handle = await this.options.actor.submit(this.options.context(message, connector), {
        directive: request.input.directive, evidence: request.input.evidence, scene: request.input.scene, budgetScope: request.scope.id,
      }, request.scope.limit);
      request.scope.reserve();
      this.callbacks.set(handle.taskId, { scope: request.scope, onSpoke: request.onSpoke }); return true;
    } catch (error) { this.options.logger.warn('主动 Task 准入失败', { error: String(error) }); return false; }
  }
  /** 输出协调器先调用此方法保存真实内容，再通知预算结算。 */
  delivered(candidate: Readonly<ReplyCandidate>, ts: number): void {
    const callback = this.callbacks.get(candidate.taskId);
    if (callback && !callback.delivered) callback.delivered = { text: candidate.text || `已发送附件：${candidate.attachment?.fileName ?? ''}`, ts };
  }
  /** 删除回调后只提交或释放一次；同 Task 后续正文、附件不重复记账。 */
  settled(taskId: string, result: 'committed' | 'released'): void {
    const callback = this.callbacks.get(taskId); if (!callback) return;
    this.callbacks.delete(taskId);
    if (result === 'released') callback.scope.release();
    else { const delivered = callback.delivered!; callback.scope.commit(delivered.ts); callback.onSpoke(delivered.text, delivered.ts); }
  }
}
