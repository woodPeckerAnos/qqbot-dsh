/**
 * 编排器：把一条用户消息（群聊或单聊）变成一次 DSH turn，再把结果变成 QQ 回复。
 *
 * 一次完整流程：
 *
 *   1. 事件去重（claim）——重复投递直接丢弃
 *   2. 记录用户消息到对话记录（供重启后回放）
 *   3. 取全局并发名额（有界，满了就礼貌拒绝而不是无限排队）
 *   4. 每会话串行（同一群/同一人同时只跑一条，避免事件流交错）
 *   5. 取该会话的 DSH runtime（必要时新建进程 + 冷启动回放）
 *   6. 起进度回执调度器（守被动回复窗口）
 *   7. session/prompt 派发
 *   8. 消费事件：累积 assistant 文本、记 turn/end
 *   9. status 回 idle 且本轮已 turn/end → 结束
 *  10. 分段 + 按配额发回复（群聊走 sendGroupMessage，单聊走 sendUserMessage）
 *  11. 记录助手消息
 *
 * 关键不变量：`ReplyLedger` 是**唯一**分配 msg_seq 的地方，且进度回执永远不能
 * 吃掉最终答案的配额。
 *
 * 群聊与单聊共用同一条代码路径，区别只有两处：
 *   - 会话键/工作区/锁用 `message.target.key`（单聊带 `c2c:` 前缀）；
 *   - 回复配额取各自的配置（官方单聊上限 4 条 < 群聊 5 条），发送端点按
 *     `message.target.kind` 选择。
 */

import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { RuntimeEntry, RuntimePool } from '../dsh/pool.js';
import type { SessionStatusNotification } from '../dsh/protocol.js';
import { TurnAccumulator, type TurnOutcome } from '../dsh/turns.js';
import type { QqApi } from '../qq/api.js';
import {
  isUserMessage,
  type ConversationKind,
  type ConversationTarget,
  type NormalizedEvent,
  type NormalizedMessage,
} from '../qq/gateway.js';
import type { SendMessageRequest } from '../qq/types.js';
import type { ConversationStore } from '../store/conversations.js';
import { renderReplay } from '../store/conversations.js';
import type { SeenStore } from '../store/seen.js';
import type { SessionStore } from '../store/sessions.js';
import { ensureWorkspace, type StorePaths } from '../store/paths.js';
import { KeyedMutex, Semaphore, waitUntil } from './concurrency.js';
import { segmentText } from './chunk.js';
import { renderMessage } from './markdown.js';
import {
  defaultProgressText,
  ProgressScheduler,
  ReplyLedger,
  ReplyQuotaExhaustedError,
  type ReplyTicket,
} from './progress.js';

export interface DispatcherDeps {
  config: Config;
  logger: Logger;
  pool: RuntimePool;
  api: Pick<QqApi, 'sendGroupMessage' | 'sendUserMessage'>;
  conversations: ConversationStore;
  seen: SeenStore;
  sessions: SessionStore;
  paths: StorePaths;
  /** 统计用（health 展示） */
  now?: () => number;
}

export interface DispatcherStats {
  received: number;
  deduplicated: number;
  rejectedBusy: number;
  skippedC2C: number;
  completed: number;
  failed: number;
  timedOut: number;
  repliesSent: number;
  progressSent: number;
}

export class Dispatcher {
  private readonly semaphore: Semaphore;
  private readonly conversationLock = new KeyedMutex();
  private readonly stats: DispatcherStats = {
    received: 0,
    deduplicated: 0,
    rejectedBusy: 0,
    skippedC2C: 0,
    completed: 0,
    failed: 0,
    timedOut: 0,
    repliesSent: 0,
    progressSent: 0,
  };

  /**
   * 每个会话当前进行中的 turn 累积器，供事件路由定位。
   * 结束判定用轮询 `isSettled`（见 runTurn），因此这里不需要额外的完成回调。
   */
  private readonly activeTurns = new Map<string, TurnAccumulator>();

  constructor(private readonly deps: DispatcherDeps) {
    this.semaphore = new Semaphore(deps.config.pool.maxConcurrentTurns);
  }

  snapshotStats(): DispatcherStats & { inFlight: number; queued: number } {
    return {
      ...this.stats,
      inFlight: this.semaphore.inUse,
      queued: this.semaphore.queued,
    };
  }

  /** 入口：处理一个归一化事件。永不抛错（所有失败都转成回复或日志）。 */
  async handleEvent(event: NormalizedEvent): Promise<void> {
    if (isUserMessage(event)) {
      await this.handleMessage(event);
      return;
    }
    if (event.kind === 'group-add-robot' || event.kind === 'c2c-friend-add') {
      await this.handleWelcome(event);
      return;
    }
    this.deps.logger.debug('忽略系统事件', { kind: event.kind, reason: event.reason });
  }

  /** 把 runtime 推送的事件路由到对应会话的在途 turn。 */
  routeSessionEvent(
    conversationKey: string,
    event: { type: string; seq: number; data: Record<string, unknown> },
  ): void {
    const accumulator = this.activeTurns.get(conversationKey);
    if (accumulator === undefined) {
      // 没有在途 turn（例如回收竞态、或事件属于上一轮）——记录到 debug 便于排查
      this.deps.logger.debug('收到无归属的会话事件', {
        conversation: conversationKey,
        type: event.type,
      });
      return;
    }
    accumulator.observe({ type: event.type, seq: event.seq, data: event.data });
  }

  /** 把 runtime 推送的 agent 状态变化路由到对应会话。 */
  routeSessionStatus(conversationKey: string, status: SessionStatusNotification): void {
    const accumulator = this.activeTurns.get(conversationKey);
    if (accumulator === undefined) return;
    accumulator.observeStatus(status.status);
    // 结束判定由 runTurn 的 waitUntil 轮询 isSettled 完成，这里只更新状态
  }

  // -------------------------------------------------------------------------
  // 用户消息（群聊 / 单聊）
  // -------------------------------------------------------------------------

  private async handleMessage(message: NormalizedMessage): Promise<void> {
    const { logger, seen } = this.deps;
    this.stats.received += 1;

    // 单聊开关：intent 层无法只订群聊（1<<25 两者共用），所以在业务层拦。
    if (message.target.kind === 'c2c' && !this.deps.config.qq.c2c.enabled) {
      this.stats.skippedC2C += 1;
      logger.debug('单聊已禁用，忽略私聊消息', { conversation: message.target.key });
      return;
    }

    const eventKey = message.eventId !== '' ? message.eventId : message.msgId;
    if (!seen.claim(eventKey)) {
      this.stats.deduplicated += 1;
      logger.debug('丢弃重复事件', { eventId: eventKey });
      return;
    }

    const conversationKey = message.target.key;
    const messageLogger = logger.child({
      conversation: conversationKey,
      kind: message.target.kind,
      msgId: message.msgId,
    });

    // 记录用户消息（供重启后回放）
    this.deps.conversations.append(conversationKey, {
      role: 'user',
      speaker: message.username ?? message.senderId,
      text: message.content,
      ts: message.ts,
    });

    // 拿全局并发名额：不排队，满员直接拒绝。
    // 排队是没有意义的——被动回复窗口有限，排到时消息早已发不出去。
    if (this.semaphore.inUse >= this.deps.config.pool.maxConcurrentTurns) {
      this.stats.rejectedBusy += 1;
      messageLogger.warn('并发已满，礼貌拒绝本次提问', {
        inUse: this.semaphore.inUse,
        max: this.deps.config.pool.maxConcurrentTurns,
      });
      await this.replySimple(
        message,
        '我现在同时在处理的请求太多，暂时忙不过来。请稍后再发一次。',
        'error',
      ).catch(() => {});
      return;
    }

    const release = await this.semaphore.acquire();
    try {
      await this.conversationLock.run(conversationKey, () => this.runTurn(message, messageLogger));
    } catch (error) {
      this.stats.failed += 1;
      messageLogger.error('处理提问时发生未预期错误', {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.replySimple(message, '处理你的请求时出错了，我已经记录到日志。', 'error').catch(
        () => {},
      );
    } finally {
      release();
    }
  }

  private async runTurn(message: NormalizedMessage, logger: Logger): Promise<void> {
    const { config, pool, sessions, paths } = this.deps;
    const conversationKey = message.target.key;

    const workspacePath = ensureWorkspace(paths, conversationKey);
    const ledger = new ReplyLedger({
      msgId: message.msgId,
      ...this.replyLimits(message.target.kind),
    });

    // 先声明，再构造依赖它们的 ProgressScheduler：
    // 虽然 renderText 只会在 start() 之后被调用，但把声明放在使用之前更不容易出错。
    const startedAt = this.now();
    let accumulator = new TurnAccumulator('pending');

    const progress = new ProgressScheduler({
      afterMs: config.qq.progressAfterMs,
      intervalMs: config.qq.progressIntervalMs,
      renderText: () => defaultProgressText(this.elapsedSince(startedAt), accumulator.toolsInvoked),
      send: async (text) => {
        const ticket = ledger.allocate('progress');
        await this.sendSegment(message, text, ticket, undefined, logger);
        this.stats.progressSent += 1;
      },
      allocateTicket: () => {
        // 试分配哨兵：真正的分配发生在 send 里。这里只回答"还该不该继续调度"。
        if (ledger.progressRemaining <= 0 || ledger.remaining <= 1) return undefined;
        return { kind: 'progress', msgSeq: -1, remaining: ledger.remaining };
      },
      logger,
    });

    let entry: RuntimeEntry | undefined;

    try {
      entry = await pool.acquire(conversationKey, workspacePath);

      // 会话：新建的 runtime 需要新 sessionId + 冷启动回放
      const session = sessions.ensure(conversationKey, /* rotate */ !entry.replayed);

      accumulator = new TurnAccumulator(session.currentSessionId);
      this.activeTurns.set(conversationKey, accumulator);

      const prompt = this.buildPrompt(message, conversationKey, session.generation, !entry.replayed);
      entry.replayed = true;
      entry.busy = true;

      // 先注册在途 turn（上一行）再派发，避免事件早于注册到达而被丢弃
      await entry.runtime.prompt(session.currentSessionId, prompt);
      logger.debug('已派发 prompt', {
        sessionId: session.currentSessionId,
        generation: session.generation,
      });

      progress.start();

      // 结束条件：status 回 idle 且本轮已 turn/end（由 routeSessionStatus 触发 finish）
      const settled = await waitUntil(() => accumulator.isSettled, config.qq.turnTimeoutMs, 120);

      let outcome: TurnOutcome;
      if (settled) {
        outcome = accumulator.result();
        this.stats.completed += 1;
      } else {
        this.stats.timedOut += 1;
        outcome = accumulator.timeoutResult();
        logger.warn('本轮超时，将回收 runtime 以终止任务', {
          timeoutMs: config.qq.turnTimeoutMs,
          toolsInvoked: accumulator.toolsInvoked,
        });
        // 没有取消 API，唯一可靠的终止方式是回收整个 runtime 进程
        void pool.drop(conversationKey).catch(() => {});
      }

      await this.deliverOutcome(message, outcome, ledger, logger);
    } finally {
      progress.stop();
      this.activeTurns.delete(conversationKey);
      if (entry !== undefined) pool.release(conversationKey);
    }
  }

  /** 按会话类型取回复配额（官方单聊上限低于群聊，必须分开）。 */
  private replyLimits(kind: ConversationKind): { totalQuota: number; progressQuota: number } {
    const { qq } = this.deps.config;
    return kind === 'c2c'
      ? { totalQuota: qq.c2c.maxRepliesPerMsg, progressQuota: qq.c2c.progressMax }
      : { totalQuota: qq.maxRepliesPerMsg, progressQuota: qq.progressMax };
  }

  private buildPrompt(
    message: NormalizedMessage,
    conversationKey: string,
    generation: number,
    coldStart: boolean,
  ): string {
    const { conversations, config } = this.deps;
    const speaker = message.username ?? message.senderId;
    // 明确标注渠道：同一个人在群里的 member_openid 与单聊的 user_openid 不同，
    // 标清楚能避免模型把两个会话的身份混起来。
    const role = message.target.kind === 'c2c' ? '私聊用户' : '群成员';
    const current = `[${role} ${speaker}] ${message.content}`;

    if (!coldStart || config.pool.replayTurns <= 0) return current;

    // 冷启动：把最近的对话记录作为上下文一并给出。
    // 注意排除刚追加进去的当前这条，避免重复。
    const history = conversations.readTail(conversationKey, config.pool.replayTurns * 2);
    const withoutCurrent = history.filter(
      (turn) => !(turn.role === 'user' && turn.text === message.content && turn.ts === message.ts),
    );
    const replay = renderReplay(withoutCurrent);
    this.deps.logger.info('冷启动回放历史', {
      conversation: conversationKey,
      generation,
      turns: withoutCurrent.length,
    });
    if (replay === '') return current;
    return `${replay}\n\n${current}`;
  }

  private async deliverOutcome(
    message: NormalizedMessage,
    outcome: TurnOutcome,
    ledger: ReplyLedger,
    logger: Logger,
  ): Promise<void> {
    const { conversations } = this.deps;
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

    // 本轮结果按 'final' 记账：即使是 error 类结果，它也是对本轮提问的正式答复，
    // 不应占用 replySimple 那条"系统级错误提示"的语义。
    const sentAny = await this.sendLong(message, text, ledger, logger, 'final');

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

  /** 发一条简单回复（错误/忙提示）。配额不足时静默失败。 */
  private async replySimple(
    message: NormalizedMessage,
    text: string,
    kind: 'error',
  ): Promise<void> {
    const ledger = new ReplyLedger({
      msgId: message.msgId,
      ...this.replyLimits(message.target.kind),
    });
    await this.sendLong(message, text, ledger, this.deps.logger, kind);
  }

  /**
   * 把长文本按配额分段发送。
   * @returns 是否至少成功发出一条
   */
  private async sendLong(
    message: NormalizedMessage,
    text: string,
    ledger: ReplyLedger,
    logger: Logger,
    kind: 'final' | 'error',
  ): Promise<boolean> {
    const { config } = this.deps;
    // 剩余配额决定最多能分几段
    const maxSegments = Math.min(ledger.remaining, this.replyLimits(message.target.kind).totalQuota);

    const result = segmentText(text, { maxChars: config.qq.maxChars, maxSegments });
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
        ticket = ledger.allocate(kind === 'error' ? 'error' : 'final');
      } catch (error) {
        if (error instanceof ReplyQuotaExhaustedError) {
          logger.warn('回复配额用尽，剩余内容未发送', { used: error.used, total: error.total });
          break;
        }
        throw error;
      }
      try {
        await this.sendSegment(message, segment, ticket, undefined, logger);
        sent += 1;
      } catch (error) {
        logger.error('发送回复失败', {
          msgSeq: ticket.msgSeq,
          error: error instanceof Error ? error.message : String(error),
        });
        // 一条失败不阻塞后续分段：继续尝试，尽可能把内容送达
      }
    }
    return sent > 0;
  }

  /** 实际发送一条消息（按会话类型选端点，含 event_id / msg_id 互斥处理）。 */
  private async sendSegment(
    message: NormalizedMessage,
    text: string,
    ticket: ReplyTicket,
    quoteMessageId: string | undefined,
    logger: Logger,
  ): Promise<void> {
    const { config } = this.deps;
    const body = renderMessage(text, {
      msgType: config.qq.msgType,
      msgId: message.msgId,
      msgSeq: ticket.msgSeq,
      ...(quoteMessageId !== undefined ? { quoteMessageId } : {}),
    });
    await this.sendTo(message.target, body);
    this.stats.repliesSent += 1;
    logger.debug('已发送回复', {
      msgSeq: ticket.msgSeq,
      kind: ticket.kind,
      length: body.content?.length ?? body.markdown?.content.length ?? 0,
    });
  }

  /** 按会话类型选择发送端点（群聊 /v2/groups，单聊 /v2/users）。 */
  private async sendTo(target: ConversationTarget, body: SendMessageRequest): Promise<void> {
    if (target.kind === 'c2c') {
      await this.deps.api.sendUserMessage(target.id, body);
      return;
    }
    await this.deps.api.sendGroupMessage(target.id, body);
  }

  // -------------------------------------------------------------------------
  // 进群 / 加好友欢迎
  // -------------------------------------------------------------------------

  private async handleWelcome(event: NormalizedEvent): Promise<void> {
    if (event.kind !== 'group-add-robot' && event.kind !== 'c2c-friend-add') return;
    const target = event.target;
    if (target === undefined) return;
    if (target.kind === 'c2c' && !this.deps.config.qq.c2c.enabled) return;

    const { logger, config } = this.deps;
    const text =
      target.kind === 'c2c'
        ? '我是运行在 Docker 里的 DSH 助手。直接给我发消息说明需求即可。'
        : '我是运行在 Docker 里的 DSH 助手。在群里 @我 并说明需求即可。';
    logger.info(target.kind === 'c2c' ? '用户添加好友，发送欢迎语' : '机器人进群，发送欢迎语', {
      conversation: target.key,
    });
    try {
      // 进群/加好友事件必须用 event_id 回复（与 msg_id 互斥）
      const body = renderMessage(text, {
        msgType: config.qq.msgType,
        ...(event.eventId !== undefined && event.eventId !== '' ? { eventId: event.eventId } : {}),
        msgSeq: 1,
      });
      await this.sendTo(target, body);
      this.stats.repliesSent += 1;
    } catch (error) {
      logger.warn('发送欢迎语失败（不影响主要功能）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private elapsedSince(startedAt: number): number {
    return this.now() - startedAt;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
