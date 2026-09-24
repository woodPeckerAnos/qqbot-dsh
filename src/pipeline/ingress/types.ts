/**
 * Ingress 管线的公共类型。
 *
 * stage 串行排布，两种控制语义：
 *   - 短路：不调用 next()（去重命中 / 闸拦截 / 命令已处理）；
 *   - 包裹：在 next() 外侧持有资源（准入 stage 在「并发名额 + 每会话串行锁」
 *     之内执行下游，这是唯一一个包裹型 stage）。
 *
 * 顺序即架构约束，当前排布及理由：
 *   去重 → 命令 → 谷时段闸 → 记录 → 准入 →（终态）TurnRunner
 *   - 命令必须先于闸：管理员必须能在峰时段 /offpeak off 关闸；
 *   - 闸必须先于记录与准入：被拦消息不写对话记录、不占并发名额、不碰 DSH 进程，
 *     也不会把伪造的 turn 混进会话历史污染后续回放；
 *   - 去重最先：重复投递直接丢弃，不触发任何副作用。
 * 改动顺序前先看各 stage 文件头的位置理由。
 *
 * 为什么不用洋葱中间件框架：这里的 stage 几乎全是"放行 or 短路"，
 * 只有准入一个包裹场景；一个 10 行的显式 runner 足够，引入框架只会
 * 模糊顺序约束——而顺序恰恰是这里最值钱的东西。
 */

import type { BotConnector, NormalizedMessage, ReplyPolicy } from '../../core/connector.js';
import type { Logger } from '../../logger.js';
import type { Responder } from '../responder.js';

/**
 * 一条用户消息在 Ingress 管线中的上下文。
 * 由 Orchestrator 在管线入口一次性构建，stage 只读。
 */
export interface MessageContext {
  readonly message: NormalizedMessage;
  readonly connector: BotConnector;
  readonly policy: ReplyPolicy;
  /** 白名单判定（platform:senderId 组合），入口算好，命令与闸共用 */
  readonly isAdmin: boolean;
  readonly logger: Logger;
  /** 本条消息的 Egress 收口（每条消息一个实例，持有唯一配额账本） */
  readonly responder: Responder;
}

export type IngressStage = (ctx: MessageContext, next: () => Promise<void>) => Promise<void>;

/** 串行执行 stage 链，末端是终态 handler（TurnRunner）。 */
export function runStages(
  stages: readonly IngressStage[],
  ctx: MessageContext,
  terminal: () => Promise<void>,
): Promise<void> {
  const dispatch = (index: number): Promise<void> => {
    if (index === stages.length) return terminal();
    return stages[index]!(ctx, () => dispatch(index + 1));
  };
  return dispatch(0);
}
