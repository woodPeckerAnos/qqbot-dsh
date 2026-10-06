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
import type { MediaBytes, MediaFetchOptions, RemoteMedia } from '../core/connector.js';
import { messageImageParts, messageMediaParts } from '../core/content.js';
import { ingestFiles, type DocumentExtractor, type FileIngestResult } from '../dsh/files.js';
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
import { cleanupInbox } from '../store/inbox.js';
import type { SessionStore } from '../store/sessions.js';
import { ensureWorkspace, type StorePaths } from '../store/paths.js';
import { waitUntil } from './concurrency.js';
import type { MessageContext } from './ingress/types.js';
import { defaultProgressText } from './egress/progress.js';
import type { BackgroundPusher } from './egress/background.js';
import type { PipelineStats } from './stats.js';
import type { TopicJudge } from './topic-judge.js';

export interface TurnRunnerDeps {
  config: Config;
  logger: Logger;
  pool: RuntimePool;
  conversations: ConversationStore;
  sessions: SessionStore;
  paths: StorePaths;
  stats: PipelineStats;
  /** 后台结果投递器：主动推送（OneBot/官方窗口内）或暂存待下次带出，并持久化 */
  background: BackgroundPusher;
  /**
   * 话题判定器（main.ts 用 createTopicJudge 构造；未注入 = 不做话题判定，
   * 上下文只靠 /new 与 runtime 回收重置）。
   */
  topicJudge?: TopicJudge;
  /**
   * 文档文本抽取器（main.ts 注入 dsh/document.ts 的实现；缺省 = 只落盘不解析）。
   *
   * 做成注入而不是直接 import 的原因：单元测试必须全离线、且不依赖宿主上
   * 有没有装 pdftotext（见 CI 的"单测不触网、不起子进程"约束）。
   */
  extractDocument?: DocumentExtractor;
  now?: () => number;
}

/** 已组装好、待派发的 prompt（含图片与文件的记账，供准入失败时回退与统计）。 */
interface PreparedPrompt {
  blocks: PromptContentBlock[];
  /** 这条消息里一共认出几张图 */
  totalImages: number;
  /** 其中成功编码成 image block 的张数 */
  inlinedImages: number;
  /**
   * 文件摄取的计数。刻意与图片一样**只在这里记账、到 dispatchPrompt 才落数**：
   * 抽取成功不等于 runtime 收下了（见 dispatchPrompt 的准入失败回退），
   * 在 build 期就加会让完全失败的轮次虚报 fileCharsInlined。
   */
  files: FileIngestCounts;
}

/** 文件摄取的计数（ingestFiles 的结果去掉 notes） */
type FileIngestCounts = Omit<FileIngestResult, 'notes'>;

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
   * 话题重置标记（/new 命令或话题间隔超时）：命中的会话在下一次 runTurn 时
   * 跳过冷启动回放——新话题不该背着旧话题的上下文。
   */
  private readonly freshStartMarks = new Set<string>();

  constructor(private readonly deps: TurnRunnerDeps) {}

  /**
   * 强制中断某会话当前进行中的 turn（/stop 命令）。
   *
   * 没有取消 API，终止手段就是回收整个 runtime 进程（在途的后台子代理随之
   * 终止）；forceAbort 让等待中的 runTurn 立刻以 aborted 收尾，用户能马上
   * 收到"已中断"的答复，而不是干等到 turn 超时。
   *
   * @returns 是否确有在途 turn 被中断
   */
  abortConversation(conversationKey: string): boolean {
    const accumulator = this.activeTurns.get(conversationKey);
    this.deps.logger.warn('会话被管理员强制中断，回收 runtime', {
      conversation: conversationKey,
      hadActiveTurn: accumulator !== undefined,
    });
    accumulator?.forceAbort();
    // 回收是异步的；runTurn 的 finally 里的 release 对已被移除的条目是 no-op
    void this.deps.pool.drop(conversationKey).catch(() => {});
    return accumulator !== undefined;
  }

  /** 标记某会话下一条消息开启全新话题（跳过冷启动回放，并重置 runtime）。 */
  markFreshStart(conversationKey: string): void {
    this.freshStartMarks.add(conversationKey);
  }

  /** 终态 handler：在准入 stage 的「并发名额 + 每会话串行锁」之内运行。 */
  async runTurn(ctx: MessageContext): Promise<void> {
    const { message, responder, policy, logger } = ctx;
    const { pool, sessions, paths, stats, conversations, config } = this.deps;
    const conversationKey = message.target.key;

    const workspacePath = ensureWorkspace(paths, conversationKey);
    const startedAt = this.now();
    let accumulator = new TurnAccumulator('pending');
    let entry: RuntimeEntry | undefined;

    // inbox 清理（超期删除 + 总量配额）：turn 一开始做，且只在准入之后——
    // 被闸拦掉的消息不该产生任何文件系统副作用。全程 best-effort，失败只记 warn。
    // 只在"确实在用 inbox"时做：关掉文件读取后还每轮扫一遍目录，会把 agent 自己
    // 放进 inbox 的东西按保留期删掉（它没有任何理由知道那是我们的目录）。
    if (config.attachments.files.enabled && config.attachments.files.saveToInbox) {
      await cleanupInbox({
        workspacePath,
        inboxDir: config.attachments.files.inboxDir,
        retentionDays: config.attachments.files.retentionDays,
        maxBytes: config.attachments.files.maxInboxBytes,
        logger,
      });
    }

    try {
      // 话题判定：新消息与既有话题是否相关由 LLM 判断（不是硬时间间隔——
      // 话题是否结束是语义判断）。判定为无关 → 关闭话题：回收旧 runtime
      // （丢掉内存里的旧上下文）并跳过本次冷启动回放。注意记录 stage 已经把
      // 当前这条消息写进去了，送给判定器的历史要排除它。
      const judge = this.deps.topicJudge;
      // /new 已经标记过新话题的不再重复判定（省一次 API 调用）
      if (judge !== undefined && !this.freshStartMarks.has(conversationKey)) {
        const history = conversations
          .readTail(conversationKey, config.topic.contextTurns + 1)
          .filter(
            (turn) =>
              !(turn.role === 'user' && turn.text === message.content && turn.ts === message.ts),
          );
        if (history.length > 0) {
          const related = await judge({ history, newMessage: message.content });
          if (!related) {
            stats.topicResets += 1;
            logger.info('新消息与既有话题无关（LLM 判定），按新话题处理（重置上下文）', {
              conversation: conversationKey,
              historyTurns: history.length,
            });
            this.freshStartMarks.add(conversationKey);
            await pool.drop(conversationKey).catch(() => {});
          }
        }
      }
      const freshTopic = this.freshStartMarks.delete(conversationKey);

      entry = await pool.acquire(conversationKey, workspacePath);

      // 会话：新建的 runtime 需要新 sessionId + 冷启动回放（新话题除外）
      const session = sessions.ensure(conversationKey, /* rotate */ !entry.replayed);

      accumulator = new TurnAccumulator(session.currentSessionId);
      this.activeTurns.set(conversationKey, accumulator);
      // 用户轮次接管该会话：若此刻恰有一个"自发轮次"在跑（后台任务总结与用户
      // 新消息撞在一起的罕见竞态），丢弃它——两者会并进同一个 running 相位，
      // 父代理对用户问题的最终答复才是本轮要交付的内容（见 DESIGN 13.4）。
      if (this.spontaneousTurns.delete(conversationKey)) {
        logger.debug('用户轮次开始，丢弃进行中的自发轮次累积器');
      }

      const coldStart = !entry.replayed && !freshTopic;
      const promptText = this.buildPrompt(message, conversationKey, session.generation, coldStart);
      // 图片在派发前下载并编码：放在这里（而不是适配器归一化时）是因为
      // 被去重/闸拦掉的消息不该产生网络 IO。
      const prepared = await this.buildPromptBlocks(ctx, promptText, workspacePath);
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

      // 记录本条用户消息的"被动回复锚点"：后台子代理稍后完成时，若仍在被动窗口
      // 内且配额未尽，就能用这个 msg_id 接着 seq 主动补发结果（见 background.ts）。
      // msgTs 用消息到达时间（平台时间戳），窗口判定 = now - msgTs < passiveWindowMs。
      this.deps.background.noteAnchor({
        target: message.target,
        msgId: message.msgId,
        msgTs: message.ts,
        usedSeq: responder.repliesSent,
      });
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

  /**
   * 把自发轮次的最终文本交给 BackgroundPusher：能即时推送就推送（OneBot / 官方
   * 窗口内），否则暂存待下一条用户消息带出。空文本不处理。
   */
  private captureBackgroundResult(conversationKey: string, accumulator: TurnAccumulator): void {
    const text = accumulator.finalText.trim();
    if (text === '') {
      this.deps.logger.debug('自发轮次没有产出可见文本，不投递', { conversation: conversationKey });
      return;
    }
    this.deps.stats.backgroundCaptured += 1;
    this.deps.logger.info('捕获后台任务结果，交由投递器处理', {
      conversation: conversationKey,
      length: text.length,
    });
    this.deps.background.capture(conversationKey, text);
  }

  /**
   * 取出并清空该会话暂存的后台结果，前置到本轮 outcome 的文本上。
   *
   * 前置而不是单独发一条：QQ 被动回复配额是稀缺资源，合并进本轮回复不额外占额。
   * 保留 outcome.kind，让 Responder 照常按结果类型渲染（超时/错误的话术不受影响）。
   */
  private attachPendingBackground(conversationKey: string, outcome: TurnOutcome): TurnOutcome {
    const queue = this.deps.background.takePending(conversationKey);
    if (queue.length === 0) return outcome;
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
   * 组装派发给 runtime 的 prompt content blocks：一个文本块（正文 + 图片/文件
   * 说明与抽取正文）加若干图片块。
   *
   * 设计取舍：
   *   - 图片/文件读不进来**不**是错误：降级成一行文字说明，文字部分照常回答。
   *     群里发张 HEIC 图或一个加密 PDF 就整轮失败，比看不到内容更糟；
   *   - 关闭富媒体时也显式说一句"有 N 张图 / N 个文件未读入"，否则模型会以为
   *     用户什么都没发。
   *   - 统计只在这里**记账**、在 dispatchPrompt 里落数：因为"下载成功"不等于
   *     "runtime 收下了"（见 dispatchPrompt 的准入失败回退）。
   */
  private async buildPromptBlocks(
    ctx: MessageContext,
    text: string,
    workspacePath: string,
  ): Promise<PreparedPrompt> {
    const { config, logger } = this.deps;
    const { enabled, maxImages, maxImageBytes, downloadTimeoutMs } = config.attachments;
    const images = messageImageParts(ctx.message);
    const total = images.length;
    const notes: string[] = [];
    const blocks: PromptContentBlock[] = [];

    // 平台侧取字节：官方需要 access_token，OneBot 可能要动作回查。
    // 绑定 this，避免把方法当自由函数传出去后丢上下文。
    const fetchMedia =
      ctx.connector.fetchMedia !== undefined
        ? (media: RemoteMedia, options: MediaFetchOptions) =>
            ctx.connector.fetchMedia!.call(ctx.connector, media, options)
        : undefined;

    // --- 文件：下载 → 落 inbox →（可选）抽取正文 ---------------------------
    // 与图片分开处理：文件的配额、失败语义与渲染形态都不同（见 config.files）。
    const fileOutcome = await ingestFiles({
      parts: messageMediaParts(ctx.message),
      workspacePath,
      config: config.attachments.files,
      downloadTimeoutMs,
      // 会话上下文是平台侧取件凭据：OneBot 群文件直链申请必须带群号
      context:
        ctx.message.target.kind === 'group'
          ? { groupId: ctx.message.target.id }
          : { userId: ctx.message.target.id },
      ...(fetchMedia !== undefined ? { fetchMedia } : {}),
      ...(this.deps.extractDocument !== undefined
        ? { extract: this.deps.extractDocument }
        : {}),
      logger,
    });
    notes.push(...fileOutcome.notes);

    // --- 图片：内联成多模态 image block -------------------------------------
    let inlined = 0;
    if (total > 0) {
      if (!enabled || maxImages <= 0) {
        notes.push(`（本服务已关闭图片读取，这条消息里的 ${total} 张图片未读入）`);
      } else {
        const result = await buildImageBlocks(images, {
          maxImages,
          maxBytes: maxImageBytes,
          timeoutMs: downloadTimeoutMs,
          ...(fetchMedia !== undefined ? { fetchMedia } : {}),
          logger,
        });
        blocks.push(...result.blocks);
        notes.push(...result.notes);
        inlined = result.blocks.length;
        if (result.notes.length > 0) {
          logger.info('部分图片未能读入，已降级为文字说明', {
            notes: result.notes,
            inlined,
            total,
          });
        }
      }
    }

    const finalText = notes.length > 0 ? `${text}\n${notes.join('\n')}` : text;
    return {
      blocks: [{ type: 'text', text: finalText }, ...blocks],
      totalImages: total,
      inlinedImages: inlined,
      files: {
        fetched: fileOutcome.fetched,
        extracted: fileOutcome.extracted,
        savedOnly: fileOutcome.savedOnly,
        skipped: fileOutcome.skipped,
        charsInlined: fileOutcome.charsInlined,
      },
    };
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
      // 回退用的是同一个文本块，文件正文照旧送达，所以计数照落
      this.commitFileStats(prepared.files);
      return;
    }
    stats.imagesInlined += prepared.inlinedImages;
    stats.imagesSkipped += Math.max(0, prepared.totalImages - prepared.inlinedImages);
    this.commitFileStats(prepared.files);
  }

  /** 文件计数落账：runtime 确实收下了这一轮 prompt 之后才调。 */
  private commitFileStats(files: FileIngestCounts): void {
    const { stats } = this.deps;
    stats.filesFetched += files.fetched;
    stats.filesExtracted += files.extracted;
    stats.filesSavedOnly += files.savedOnly;
    stats.filesSkipped += files.skipped;
    stats.fileCharsInlined += files.charsInlined;
  }

  private elapsedSince(startedAt: number): number {
    return this.now() - startedAt;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
