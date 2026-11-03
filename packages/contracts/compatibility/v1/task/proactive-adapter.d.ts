import type { DeepReadonly } from '../readonly.js';
/**
 * 主动判定到 Task 的适配边界，保留触发依据、引用和旧话题预算范围。
 * 持久预算由 TaskBudget 结算；本模块把首次实际送达反馈给 watcher 的原范围。
 * 后来的话题翻篇不撤销已准入请求，也不把旧结果扣到新范围。
 */
/**
 * 主动判定到 Task 的适配边界，保留触发依据、引用和旧话题预算范围。
 * 持久预算由 TaskBudget 结算；本模块把首次实际送达反馈给 watcher 的原范围。
 * 后来的话题翻篇不撤销已准入请求，也不把旧结果扣到新范围。
 */
import type { BotConnector, NormalizedMessage } from '../core/connector.js';
import type { TraceContext, Logger } from '../logger.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { ProactiveComposeInput } from '../pipeline/proactive/contract.js';
import type { SessionActor } from './session-actor.js';
import type { ReplyCandidate } from './types.js';
/** watcher 的触发时预算投影，回调闭包始终指向原话题对象。 */
export interface ProactiveBudgetScope {
    id: string;
    limit: number;
    reserve(): void;
    release(): void;
    commit(ts: number): void;
}
export interface ProactiveTaskRequest {
    trace?: TraceContext;
    input: ProactiveComposeInput;
    scope: ProactiveBudgetScope;
    reference?: NormalizedMessage;
    onSpoke(text: string, ts: number): void;
}
export interface ProactiveTaskAdapter {
    /** true 只表示双 lane Task 已准入；发言记账等待 DeliveryResult 成功。 */
    submit(request: ProactiveTaskRequest): Promise<boolean>;
    submitResult(request: ProactiveTaskRequest): Promise<import('../errors.js').Result<boolean>>;
    /** 输出协调器先调用此方法保存真实内容，再通知预算结算。 */
    delivered(candidate: DeepReadonly<ReplyCandidate>, ts: number): void;
    /** 删除回调后只提交或释放一次；同 Task 后续正文、附件不重复记账。 */
    settled(taskId: string, result: 'committed' | 'released'): void;
}
export type createProactiveTaskAdapterFactory = (options: {
    actor: SessionActor;
    connectors: ReadonlyMap<string, BotConnector>;
    logger: Logger;
    context: (message: NormalizedMessage, connector: BotConnector, trace?: TraceContext) => MessageContext;
}) => ProactiveTaskAdapter;
