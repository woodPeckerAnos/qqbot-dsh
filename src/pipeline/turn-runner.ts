/**
 * TurnRunner：把一条已通过 Ingress 管线的用户消息变成一次 DSH turn。
 *
 * 这是原 Dispatcher 收窄后的样子——只管 turn 生命周期：
 *   1. 取该会话的 DSH runtime（必要时新建进程 + 冷启动回放）
 *   2. session/prompt 派发（先注册在途 turn 再派发，避免事件早于注册到达）
 *   3. 起进度回执调度（经 Responder，策略来自该平台该会话类型的 ReplyPolicy）
 *   4. 消费事件：累积 assistant 文本、记 turn/end
 *   5. status 回 idle 且本轮已 turn/end → 结束；超时则回收 runtime 终止任务
 *   6. 结果经 Responder.deliver 发出并记录
 *
 * 不负责的事（都在别处）：去重、命令、闸、记录、并发/串行准入（Ingress
 * stage），配额/分段/发送（Responder）。
 *
 * 平台差异只通过一个接缝进入本文件：`ctx.policy` 的 turnTimeoutMs。
 * 本文件不允许 import 任何 adapters/* 内部实现。
 */

import type { Config } from '../config.js';
import { messageImageParts } from '../core/content.js';
import { buildImageBlocks } from '../dsh/media.js';
import type { RuntimeEntry, RuntimePool } from '../dsh/pool.js';
import type {
  PromptContentBlock,
  SessionEventNotification,
  SessionStatusNotification,
} from '../dsh/protocol.js';
import { TurnAccumulator, type TurnOutcome } from '../dsh/turns.js';
import type { Logger } from '../logger.js';
import type { ConversationStore } from '../store/conversations.js';
import { renderReplay } from '../store/conversations.js';
import type { SessionStore } from '../store/sessions.js';
import { ensureWorkspace, type StorePaths } from '../store/paths.js';
import { waitUntil } from './concurrency.js';
import type { MessageContext } from './ingress/types.js';
import { defaultProgressText } from './egress/progress.js';
import type { PipelineStats } from './stats.js';

export interface TurnRunnerDeps {
  config: Config;
  logger: Logger;
  pool: RuntimePool;
  conversations: ConversationStore;
  sessions: SessionStore;
  paths: StorePaths;
  stats: PipelineStats;
  now?: () => number;
}

/**
 * 单个会话最多暂存几条"后台任务结果"等待带出。
 *
 * 后台子代理完成后，父代理会被 DSH 唤醒跑一个"自发轮次"总结结果（见
 * routeSessionStatus 的 spontaneous 分支）。QQ 被动回复窗口只有 5 分钟，
 * 那条总结当时多半发不出去，所以暂存下来，等该会话**下一条用户消息**的回复
 * 一并带出。设上限是防止长时间没有下一条消息时无限累积；超出丢最旧的。
 */
const MAX_PENDING_BACKGROUND = 3;

/** 已组装好、待派发的 prompt（含图片记账，供准入失败时回退与统计）。 */
interface PreparedPrompt {
  blocks: PromptContentBlock[];
  /** 这条消息里一共认出几张图 */
  totalImages: number;
  /** 其中成功编码成 image block 的张数 */
  inlinedImages: number;
}

export class TurnRunner {
  /**
   * 每个会话当前进行中的 turn 累积器，供事件路由定位。
   * 结束判定用轮询 `isSettled`（见 runTurn），因此这里不需要额外的完成回调。
   */
  private readonly activeTurns = new Map<string, TurnAccumulator>();

  /**
   * "自发轮次"累积器：后台子代理完成时，DSH 会唤醒空闲的父代理跑一轮总结
   * （settlement notice），这一轮不是任何 runTurn 发起的。没有它，父代理对
   * 后台结果的总结就会被当成"无归属事件"丢弃，用户永远看不到后台任务结果。
   */
  private readonly spontaneousTurns = new Map<string, TurnAccumulator>();

  /**
   * 每会话待带出的后台任务结果（自发轮次捕获，下一条用户消息的回复里前置）。
   * 内存态：桥接进程重启即丢——后台结果本就是尽力而为的提醒，可接受。
   */
  private readonly pendingBackground = new Map<string, string[]>();

  constructor(private readonly deps: TurnRunnerDeps) {}

  /** 终态 handler：在准入 stage 的「并发名额 + 每会话串行锁」之内运行。 */
  async runTurn(ctx: MessageContext): Promise<void> {
    const { message, responder, policy, logger } = ctx;
    const { pool, sessions, paths, stats } = this.deps;
    const conversationKey = message.target.key;

    const workspacePath = ensureWorkspace(paths, conversationKey);
    const startedAt = this.now();
    let accumulator = new TurnAccumulator('pending');
    let entry: RuntimeEntry | undefined;

    try {
      entry = await pool.acquire(conversationKey, workspacePath);

      // 会话：新建的 runtime 需要新 sessionId + 冷启动回放
      const session = sessions.ensure(conversationKey, /* rotate */ !entry.replayed);

      accumulator = new TurnAccumulator(session.currentSessionId);
      this.activeTurns.set(conversationKey, accumulator);
      // 用户轮次接管该会话：若此刻恰有一个"自发轮次"在跑（后台任务总结与用户
      // 新消息撞在一起的罕见竞态），丢弃它——两者会并进同一个 running 相位，
      // 父代理对用户问题的最终答复才是本轮要交付的内容（见 DESIGN 13.4）。
      if (this.spontaneousTurns.delete(conversationKey)) {
        logger.debug('用户轮次开始，丢弃进行中的自发轮次累积器');
      }

      const promptText = this.buildPrompt(message, conversationKey, session.generation, !entry.replayed);
      // 图片在派发前下载并编码：放在这里（而不是适配器归一化时）是因为
      // 被去重/闸拦掉的消息不该产生网络 IO。
      const prepared = await this.buildPromptBlocks(ctx, promptText);
      entry.replayed = true;
      entry.busy = true;

      // 先注册在途 turn（上一行）再派发，避免事件早于注册到达而被丢弃
      await this.dispatchPrompt(entry, session.currentSessionId, prepared);
      logger.debug('已派发 prompt', {
        sessionId: session.currentSessionId,
        generation: session.generation,
        images: prepared.inlinedImages,
      });

      responder.startProgress(() =>
        defaultProgressText(this.elapsedSince(startedAt), accumulator.toolsInvoked),
      );

      // 结束条件：status 回 idle 且本轮已 turn/end（由 routeSessionStatus 触发 finish）
      const settled = await waitUntil(() => accumulator.isSettled, policy.turnTimeoutMs, 120);

      let outcome: TurnOutcome;
      if (settled) {
        outcome = accumulator.result();
        stats.completed += 1;
      } else {
        stats.timedOut += 1;
        outcome = accumulator.timeoutResult();
        logger.warn('本轮超时，将回收 runtime 以终止任务', {
          timeoutMs: policy.turnTimeoutMs,
          toolsInvoked: accumulator.toolsInvoked,
        });
        // 没有取消 API，唯一可靠的终止方式是回收整个 runtime 进程
        void pool.drop(conversationKey).catch(() => {});
      }

      // 后台任务结果搭车：把之前捕获、当时发不出去的自发轮次总结前置到本轮回复。
      const delivered = this.attachPendingBackground(conversationKey, outcome);
      await responder.deliver(delivered);
    } finally {
      responder.stopProgress();
      this.activeTurns.delete(conversationKey);
      if (entry !== undefined) pool.release(conversationKey);
    }
  }

  /**
   * 把 runtime 推送的事件路由到对应会话的在途 turn。
   *
   * **必须按 sessionId 过滤**：一个 runtime 进程里除了父会话，还有后台子代理
   * 的子会话，事件都从同一条 wire 上来（`session.event` 携带各自的 sessionId）。
   * 不过滤的话，子代理的 `assistant/message` / `turn/end` 会灌进父轮次的累积器，
   * 轻则把子代理的中间文本当成最终答案，重则子代理的 turn/end 让父轮次提前结算。
   */
  routeSessionEvent(conversationKey: string, notification: SessionEventNotification): void {
    if (!this.isParentSession(conversationKey, notification.sessionId)) {
      this.deps.stats.childEventsFiltered += 1;
      this.deps.logger.debug('过滤掉子会话事件（后台子代理，不进父轮次）', {
        conversation: conversationKey,
        sessionId: notification.sessionId,
        type: notification.event.type,
      });
      return;
    }
    const accumulator =
      this.activeTurns.get(conversationKey) ?? this.spontaneousTurns.get(conversationKey);
    if (accumulator === undefined) {
      // 没有在途 turn（例如回收竞态、或事件属于上一轮）——记录到 debug 便于排查
      this.deps.logger.debug('收到无归属的会话事件', {
        conversation: conversationKey,
        type: notification.event.type,
      });
      return;
    }
    accumulator.observe(notification.event);
  }

  /**
   * 把 runtime 推送的 agent 状态变化路由到对应会话。
   *
   * 两条路径：
   *   - 有在途 runTurn → 喂给它的累积器（结束判定由 runTurn 轮询 isSettled）；
   *   - 无在途 runTurn 但父会话 running → 这是后台子代理完成后 DSH 唤醒父代理
   *     跑的"自发轮次"，用 spontaneousTurns 捕获，settle 后暂存待下次带出。
   */
  routeSessionStatus(conversationKey: string, notification: SessionStatusNotification): void {
    if (!this.isParentSession(conversationKey, notification.sessionId)) return;

    const active = this.activeTurns.get(conversationKey);
    if (active !== undefined) {
      active.observeStatus(notification.status);
      return;
    }
    this.handleSpontaneousStatus(conversationKey, notification.sessionId, notification.status);
  }

  /** 该 sessionId 是否是会话当前的父会话（子代理会话返回 false）。 */
  private isParentSession(conversationKey: string, sessionId: string): boolean {
    const parentId = this.deps.sessions.peek(conversationKey)?.currentSessionId;
    return parentId !== undefined && parentId === sessionId;
  }

  /** 处理"自发轮次"（后台任务总结）的状态机：running 建累积器，idle+turn/end 落定。 */
  private handleSpontaneousStatus(
    conversationKey: string,
    sessionId: string,
    status: 'idle' | 'running',
  ): void {
    if (status === 'running') {
      let accumulator = this.spontaneousTurns.get(conversationKey);
      if (accumulator === undefined) {
        accumulator = new TurnAccumulator(sessionId);
        this.spontaneousTurns.set(conversationKey, accumulator);
        this.deps.logger.debug('开始捕获自发轮次（后台任务完成总结）', { conversation: conversationKey });
      }
      accumulator.observeStatus('running');
      return;
    }
    // idle：只在已有自发累积器时处理
    const accumulator = this.spontaneousTurns.get(conversationKey);
    if (accumulator === undefined) return;
    accumulator.observeStatus('idle');
    if (!accumulator.isSettled) return;
    this.spontaneousTurns.delete(conversationKey);
    this.captureBackgroundResult(conversationKey, accumulator);
  }

  /** 把自发轮次的最终文本暂存起来，等下一条用户消息带出（受被动回复窗口所限）。 */
  private captureBackgroundResult(conversationKey: string, accumulator: TurnAccumulator): void {
    const text = accumulator.finalText.trim();
    if (text === '') {
      this.deps.logger.debug('自发轮次没有产出可见文本，不暂存', { conversation: conversationKey });
      return;
    }
    const queue = this.pendingBackground.get(conversationKey) ?? [];
    queue.push(text);
    while (queue.length > MAX_PENDING_BACKGROUND) queue.shift();
    this.pendingBackground.set(conversationKey, queue);
    this.deps.stats.backgroundCaptured += 1;
    this.deps.logger.info('捕获后台任务结果，待下一条回复带出', {
      conversation: conversationKey,
      length: text.length,
      queued: queue.length,
    });
  }

  /**
   * 取出并清空该会话暂存的后台结果，前置到本轮 outcome 的文本上。
   *
   * 前置而不是单独发一条：QQ 被动回复配额是稀缺资源，合并进本轮回复不额外占额。
   * 保留 outcome.kind，让 Responder 照常按结果类型渲染（超时/错误的话术不受影响）。
   */
  private attachPendingBackground(conversationKey: string, outcome: TurnOutcome): TurnOutcome {
    const queue = this.pendingBackground.get(conversationKey);
    if (queue === undefined || queue.length === 0) return outcome;
    this.pendingBackground.delete(conversationKey);
    this.deps.stats.backgroundDelivered += queue.length;
    const prefix = queue.map((text) => `【后台任务完成】${text}`).join('\n\n');
    const body = outcome.text.trim();
    return { ...outcome, text: body === '' ? prefix : `${prefix}\n\n${body}` };
  }

  private buildPrompt(
    message: MessageContext['message'],
    conversationKey: string,
    generation: number,
    coldStart: boolean,
  ): string {
    const { conversations, config } = this.deps;
    const speaker = message.username ?? message.senderId;
    // 明确标注渠道：同一个人在不同平台/不同会话类型下的 id 不同，
    // 标清楚能避免模型把多个会话的身份混起来。
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

  /**
   * 组装派发给 runtime 的 prompt content blocks：一个文本块（正文 + 附件说明）
   * 加若干图片块。
   *
   * 设计取舍：
   *   - 图片读不进来**不**是错误：降级成一行文字说明，文字部分照常回答。
   *     群里发张 HEIC 图就整轮失败，比看不到图更糟；
   *   - 关闭富媒体时也显式说一句"有 N 张图未读入"，否则模型会以为用户什么都没发。
   *   - 统计只在这里**记账**、在 dispatchPrompt 里落数：因为"下载成功"不等于
   *     "runtime 收下了"（见 dispatchPrompt 的准入失败回退）。
   */
  private async buildPromptBlocks(
    ctx: MessageContext,
    text: string,
  ): Promise<PreparedPrompt> {
    const { config, logger } = this.deps;
    const { enabled, maxImages, maxImageBytes, downloadTimeoutMs } = config.attachments;
    const images = messageImageParts(ctx.message);
    const total = images.length;

    if (total === 0) {
      return { blocks: [{ type: 'text', text }], totalImages: 0, inlinedImages: 0 };
    }

    if (!enabled || maxImages <= 0) {
      return {
        blocks: [
          {
            type: 'text',
            text: `${text}\n（本服务已关闭图片读取，这条消息里的 ${total} 张图片未读入）`,
          },
        ],
        totalImages: total,
        inlinedImages: 0,
      };
    }

    const fetchMedia = ctx.connector.fetchMedia;
    const { blocks, notes } = await buildImageBlocks(images, {
      maxImages,
      maxBytes: maxImageBytes,
      timeoutMs: downloadTimeoutMs,
      ...(fetchMedia !== undefined
        ? { fetchMedia: (media, options) => fetchMedia.call(ctx.connector, media, options) }
        : {}),
      logger,
    });

    const inlined = blocks.length;
    if (notes.length > 0) {
      logger.info('部分图片未能读入，已降级为文字说明', { notes, inlined, total });
    }

    const finalText = notes.length > 0 ? `${text}\n${notes.join('\n')}` : text;
    return { blocks: [{ type: 'text', text: finalText }, ...blocks], totalImages: total, inlinedImages: inlined };
  }

  /**
   * 派发 prompt；带图片时若被 runtime 拒绝，**退回纯文本重试一次**。
   *
   * 为什么必须有这一层：图片能不能被收下最终由 runtime 的准入决定
   * （逐图字节、解码像素、边长、base64 规范性），我们在下载侧只能挡住一部分
   * （我们不做图片解码，拿不到真实像素）。没有这层回退，一张巨图会让整轮失败，
   * 用户连文字回答都拿不到——这比"看不到图"糟得多。
   */
  private async dispatchPrompt(
    entry: RuntimeEntry,
    sessionId: string,
    prepared: PreparedPrompt,
  ): Promise<void> {
    const { stats, logger } = this.deps;
    try {
      await entry.runtime.prompt(sessionId, prepared.blocks);
    } catch (error) {
      if (prepared.inlinedImages === 0) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('带图片的 prompt 被 runtime 拒绝，退回纯文本重试', {
        error: reason,
        images: prepared.inlinedImages,
      });
      const textBlock = prepared.blocks[0];
      const body = textBlock !== undefined && textBlock.type === 'text' ? textBlock.text : '';
      await entry.runtime.prompt(sessionId, [
        {
          type: 'text',
          text: `${body}\n（${prepared.inlinedImages} 张图片未能被模型接收：${reason}）`,
        },
      ]);
      stats.imagesSkipped += prepared.inlinedImages;
      return;
    }
    stats.imagesInlined += prepared.inlinedImages;
    stats.imagesSkipped += Math.max(0, prepared.totalImages - prepared.inlinedImages);
  }

  private elapsedSince(startedAt: number): number {
    return this.now() - startedAt;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
