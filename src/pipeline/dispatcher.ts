/**
 * 编排器：把一条用户消息（群聊或单聊，任意接入平台）变成一次 DSH turn，
 * 再把结果变成该平台的回复。
 *
 * 一次完整流程：
 *
 *   1. 事件去重（claim）——重复投递直接丢弃
 *   2. 记录用户消息到对话记录（供重启后回放）
 *   3. 取全局并发名额（有界，满了就礼貌拒绝而不是无限排队）
 *   4. 每会话串行（同一群/同一人同时只跑一条，避免事件流交错）
 *   5. 取该会话的 DSH runtime（必要时新建进程 + 冷启动回放）
 *   6. 起进度回执调度器（策略来自该平台该会话类型的 ReplyPolicy）
 *   7. session/prompt 派发
 *   8. 消费事件：累积 assistant 文本、记 turn/end
 *   9. status 回 idle 且本轮已 turn/end → 结束
 *  10. 分段 + 按配额发回复（经 BotConnector.reply，平台专有行为在适配器内）
 *  11. 记录助手消息
 *
 * 关键不变量：`ReplyLedger` 是**唯一**分配回复序号的地方，且进度回执永远不能
 * 吃掉最终答案的配额。
 *
 * 平台差异只通过两个接缝进入本文件：
 *   - `target.platform` → 路由到对应 BotConnector；
 *   - `connector.policy(kind)` → 配额/分段/进度/超时的全部取值。
 * 本文件不允许 import 任何 adapters/* 内部实现。
 */

import { join } from 'node:path';

import type { Config } from '../config.js';
import type {
  BotConnector,
  ConversationTarget,
  NormalizedEvent,
  NormalizedMessage,
  ReplyPolicy,
} from '../core/connector.js';
import { isUserMessage } from '../core/connector.js';
import type { Logger } from '../logger.js';
import {
  CN_HOLIDAYS_2026,
  commandNeedsAdmin,
  evaluateGate,
  formatWindows,
  OffpeakConfigError,
  OffpeakGate,
  OFFPEAK_COMMAND_USAGE,
  parseOffpeakCommand,
  parseWindowsSpec,
  renderGateNotice,
  type OffpeakCommand,
  type OffpeakSnapshot,
} from '../offpeak.js';
import type { RuntimeEntry, RuntimePool } from '../dsh/pool.js';
import type { SessionStatusNotification } from '../dsh/protocol.js';
import { TurnAccumulator, type TurnOutcome } from '../dsh/turns.js';
import type { ConversationStore } from '../store/conversations.js';
import { renderReplay } from '../store/conversations.js';
import type { SeenStore } from '../store/seen.js';
import type { SessionStore } from '../store/sessions.js';
import { ensureWorkspace, type StorePaths } from '../store/paths.js';
import { KeyedMutex, Semaphore, waitUntil } from './concurrency.js';
import { defaultProgressText } from './progress.js';
import { Responder } from './responder.js';
import { PipelineStats } from './stats.js';

export interface DispatcherDeps {
  config: Config;
  logger: Logger;
  pool: RuntimePool;
  /** 平台标识 → 连接器。回复按 target.platform 路由。 */
  connectors: ReadonlyMap<string, BotConnector>;
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
  /** 被谷时段闸拦截的消息数（未调用 API） */
  gatedOffpeak: number;
  /** 处理过的 /offpeak 命令数 */
  adminCommands: number;
  completed: number;
  failed: number;
  timedOut: number;
  repliesSent: number;
  progressSent: number;
}

export class Dispatcher {
  private readonly semaphore: Semaphore;
  private readonly conversationLock = new KeyedMutex();
  private readonly stats = new PipelineStats();

  /**
   * 每个会话当前进行中的 turn 累积器，供事件路由定位。
   * 结束判定用轮询 `isSettled`（见 runTurn），因此这里不需要额外的完成回调。
   */
  private readonly activeTurns = new Map<string, TurnAccumulator>();

  /**
   * 谷时段闸。生效配置 = env 默认 + 运行期覆盖（持久化在 stateDir，
   * 由管理员 /offpeak 命令热切换，下一条消息即生效）。
   */
  private readonly offpeak: OffpeakGate;

  constructor(private readonly deps: DispatcherDeps) {
    this.semaphore = new Semaphore(deps.config.pool.maxConcurrentTurns);
    this.offpeak = new OffpeakGate({
      defaults: {
        enabled: deps.config.offpeak.enabled,
        windows: deps.config.offpeak.windows,
        timeZone: deps.config.offpeak.timeZone,
        modelPattern: deps.config.offpeak.modelPattern,
        weekendsAllDay: deps.config.offpeak.weekendsAllDay,
        holidays: new Set([...CN_HOLIDAYS_2026, ...deps.config.offpeak.holidays]),
      },
      filePath: join(deps.paths.stateDir, 'offpeak-override.json'),
      logger: deps.logger.child({ component: 'offpeak' }),
      now: deps.now,
    });
  }

  snapshotStats(): DispatcherStats & { inFlight: number; queued: number; offpeak: OffpeakSnapshot } {
    return {
      ...this.stats,
      inFlight: this.semaphore.inUse,
      queued: this.semaphore.queued,
      offpeak: this.offpeak.snapshot(),
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
  // 用户消息（群聊 / 单聊，任意平台）
  // -------------------------------------------------------------------------

  private async handleMessage(message: NormalizedMessage): Promise<void> {
    const { logger, seen } = this.deps;
    this.stats.received += 1;

    const connector = this.connectorFor(message.target);
    if (connector === undefined) return;
    const policy = connector.policy(message.target.kind);

    // 单聊开关：订阅层往往无法只收群聊，所以在业务层拦。
    if (message.target.kind === 'c2c' && !connector.acceptsC2C) {
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
      platform: message.target.platform,
      kind: message.target.kind,
      msgId: message.msgId,
    });

    // --- 谷时段闸：命令与拦截都发生在「记录对话 / 占名额」之前 -------------
    // 被拦截的消息不写对话记录、不占并发名额、不碰 DSH 进程，就像它没来过。
    const isAdmin = this.isAdmin(message);

    // /offpeak 命令优先于闸：管理员必须能在峰时段发命令关闸。
    const command = parseOffpeakCommand(message.content);
    if (command !== undefined) {
      await this.handleOffpeakCommand(message, command, isAdmin, messageLogger);
      return;
    }

    const decision = evaluateGate({
      config: this.offpeak.effective(),
      provider: this.deps.config.dsh.provider,
      model: this.deps.config.dsh.model,
      isAdmin,
      now: this.now(),
    });
    if (decision.gated) {
      this.stats.gatedOffpeak += 1;
      messageLogger.info('谷时段闸拦截：当前为正价时段，未调用 API', {
        senderId: message.senderId,
        offpeak: this.offpeak.snapshot(),
      });
      await this.replySimple(message, renderGateNotice(this.offpeak.effective())).catch(
        () => {},
      );
      return;
    }
    if (decision.reason === 'admin') {
      messageLogger.debug('管理员消息，谷时段闸放行', { senderId: message.senderId });
    }

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
      await this.replySimple(message, '处理你的请求时出错了，我已经记录到日志。').catch(
        () => {},
      );
    } finally {
      release();
    }
  }

  private async runTurn(message: NormalizedMessage, logger: Logger): Promise<void> {
    const { pool, sessions, paths } = this.deps;
    const conversationKey = message.target.key;
    const connector = this.connectorFor(message.target);
    if (connector === undefined) return;
    const policy = connector.policy(message.target.kind);

    const workspacePath = ensureWorkspace(paths, conversationKey);
    // Egress 收口：本轮的进度回执与最终答复都经它发出（唯一配额账本）
    const responder = new Responder({
      message,
      connector,
      policy,
      conversations: this.deps.conversations,
      stats: this.stats,
      logger,
      ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
    });

    const startedAt = this.now();
    let accumulator = new TurnAccumulator('pending');
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

      responder.startProgress(() =>
        defaultProgressText(this.elapsedSince(startedAt), accumulator.toolsInvoked),
      );

      // 结束条件：status 回 idle 且本轮已 turn/end（由 routeSessionStatus 触发 finish）
      const settled = await waitUntil(() => accumulator.isSettled, policy.turnTimeoutMs, 120);

      let outcome: TurnOutcome;
      if (settled) {
        outcome = accumulator.result();
        this.stats.completed += 1;
      } else {
        this.stats.timedOut += 1;
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

  /** 按 target 取连接器；未知平台说明适配器注册与事件来源不一致（属于 bug）。 */
  private connectorFor(target: ConversationTarget): BotConnector | undefined {
    const connector = this.deps.connectors.get(target.platform);
    if (connector === undefined) {
      this.deps.logger.warn('收到未知平台的事件，已丢弃', {
        platform: target.platform,
        conversation: target.key,
      });
    }
    return connector;
  }

  /** 管理员判定：白名单条目是 `platform:senderId` 组合（见 BOT_ADMINS）。 */
  private isAdmin(message: NormalizedMessage): boolean {
    return this.deps.config.admins.includes(`${message.target.platform}:${message.senderId}`);
  }

  private buildPrompt(
    message: NormalizedMessage,
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

  // -------------------------------------------------------------------------
  // 谷时段闸：/offpeak 命令
  // -------------------------------------------------------------------------

  /**
   * 处理 /offpeak 命令。整个流程不触碰对话记录、并发名额与 DSH runtime。
   *
   * 权限模型：status / whoami 对所有人开放（不消耗 API，且 whoami 是管理员
   * 发现自己平台身份的唯一入口）；变更类操作（on/off/window/reset）仅管理员。
   * 白名单为空时变更类命令对所有人关闭——fail-closed。
   */
  private async handleOffpeakCommand(
    message: NormalizedMessage,
    command: OffpeakCommand,
    isAdmin: boolean,
    logger: Logger,
  ): Promise<void> {
    if (commandNeedsAdmin(command) && !isAdmin) {
      logger.warn('非管理员尝试变更谷时段闸，已拒绝', {
        senderId: message.senderId,
        platform: message.target.platform,
        action: command.action,
      });
      await this.replySimple(
        message,
        '无权限：/offpeak 的变更操作仅限管理员（BOT_ADMINS 白名单）。',
      ).catch(() => {});
      return;
    }

    this.stats.adminCommands += 1;

    switch (command.action) {
      case 'whoami': {
        const idKind = message.target.kind === 'c2c' ? '单聊' : '群聊';
        await this.replySimple(
          message,
          `你的管理员身份键：${message.target.platform}:${message.senderId}` +
            `（${idKind}，平台 ${message.target.platform}）。` +
            '把它加进环境变量 BOT_ADMINS（逗号分隔）即可成为管理员。',
        ).catch(() => {});
        return;
      }
      case 'status': {
        await this.replySimple(message, this.renderOffpeakStatus()).catch(() => {});
        return;
      }
      case 'set-enabled': {
        const effective = this.offpeak.setEnabled(command.enabled, message.senderId);
        logger.warn('谷时段闸已被管理员热切换', {
          senderId: message.senderId,
          platform: message.target.platform,
          enabled: command.enabled,
        });
        await this.replySimple(
          message,
          `谷时段闸已${command.enabled ? '开启' : '关闭'}（运行期覆盖，重启后保留）。` +
            `当前窗口：${formatWindows(effective.windows)}（${effective.timeZone}）。`,
        ).catch(() => {});
        return;
      }
      case 'set-windows': {
        try {
          const windows = parseWindowsSpec(command.spec);
          const effective = this.offpeak.setWindows(windows, message.senderId);
          logger.warn('谷时段窗口已被管理员热切换', {
            senderId: message.senderId,
            platform: message.target.platform,
            windows: command.spec,
          });
          await this.replySimple(
            message,
            `谷时段窗口已更新为 ${formatWindows(effective.windows)}（${effective.timeZone}，运行期覆盖）。`,
          ).catch(() => {});
        } catch (error) {
          const detail =
            error instanceof OffpeakConfigError ? error.message : '窗口参数无效';
          await this.replySimple(message, `设置失败：${detail}`).catch(() => {});
        }
        return;
      }
      case 'holiday-add':
      case 'holiday-del': {
        const adding = command.action === 'holiday-add';
        try {
          if (adding) {
            this.offpeak.addHoliday(command.date, message.senderId);
          } else {
            this.offpeak.delHoliday(command.date, message.senderId);
          }
          const snapshot = this.offpeak.snapshot();
          logger.warn('谷时段节假日表已被管理员热更新', {
            senderId: message.senderId,
            platform: message.target.platform,
            action: command.action,
            date: command.date,
          });
          await this.replySimple(
            message,
            `已${adding ? '追加' : '移除'}全天谷价日期 ${command.date}（运行期覆盖）。` +
              `当前节假日表共 ${snapshot.holidaysCount} 天。`,
          ).catch(() => {});
        } catch (error) {
          const detail = error instanceof OffpeakConfigError ? error.message : '日期参数无效';
          await this.replySimple(message, `设置失败：${detail}`).catch(() => {});
        }
        return;
      }
      case 'holiday-list': {
        const holidays = [...this.offpeak.effective().holidays].sort();
        const text =
          holidays.length === 0
            ? '节假日表为空。'
            : `全天谷价日期（${holidays.length} 天）：${holidays.join('、')}`;
        await this.replySimple(message, text).catch(() => {});
        return;
      }
      case 'reset': {
        this.offpeak.clearOverride(message.senderId);
        logger.warn('谷时段闸覆盖已被管理员清除，恢复 env 默认', {
          senderId: message.senderId,
          platform: message.target.platform,
        });
        await this.replySimple(message, this.renderOffpeakStatus()).catch(() => {});
        return;
      }
      case 'invalid': {
        await this.replySimple(
          message,
          `${command.detail}。${OFFPEAK_COMMAND_USAGE}`,
        ).catch(() => {});
        return;
      }
    }
  }

  /** 闸状态的纯文本描述（status 命令与 reset 后的回执共用）。 */
  private renderOffpeakStatus(): string {
    const snapshot = this.offpeak.snapshot();
    const { config } = this.deps;
    const decision = evaluateGate({
      config: this.offpeak.effective(),
      provider: config.dsh.provider,
      model: config.dsh.model,
      isAdmin: false,
      now: this.now(),
    });
    const reasonText: Record<string, string> = {
      weekend: '周末全天谷价',
      holiday: '法定节假日全天谷价',
      'in-window': '谷时段窗口内',
      'model-mismatch': '模型不匹配',
      disabled: '闸已关闭',
      admin: '管理员',
    };
    const lines = [
      `谷时段闸：${snapshot.enabled ? '开启' : '关闭'}${snapshot.overridden ? '（管理员覆盖）' : '（env 默认）'}`,
      `工作日窗口：${snapshot.windows.join('、')}（${snapshot.timeZone}）`,
      `周末全天谷价：${snapshot.weekendsAllDay ? '是' : '否'}；` +
        `节假日表 ${snapshot.holidaysCount} 天` +
        (snapshot.holidaysCoverageUntil !== undefined
          ? `（覆盖至 ${snapshot.holidaysCoverageUntil}，之后年份需管理员 /offpeak holiday add）`
          : ''),
      `模型匹配：${snapshot.modelPattern}；当前模型 ${config.dsh.provider}/${config.dsh.model}`,
      `当前判定：${decision.gated ? '拦截中（正价时段）' : `放行（${reasonText[decision.reason] ?? decision.reason}）`}`,
      OFFPEAK_COMMAND_USAGE,
    ];
    return lines.join('\n');
  }

  /** 发一条简单回复（错误/忙提示）。配额不足时静默失败。 */
  private async replySimple(message: NormalizedMessage, text: string): Promise<void> {
    const connector = this.connectorFor(message.target);
    if (connector === undefined) return;
    const policy = connector.policy(message.target.kind);
    const responder = new Responder({
      message,
      connector,
      policy,
      conversations: this.deps.conversations,
      stats: this.stats,
      logger: this.deps.logger,
      ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
    });
    await responder.error(text);
  }

  // -------------------------------------------------------------------------
  // 进群 / 加好友欢迎
  // -------------------------------------------------------------------------

  private async handleWelcome(event: NormalizedEvent): Promise<void> {
    if (event.kind !== 'group-add-robot' && event.kind !== 'c2c-friend-add') return;
    const target = event.target;
    if (target === undefined) return;
    const connector = this.connectorFor(target);
    if (connector === undefined) return;
    if (target.kind === 'c2c' && !connector.acceptsC2C) return;

    const { logger } = this.deps;
    const text =
      target.kind === 'c2c'
        ? '我是运行在 Docker 里的 DSH 助手。直接给我发消息说明需求即可。'
        : '我是运行在 Docker 里的 DSH 助手。在群里 @我 并说明需求即可。';
    logger.info(target.kind === 'c2c' ? '用户添加好友，发送欢迎语' : '机器人进群，发送欢迎语', {
      conversation: target.key,
      platform: target.platform,
    });
    try {
      // 官方平台回复进群/加好友事件必须用 event_id（与 msg_id 互斥）；
      // 无此概念的平台会忽略 eventId，直接当作普通消息发出。
      await connector.reply(
        {
          target,
          seq: 1,
          kind: 'final',
          ...(event.eventId !== undefined && event.eventId !== '' ? { eventId: event.eventId } : {}),
        },
        { text },
      );
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
