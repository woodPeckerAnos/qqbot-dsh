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
import type { PromptContentBlock, SessionStatusNotification } from '../dsh/protocol.js';
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

      await responder.deliver(outcome);
    } finally {
      responder.stopProgress();
      this.activeTurns.delete(conversationKey);
      if (entry !== undefined) pool.release(conversationKey);
    }
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
