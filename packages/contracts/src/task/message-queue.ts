import type { DeepReadonly } from '../readonly.js';
import type { MessageStateWriter } from '../errors.js';
import type { BotConnector, NormalizedMessage, ReplyContext } from '../core/connector.js';
import type { TraceContext, Logger } from '../logger.js';

import type { TaskClock } from './clock.js';
import type { DeliveryResult, ReplyCandidate } from './types.js';
/** 发送前持久化 sending 和锚点；重启时该状态代表结果未知，禁止自动重发。 */
export interface QueuedMessage {
  trace?: TraceContext;
  errorId?: string;
  failure?: import('../errors.js').ContractFailure;
  id: string;
  candidate: ReplyCandidate;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'discarded';
  createdAt: number;
  attemptedAt?: number;
  finishedAt?: number;
  /** 实际发送使用的锚点，可能不同于 candidate.reference 的原消息。 */
  anchor?: {
    msgId: string;
    seq: number;
  };
  error?: string;
  failureNoticeId?: string;
  /** 平台动作、超时或重启后结果不确定；仅可补保存，不可再次发送。 */
  outcome?: 'unknown';
}
export interface MessageQueue {
  onDelivery(
    fn: (result: DeepReadonly<DeliveryResult>, candidate: DeepReadonly<ReplyCandidate>) => void
  ): () => void;
  /** 新输入只提供更新的合法出口，不把已失败的消息重新变成待发送。 */
  observe(message: NormalizedMessage): void;
  /** 先落盘再唤醒发送；固定 ID 供恢复产物幂等入队。 */
  enqueue(candidate: ReplyCandidate, id?: string): string;
  canSend(candidate: ReplyCandidate): boolean;
  messages(taskId?: string): DeepReadonly<QueuedMessage[]>;
  /** 给预算结算聚合所有产物，正文、附件、提醒和失败通知都属于同一 Task。 */
  taskDelivery(taskId: string): DeepReadonly<{
    success: boolean;
    pending: boolean;
    count: number;
  }>;
  snapshot(): DeepReadonly<{
    pending: number;
    sending: number;
    sent: number;
    failed: number;
  }>;
  wake(): void;
  close(): void;
}
export type createMessageQueueFactory = (options: {
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
}) => MessageQueue;
