/**
 * 进群 / 加好友欢迎（系统事件分支，不走 Ingress 管线）。
 *
 * 欢迎语是主动下发的单条消息，没有配额账本语义（官方平台必须用
 * event_id 回复，与 msg_id 互斥；无此概念的平台忽略 eventId），
 * 所以直接经 BotConnector.reply 发出，只计 repliesSent。
 */
/**
 * 进群 / 加好友欢迎（系统事件分支，不走 Ingress 管线）。
 *
 * 欢迎语是主动下发的单条消息，没有配额账本语义（官方平台必须用
 * event_id 回复，与 msg_id 互斥；无此概念的平台忽略 eventId），
 * 所以直接经 BotConnector.reply 发出，只计 repliesSent。
 */
import type { BotConnector, NormalizedEvent } from '../../core/connector.js';
import type { Logger } from '../../logger.js';
import type { PipelineStats } from '../stats.js';
export type handleWelcomeEvent = (
  event: NormalizedEvent,
  deps: {
    connectors: ReadonlyMap<string, BotConnector>;
    stats: PipelineStats;
    logger: Logger;
  }
) => Promise<void>;
