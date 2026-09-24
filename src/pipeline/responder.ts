/**
 * Egress 收口：一条用户消息的所有回复都经 Responder 发出。
 *
 * 为什么收口：
 *   QQ 的被动回复窗口把"回复次数"变成稀缺资源（群聊 5 分钟 / 5 次），
 *   所以 `ReplyLedger` 必须是**唯一**分配 `msg_seq` 的地方。收口前它散在
 *   runTurn / replySimple / deliverOutcome 三处各自 new，不变量靠注释维持；
 *   现在一条消息一个 Responder、一个账本，不变量由结构保证。
 *
 * 职责边界：
 *   - 持有配额账本（ReplyLedger）与进度回执调度（ProgressScheduler）；
 *   - 长文本分段（segmentText）、配额分配、经 BotConnector.reply 发送；
 *   - 把 turn 结果（TurnOutcome）渲染成用户可读文案（deliver）；
 *   - 记录助手回复到对话记录（供重启后回放）；
 *   - 平台专有行为（msg_seq、markdown 请求体）仍在适配器内，这里只调 reply()。
 *
 * 生命周期：每条用户消息一个实例，由 Ingress 管线入口创建，随消息处理结束而弃。
 * 同一条消息要么走"简短回复"路径（error），要么走"turn 结果"路径
 * （startProgress → deliver），不会两条都走。
 */

import type { BotConnector, NormalizedMessage, ReplyPolicy } from '../core/connector.js';
import type { TurnOutcome } from '../dsh/turns.js';
import type { Logger } from '../logger.js';
import type { ConversationStore } from '../store/conversations.js';
import { segmentText } from './chunk.js';
import {
  ProgressScheduler,
  ReplyLedger,
  ReplyQuotaExhaustedError,
  type ReplyTicket,
} from './progress.js';
import type { PipelineStats } from './stats.js';

export interface ResponderOptions {
  /** 触发本次回复的用户消息（target / msgId 都从这里取） */
  message: NormalizedMessage;
  connector: BotConnector;
  policy: ReplyPolicy;
  conversations: ConversationStore;
  stats: PipelineStats;
  logger: Logger;
  now?: () => number;
}

export class Responder {
  private readonly ledger: ReplyLedger;
  private progress: ProgressScheduler | undefined;

  constructor(private readonly options: ResponderOptions) {
    const { message, policy } = options;
    this.ledger = new ReplyLedger({
      msgId: message.msgId,
      totalQuota: policy.maxRepliesPerMsg,
      progressQuota: policy.progressMax,
    });
  }

  /**
   * 发一条简短回复（闸通知 / 命令回执 / 忙提示 / 错误）。
   * 配额不足时静默失败——这条语义从 replySimple 继承：提示类消息不该再抛错。
   */
  async error(text: string): Promise<void> {
    await this.sendLong(text, 'error');
  }

  /**
   * 起进度回执调度（TurnRunner 在 prompt 派发成功后调用）。
   *
   * @param renderText 进度文案生成器，入参是 turn 已用时长（毫秒），
   *   由调用方闭包携带 accumulator 状态（toolsInvoked 等）。
   */
  startProgress(renderText: (elapsedMs: number) => string): void {
    const { policy, logger, stats } = this.options;
    this.progress = new ProgressScheduler({
      afterMs: policy.progressAfterMs,
      intervalMs: policy.progressIntervalMs,
      renderText,
      send: async (text) => {
        const ticket = this.ledger.allocate('progress');
        await this.sendSegment(text, ticket);
        stats.progressSent += 1;
      },
      allocateTicket: () => {
        // 试分配哨兵：真正的分配发生在 send 里。这里只回答"还该不该继续调度"。
        if (this.ledger.progressRemaining <= 0 || this.ledger.remaining <= 1) return undefined;
        return { kind: 'progress', msgSeq: -1, remaining: this.ledger.remaining };
      },
      logger,
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
    });
    this.progress.start();
  }

  /** 停进度回执调度（turn 结束时调用，幂等）。 */
  stopProgress(): void {
    this.progress?.stop();
  }

  /**
   * 把一轮 turn 的结果发给用户，并记录到对话记录。
   *
   * 结果一律按 'final' 记账：即使是 error 类结果，它也是对本轮提问的正式答复，
   * 不应占用 error 那条"系统级错误提示"的语义。
   */
  async deliver(outcome: TurnOutcome): Promise<void> {
    const { message, conversations, logger } = this.options;
    const conversationKey = message.target.key;

    let text = outcome.text;
    switch (outcome.kind) {
      case 'completed':
        if (text === '') {
          text = '（这次没有产生可回复的内容）';
        }
        break;
      case 'max-tokens':
        text = `${text}\n\n（回答达到长度上限被截断，可以让我继续）`.trim();
        break;
      case 'timeout':
        text =
          text === ''
            ? '这个任务超过了单轮时限，我已经把它中断了。可以拆成更小的步骤再让我试。'
            : `任务超过单轮时限已中断。中断前已完成的部分：\n\n${text}`;
        break;
      case 'aborted':
        text = text === '' ? '任务被中断了。' : `任务被中断。中断前的部分结果：\n\n${text}`;
        break;
      case 'blocked':
        text = '这个操作被安全策略阻止了，我无法执行。';
        break;
      case 'error':
      default:
        text =
          text === ''
            ? `执行出错了${outcome.errorMessage !== undefined ? `：${outcome.errorMessage}` : ''}`
            : `${text}\n\n（执行过程中出现错误${
                outcome.errorMessage !== undefined ? `：${outcome.errorMessage}` : ''
              }）`;
        break;
    }

    const sentAny = await this.sendLong(text, 'final');
    if (!sentAny) {
      logger.warn('本轮结果未能发送出去（配额或平台错误）', { kind: outcome.kind });
    }

    // 记录助手回复（供下次冷启动回放）
    conversations.append(conversationKey, {
      role: 'assistant',
      speaker: 'bot',
      text,
      ts: this.now(),
      replyToMsgId: message.msgId,
    });
  }

  /**
   * 把长文本按配额分段发送。
   * @returns 是否至少成功发出一条
   */
  private async sendLong(text: string, kind: 'final' | 'error'): Promise<boolean> {
    const { policy, logger } = this.options;
    // 剩余配额决定最多能分几段
    const maxSegments = Math.min(this.ledger.remaining, policy.maxRepliesPerMsg);

    const result = segmentText(text, { maxChars: policy.maxChars, maxSegments });
    if (result.truncated) {
      logger.warn('内容超出回复配额，已截断', {
        originalLength: result.originalLength,
        segments: result.segments.length,
      });
    }

    let sent = 0;
    for (const segment of result.segments) {
      let ticket: ReplyTicket;
      try {
        ticket = this.ledger.allocate(kind === 'error' ? 'error' : 'final');
      } catch (error) {
        if (error instanceof ReplyQuotaExhaustedError) {
          logger.warn('回复配额用尽，剩余内容未发送', { used: error.used, total: error.total });
          break;
        }
        throw error;
      }
      try {
        await this.sendSegment(segment, ticket);
        sent += 1;
      } catch (error) {
        logger.error('发送回复失败', {
          seq: ticket.msgSeq,
          error: error instanceof Error ? error.message : String(error),
        });
        // 一条失败不阻塞后续分段：继续尝试，尽可能把内容送达
      }
    }
    return sent > 0;
  }

  /** 实际发送一条消息：平台专有的渲染与端点选择都在连接器内部。 */
  private async sendSegment(text: string, ticket: ReplyTicket): Promise<void> {
    const { message, connector, logger, stats } = this.options;
    await connector.reply(
      {
        target: message.target,
        seq: ticket.msgSeq,
        kind: ticket.kind,
        ...(message.msgId !== '' ? { msgId: message.msgId } : {}),
      },
      { text },
    );
    stats.repliesSent += 1;
    logger.debug('已发送回复', {
      seq: ticket.msgSeq,
      kind: ticket.kind,
      length: text.length,
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
