/**
 * TopicWatcher：话题介入的入口与调度器（runner）。
 *
 * 它是介入层**唯一有副作用的组件**（方案 §5.5）：规则文件夹全是纯函数，
 * 这里负责——
 *   - 持有每群共享状态（state.ts）与规则链（rules/index.ts 注册表）；
 *   - 把 observed 消息按链序喂给 continuation → intake 两条链，逐层触发；
 *   - 续聊晋升（Phase 1）：命中晋升的消息还原成 NormalizedMessage 经
 *     promote 回投口投回 Orchestrator，走完整既有 Ingress 管线；
 *     turn 在途时转入 pending 合并队列，turn 结束后合并冲刷；
 *   - intake 链放行后写入旁听缓冲（Phase 0 的终局；评估/发言在 Phase 2 加入）；
 *   - trace 日志与统计。
 *
 * 平台无关：只依赖 core 的 NormalizedObservedMessage，不 import 任何
 * adapters/* 内部实现（与编排层既有纪律一致）。
 */

import type { ConversationTarget, NormalizedMessage, NormalizedObservedMessage } from '../core/connector.js';
import type { Logger } from '../logger.js';
import type { PipelineStats } from '../pipeline/stats.js';
import { formatTrace, runChain, type ChainResult } from './chain.js';
import type { GateClient, InterventionRule, RuleParamValue, RuleTrigger } from './contract.js';
import { ConversationWatchState, type PhaseDurations } from './state.js';
import { renderStateSummary, renderTranscript } from './transcript.js';

/** 介入层的运行时配置（由 config.ts 产出；见 Config.intervention）。 */
export interface InterventionConfig {
  /** 全局总开关（默认 false，fail-closed；规则 01 消费） */
  enabled: boolean;
  /** 灰度开关：判定照跑、trace 照记、永不发言（Phase 2 生效） */
  dryRun: boolean;
  /** 静态群白名单（来自 BOT_LISTEN_GROUPS，形如 onebot:123456） */
  whitelistGroups: string[];
  buffer: {
    maxMessages: number;
    maxAgeMs: number;
  };
  /** Gate 客户端配置（apiKey 只来自 env DEEPSEEK_API_KEY，由组装层读取） */
  gate: {
    apiBase: string;
    model: string;
    timeoutMs: number;
    maxConcurrent: number;
  };
  /** 按规则名的覆盖：enabled 单独停用某层；params 覆盖该规则参数 */
  rules: Record<
    string,
    { enabled?: boolean; params?: Record<string, RuleParamValue> }
  >;
}

/** 规则注册表（rules/index.ts 的形状；按 stage 分链，链内按 order 升序）。 */
export interface RuleRegistry {
  continuation: InterventionRule[];
  intake: InterventionRule[];
  evaluate: InterventionRule[];
  speak: InterventionRule[];
}

/** health / /listen status 用的介入层快照。 */
export interface InterventionSnapshot {
  enabled: boolean;
  dryRun: boolean;
  conversations: Array<{
    key: string;
    buffered: number;
    runtimeEnabled?: boolean;
    /** 续聊 turn 是否在途（Phase 1） */
    inFlight?: boolean;
    /** pending 合并队列长度（Phase 1；仅在非零时输出） */
    pending?: number;
    /** 介入相位（Phase 2：cold/focus/fading） */
    phase?: string;
  }>;
  /** 按规则名的拦截计数（进程期累计） */
  halts: Record<string, number>;
}

export interface TopicWatcherDeps {
  config: InterventionConfig;
  rules: RuleRegistry;
  stats: PipelineStats;
  logger: Logger;
  now?: () => number;
  /**
   * 晋升回投口（Phase 1）：把还原成的 NormalizedMessage 投回
   * Orchestrator.handleEvent，走完整既有 Ingress 管线。构造时可选，
   * 由组装层在 Orchestrator 建成后经 setPromoter 注入（两者互相持有，
   * 必须有一侧后注入）。
   */
  promote?: (message: NormalizedMessage) => void | Promise<void>;
  /**
   * 语义 Gate（evaluate 链注入；缺省 → 20 号规则 halt('gate-unavailable')，
   * fail-closed 不发言）。
   */
  gate?: GateClient;
  /**
   * 介入发言投递口（Phase 2；组装层接 orchestrator.runIntervention）。
   * 返回 false = 准入 try 被拒（并发满/会话锁占），runner 计数放弃。
   */
  speak?: (message: NormalizedMessage) => Promise<boolean>;
  /** 谷时段探针（03 号规则；缺省 → 该规则放行） */
  offpeakNow?: () => boolean;
  /** 全局并发名额探针（32 号规则） */
  admissionFree?: () => boolean;
  /**
   * 定时器调度（去抖/答案窗口/Gate 重查；返回取消函数）。
   * 缺省用 setTimeout（unref）；测试注入手动时钟。
   */
  schedule?: (fn: () => void, delayMs: number) => () => void;
}

export class TopicWatcher {
  private readonly states = new Map<string, ConversationWatchState>();
  /** 按规则名的拦截计数（health 展示用） */
  private readonly halts = new Map<string, number>();
  /** 每群的静默去抖定时器（重新武装 = 取消旧的挂新的） */
  private readonly debounceTimers = new Map<string, () => void>();
  /** 每群最多一个待触发的 Gate wait 重查 */
  private readonly gateRecheckPending = new Set<string>();
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, delayMs: number) => () => void;
  private promoter: TopicWatcherDeps['promote'];
  private speaker: TopicWatcherDeps['speak'];

  constructor(private readonly deps: TopicWatcherDeps) {
    this.now = deps.now ?? Date.now;
    this.promoter = deps.promote;
    this.speaker = deps.speak;
    this.schedule =
      deps.schedule ??
      ((fn, delayMs) => {
        const timer = setTimeout(fn, delayMs);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    this.assertRegistryKnown();
  }

  /** 组装层注入晋升回投口（Orchestrator 建成后）。 */
  setPromoter(promote: NonNullable<TopicWatcherDeps['promote']>): void {
    this.promoter = promote;
  }

  /** 组装层注入介入发言投递口（Orchestrator 建成后；§9.5 try 语义）。 */
  setSpeaker(speak: NonNullable<TopicWatcherDeps['speak']>): void {
    this.speaker = speak;
  }

  /**
   * 入口：一条旁听到的群消息。同步收口、异步执行（P0 的规则全是同步的，
   * 异步形态是为 evaluate 链的 LLM 判定预留）；任何异常只记日志，不外抛
   * （Orchestrator 的「永不抛错」契约延伸到介入层）。
   *
   * 链序（方案 §5.4）：先 continuation（续聊晋升，命中即离开 watcher 回投
   * 编排层），未命中则落入 intake（入站预筛，Phase 0 的终局是入缓冲）。
   */
  observe(message: NormalizedObservedMessage): void {
    this.deps.stats.observed += 1;
    const state = this.stateFor(message.target.key);
    void this.dispatch(message, state).catch((error: unknown) => {
      this.deps.logger.warn('介入链执行失败（按不处理）', {
        conversation: message.target.key,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * turn 开始派发时调用（main.ts 在 terminal 包装里通知）：
   *   - 标记本会话 inFlight（41 号规则的「在途合并」据此判定）；
   *   - @ 触发的 turn（origin 缺省/'user' 的群 at 消息）为发送者打开续聊窗口
   *     （时长取规则 40 的 windowMs 参数；规则 40 未注册/被停用则不开窗——
   *     开窗也没用，晋升判定就在那条规则里）。
   */
  notifyTurnStarted(message: NormalizedMessage): void {
    const state = this.stateFor(message.target.key);
    state.inFlight = true;
    if ((message.origin ?? 'user') !== 'user' || message.kind !== 'group-at-message') return;
    const rule40 = this.findRule('promotion-window');
    if (rule40 === undefined || !this.isRuleEnabled(rule40)) return;
    const windowMs = Number(this.resolveParams(rule40)['windowMs'] ?? 120_000);
    state.openContinuationWindow(message.senderId, this.now() + windowMs);
  }

  /**
   * turn 结束时调用（terminal 包装的 finally）：解除 inFlight，并冲刷
   * pending 合并队列——仍在窗口内的条目合并为一条晋升消息回投（方案 §8.2）；
   * 过期或窗口已关的条目作废计数。
   */
  notifyTurnEnded(conversationKey: string): void {
    const state = this.states.get(conversationKey);
    if (state === undefined) return;
    state.inFlight = false;
    const pending = state.drainPending();
    if (pending.length === 0) return;

    const now = this.now();
    const limits = this.pendingMergeLimits();
    const fresh = pending.filter((entry) => {
      const alive =
        entry.enqueuedAt >= now - limits.maxAgeMs &&
        (state.continuationWindowUntil(entry.message.senderId) ?? 0) > now;
      return alive;
    });
    this.deps.stats.continuationsDropped += pending.length - fresh.length;
    if (fresh.length === 0) return;

    if (fresh.length === 1) {
      this.promoteNow(fresh[0]!.message, state);
      return;
    }
    const messages = fresh.map((entry) => entry.message);
    this.promoteNow(mergePending(messages), state, [...new Set(messages.map((m) => m.senderId))]);
  }

  /**
   * 一条 @ 消息到达时调用（Orchestrator 在 handleMessage 入口通知）：
   * 官方全量模式下同一 msgId 可能同时以 at/observed 两个事件到达，
   * 把缓冲里对应条目标记 addressed，介入评估跳过它（方案 §12 幂等）。
   */
  markAddressed(conversationKey: string, msgId: string): void {
    this.states.get(conversationKey)?.markAddressed(msgId);
  }

  /** 运行期群开关（/listen on|off，Phase 2 的命令层写入）。 */
  setRuntimeEnabled(conversationKey: string, enabled: boolean): void {
    this.stateFor(conversationKey).runtimeEnabled = enabled;
  }

  /** health / 命令展示用快照。 */
  snapshot(): InterventionSnapshot {
    const conversations: InterventionSnapshot['conversations'] = [];
    for (const [key, state] of this.states) {
      conversations.push({
        key,
        buffered: state.entries.length,
        ...(state.runtimeEnabled !== undefined
          ? { runtimeEnabled: state.runtimeEnabled }
          : {}),
        ...(state.inFlight ? { inFlight: true } : {}),
        ...(state.pendingMerge.length > 0 ? { pending: state.pendingMerge.length } : {}),
        phase: state.phaseAt(this.now()),
      });
    }
    return {
      enabled: this.deps.config.enabled,
      dryRun: this.deps.config.dryRun,
      conversations,
      halts: Object.fromEntries(this.halts),
    };
  }

  /**
   * bot 发出了可见回复时记账（main.ts 从 TurnRunner 的 onBotSpoke 接入）：
   * 09 号规则的「快速回应窗口」与 12 号规则的关键词集都以此为输入。
   */
  notifyBotSpoke(conversationKey: string, text: string, msgIds: readonly string[] = []): void {
    this.stateFor(conversationKey).noteBotSpeech(this.now(), text, msgIds);
  }

  // -------------------------------------------------------------------------

  /** 链序编排：continuation →（未晋升）→ intake →（按 marks）→ evaluate → speak。 */
  private async dispatch(
    message: NormalizedObservedMessage,
    state: ConversationWatchState,
    trigger: RuleTrigger = 'message',
  ): Promise<void> {
    // continuation 链只对平台真实消息触发（定时器重入的消息早已过过它）
    if (trigger === 'message' && this.deps.rules.continuation.length > 0) {
      const promoted = await this.runContinuation(message, state);
      if (promoted) return; // 已离开 watcher（晋升或入合并队列），不再进 intake
    }
    await this.runIntake(message, state, trigger);
  }

  /**
   * continuation 链：返回 true 表示消息已被本链接管（晋升或入合并队列）。
   *
   * 语义纪律：本链的 halt/defer **不是拒绝**，只是「不是续聊」——消息照常
   * 落入 intake 链；所以本链的拦截不进 halts 计数（trace 里可见即可，
   * 否则 no-window 会淹没统计）。
   */
  private async runContinuation(
    message: NormalizedObservedMessage,
    state: ConversationWatchState,
  ): Promise<boolean> {
    const result = await runChain(
      this.deps.rules.continuation,
      {
        message,
        trigger: 'message',
        state,
        marks: {},
        now: this.now(),
      },
      (rule) => this.resolveParams(rule),
      (rule) => this.isRuleEnabled(rule),
    );
    this.deps.logger.debug('rules-trace', {
      conversation: message.target.key,
      msgId: message.msgId,
      trigger: 'continuation',
      trace: formatTrace(result.trace),
    });

    if (result.outcome !== 'passed') return false;
    if (result.marks['promote'] !== true) return false;

    if (result.marks['merge'] === true) {
      // 41 号规则：turn 在途 → 入 pending 合并队列（容量纪律由规则参数决定，
      // 淘汰计数进 continuationsDropped）
      const evicted = state.enqueuePending(message, this.now(), this.pendingMergeLimits());
      this.deps.stats.continuationsDropped += evicted;
      this.deps.stats.continuationsMerged += 1;
      this.deps.logger.debug('续聊晋升转入 pending 合并队列（turn 在途）', {
        conversation: message.target.key,
        msgId: message.msgId,
        pending: state.pendingMerge.length,
        evicted,
      });
      return true;
    }

    this.promoteNow(message, state);
    return true;
  }

  /**
   * 晋升：observed 消息还原成 NormalizedMessage（origin:'continuation'，
   * eventId 用平台真实 id 以便 Ingress 去重拦住平台重推）回投编排层。
   * 晋升即重置续聊窗口（方案 §8.1；合并冲刷时 resetSenders 含全部涉事发送者）。
   * 未装配回投口时不晋升（记日志）。
   */
  private promoteNow(
    message: NormalizedObservedMessage,
    state: ConversationWatchState,
    resetSenders?: readonly string[],
  ): void {
    if (this.promoter === undefined) {
      this.deps.logger.warn('续聊晋升被丢弃：未装配 promote 回投口', {
        conversation: message.target.key,
        msgId: message.msgId,
      });
      return;
    }
    state.seen.claim(message.eventId);
    const windowMs = this.continuationWindowMs();
    const until = this.now() + windowMs;
    for (const senderId of resetSenders ?? [message.senderId]) {
      state.openContinuationWindow(senderId, until);
    }

    const promoted: NormalizedMessage = {
      kind: 'group-at-message',
      target: message.target,
      eventId: message.eventId,
      msgId: message.msgId,
      senderId: message.senderId,
      ...(message.username !== undefined ? { username: message.username } : {}),
      content: message.content,
      origin: 'continuation',
      ts: message.ts,
      raw: message.raw,
    };
    this.deps.stats.continuationsPromoted += 1;
    this.deps.logger.info('续聊晋升：回投编排层走完整管线', {
      conversation: message.target.key,
      msgId: message.msgId,
      senderId: message.senderId,
    });
    Promise.resolve(this.promoter(promoted)).catch((error: unknown) => {
      this.deps.logger.warn('续聊晋升回投失败（按不处理）', {
        conversation: message.target.key,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** 规则 40 的 windowMs 生效值（默认值 ∪ 配置覆盖；规则缺席给兜底）。 */
  private continuationWindowMs(): number {
    const rule = this.findRule('promotion-window');
    if (rule === undefined) return 120_000;
    return Number(this.resolveParams(rule)['windowMs'] ?? 120_000);
  }

  /** 规则 41 的队列容量纪律（默认值 ∪ 配置覆盖；规则缺席给兜底）。 */
  private pendingMergeLimits(): { maxEntries: number; maxAgeMs: number } {
    const rule = this.findRule('inflight-merge');
    if (rule === undefined) return { maxEntries: 5, maxAgeMs: 60_000 };
    const params = this.resolveParams(rule);
    return {
      maxEntries: Number(params['maxPending'] ?? 5),
      maxAgeMs: Number(params['maxAgeMs'] ?? 60_000),
    };
  }

  /** 按名字找注册表里的规则（runner 侧需要消费规则参数时用）。 */
  private findRule(name: string): InterventionRule | undefined {
    return [
      ...this.deps.rules.continuation,
      ...this.deps.rules.intake,
      ...this.deps.rules.evaluate,
      ...this.deps.rules.speak,
    ].find((rule) => rule.name === name);
  }

  private async runIntake(
    message: NormalizedObservedMessage,
    state: ConversationWatchState,
    trigger: RuleTrigger = 'message',
  ): Promise<void> {
    const result: ChainResult = await runChain(
      this.deps.rules.intake,
      {
        message,
        trigger,
        state,
        marks: {},
        now: this.now(),
        ...(this.deps.offpeakNow !== undefined
          ? { offpeakNow: this.deps.offpeakNow() }
          : {}),
      },
      (rule) => this.resolveParams(rule),
      (rule) => this.isRuleEnabled(rule),
    );

    this.deps.logger.debug('rules-trace', {
      conversation: message.target.key,
      msgId: message.msgId,
      trigger: `intake:${trigger}`,
      trace: formatTrace(result.trace),
    });

    if (result.outcome === 'halted') {
      if (result.haltedBy !== undefined) this.countHalt(result.haltedBy);
      this.deps.stats.observedHalted += 1;
      // 硬限流命中 → 相位强制降 fading 冷却（方案 §9.3，迁移表联动）
      if (result.haltedBy === 'rate-limit-precheck') {
        state.applyPhaseEvent('rate-limit-hit', this.now(), this.phaseDurations());
      }
      // halt(buffer:true)：不评估但仍入缓冲做上下文（05/06 号规则）
      if (result.bufferRequested === true) state.pushEntry(message, this.now());
      return;
    }

    if (result.outcome === 'deferred') {
      // 11 号规则的答案窗口：消息先入缓冲做上下文，挂定时器到期重查
      state.pushEntry(message, this.now());
      const key = message.target.key;
      this.schedule(() => {
        void this.dispatch(message, this.stateFor(key), 'answer-window').catch(
          (error: unknown) => {
            this.deps.logger.warn('答案窗口重查失败（按不处理）', {
              conversation: key,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        );
      }, result.deferMs ?? 90_000);
      return;
    }

    // 全层通过：入缓冲，然后按 marks 决定评估时机（方案 §5.4 ②）
    state.pushEntry(message, this.now());
    if (this.deps.rules.evaluate.length === 0) return; // evaluate 链未装配：只听不评
    if (result.marks.strongSignal !== undefined || result.marks.samplingHit === true) {
      await this.runEvaluate(state, trigger);
      return;
    }
    this.armDebounce(state);
  }

  /**
   * evaluate 链（方案 §5.4 ③）：进入即记账（冷却/采样原点），
   * Gate 判 silent 进冷却（相位事件），判 wait 排一次重查，判 speak 进 speak 链。
   */
  private async runEvaluate(state: ConversationWatchState, trigger: RuleTrigger): Promise<void> {
    const now = this.now();
    state.recordEvaluate(now);
    const gateRule = this.findRule('semantic-gate');
    const contextMessages = Number(
      gateRule !== undefined ? (this.resolveParams(gateRule)['contextMessages'] ?? 30) : 30,
    );
    const gate = this.countingGate();

    const result = await runChain(
      this.deps.rules.evaluate,
      {
        message: undefined,
        trigger,
        state,
        marks: {},
        now,
        ...(gate !== undefined ? { gate } : {}),
        transcript: () => renderTranscript(state.entries, contextMessages),
        stateSummary: () =>
          renderStateSummary({
            phase: state.phaseAt(now),
            lastSpokeAgoSec:
              state.botLastSpokeAt === undefined
                ? undefined
                : Math.max(0, Math.round((now - state.botLastSpokeAt) / 1000)),
            interventionsLast10Min: state.countSpokeSince(now - 600_000),
            interventionsLastHour: state.countSpokeSince(now - 3_600_000),
            recentMessages10Min: state.entries.filter((e) => e.ts >= now - 600_000).length,
          }),
      },
      (rule) => this.resolveParams(rule),
      (rule) => this.isRuleEnabled(rule),
    );

    this.deps.logger.debug('rules-trace', {
      conversation: state.key,
      trigger: `evaluate:${trigger}`,
      trace: formatTrace(result.trace),
    });

    if (result.outcome === 'halted') {
      if (result.haltedBy !== undefined) this.countHalt(result.haltedBy);
      if (result.reason === 'gate-silent') {
        state.applyPhaseEvent('gate-silent', now, this.phaseDurations());
      }
      return;
    }

    if (result.outcome === 'deferred') {
      // Gate 判 wait：每群最多挂一个重查（最多重查一次由规则保证）
      if (this.gateRecheckPending.has(state.key)) return;
      this.gateRecheckPending.add(state.key);
      this.schedule(() => {
        this.gateRecheckPending.delete(state.key);
        void this.runEvaluate(state, 'gate-wait-recheck').catch((error: unknown) => {
          this.deps.logger.warn('Gate 重查失败（按不处理）', {
            conversation: state.key,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, result.deferMs ?? 30_000);
      return;
    }

    if (result.marks.gateDecision === 'speak') {
      await this.runSpeak(state, trigger);
    }
  }

  /**
   * speak 链（方案 §5.4 ④）：否决式复审，全过才合成介入 turn。
   * 介入绝不排队——投递口返回 false 即放弃计数。
   */
  private async runSpeak(state: ConversationWatchState, trigger: RuleTrigger): Promise<void> {
    const now = this.now();
    const result = await runChain(
      this.deps.rules.speak,
      {
        message: undefined,
        trigger,
        state,
        marks: {},
        now,
        ...(this.deps.admissionFree !== undefined
          ? { admissionFree: this.deps.admissionFree() }
          : {}),
      },
      (rule) => this.resolveParams(rule),
      (rule) => this.isRuleEnabled(rule),
    );

    this.deps.logger.debug('rules-trace', {
      conversation: state.key,
      trigger: `speak:${trigger}`,
      trace: formatTrace(result.trace),
    });

    if (result.outcome !== 'passed') {
      if (result.haltedBy !== undefined) this.countHalt(result.haltedBy);
      if (result.haltedBy === 'rate-limit-veto') {
        state.applyPhaseEvent('rate-limit-hit', now, this.phaseDurations());
      }
      return;
    }

    if (this.deps.config.dryRun) {
      this.deps.stats.interventionsDryRun += 1;
      this.deps.logger.info('dryRun：判定应发言但不投递', { conversation: state.key, trigger });
      return;
    }
    if (this.speaker === undefined) {
      this.deps.logger.warn('介入被丢弃：未装配 speak 投递口', { conversation: state.key });
      return;
    }

    const message = this.synthesizeIntervention(state, now);
    if (message === undefined) return;
    const sent = await this.speaker(message);
    if (sent) {
      this.deps.stats.interventionsSent += 1;
      state.applyPhaseEvent('spoke', now, this.phaseDurations());
      this.deps.logger.info('已发起介入 turn', { conversation: state.key, trigger });
    } else {
      // 准入 try 被拒（并发满/会话锁占）：放弃本次介入
      this.deps.stats.interventionsDroppedBusy += 1;
    }
  }

  /** 合成介入 turn 的 NormalizedMessage（方案 §9.4：转录 + 介入指令）。 */
  private synthesizeIntervention(
    state: ConversationWatchState,
    now: number,
  ): NormalizedMessage | undefined {
    const target = state.target;
    if (target === undefined) {
      this.deps.logger.warn('介入被丢弃：会话缺少 target（不应发生）', { conversation: state.key });
      return undefined;
    }
    const gateRule = this.findRule('semantic-gate');
    const contextMessages = Number(
      gateRule !== undefined ? (this.resolveParams(gateRule)['contextMessages'] ?? 30) : 30,
    );
    const last = state.entries[state.entries.length - 1];
    const transcript = renderTranscript(state.entries, contextMessages);
    return {
      kind: 'group-at-message',
      target,
      eventId: `intervention:${state.key}:${now}`,
      msgId: last?.msgId ?? '',
      senderId: 'intervention',
      username: '(介入)',
      content:
        `${transcript}\n` +
        '（你作为群成员主动参与以上话题。这是一次自主介入，不是用户委托的任务：' +
        '只输出你要在群里说的那段话；除非话题明确需要，不要执行工具或产生文件；' +
        '如果转录里有对你的直接提问，优先回答它。）',
      origin: 'intervention',
      ts: now,
      raw: {},
    };
  }

  /** 静默去抖：无新消息达 silenceDebounceMs 后以 trigger='debounce' 进 evaluate 链。 */
  private armDebounce(state: ConversationWatchState): void {
    if (this.deps.rules.evaluate.length === 0) return;
    const rule13 = this.findRule('sampling-debounce');
    const debounceMs = Number(
      rule13 !== undefined ? (this.resolveParams(rule13)['silenceDebounceMs'] ?? 20_000) : 20_000,
    );
    this.debounceTimers.get(state.key)?.();
    this.debounceTimers.set(
      state.key,
      this.schedule(() => {
        this.debounceTimers.delete(state.key);
        if (state.unevaluatedCount === 0) return; // 没有新内容可评
        void this.runEvaluate(state, 'debounce').catch((error: unknown) => {
          this.deps.logger.warn('去抖评估失败（按不处理）', {
            conversation: state.key,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, debounceMs),
    );
  }

  /** 相位迁移参数（规则 31 的 params 生效值；runner 执行迁移时消费）。 */
  private phaseDurations(): PhaseDurations {
    const rule = this.findRule('focus-budget');
    const params = rule !== undefined ? this.resolveParams(rule) : {};
    return {
      focusMs: Number(params['focusMs'] ?? 120_000),
      fadingMs: Number(params['fadingMs'] ?? 120_000),
      focusMaxReplies: Number(params['focusMaxReplies'] ?? 2),
    };
  }

  /** Gate 调用的计数包装（gateCalls/gateErrors 统计）。 */
  private countingGate(): GateClient | undefined {
    const gate = this.deps.gate;
    if (gate === undefined) return undefined;
    const stats = this.deps.stats;
    return {
      judge: async (input) => {
        stats.gateCalls += 1;
        const verdict = await gate.judge(input);
        if (verdict.reason === 'gate-call-failed' || verdict.reason === 'gate-output-unparseable') {
          stats.gateErrors += 1;
        }
        return verdict;
      },
    };
  }

  private countHalt(ruleName: string): void {
    this.halts.set(ruleName, (this.halts.get(ruleName) ?? 0) + 1);
  }

  private stateFor(conversationKey: string): ConversationWatchState {
    let state = this.states.get(conversationKey);
    if (state === undefined) {
      state = new ConversationWatchState(conversationKey, {
        maxMessages: this.deps.config.buffer.maxMessages,
        maxAgeMs: this.deps.config.buffer.maxAgeMs,
      });
      this.states.set(conversationKey, state);
    }
    return state;
  }

  /**
   * 参数合并：规则 paramsSpec 默认值 ← 全局注入（master-switch 的 enabled 来自
   * 总开关，group-whitelist 的 groups 来自 BOT_LISTEN_GROUPS）← qqbot.yml 的
   * intervention.rules.<name>.params 覆盖。
   */
  private resolveParams(rule: InterventionRule): Readonly<Record<string, RuleParamValue>> {
    const merged: Record<string, RuleParamValue> = { ...rule.paramsSpec };
    if (rule.name === 'master-switch') {
      merged['enabled'] = this.deps.config.enabled;
    }
    if (rule.name === 'group-whitelist') {
      merged['groups'] = this.deps.config.whitelistGroups.join(',');
    }
    const override = this.deps.config.rules[rule.name]?.params;
    if (override !== undefined) Object.assign(merged, override);
    return merged;
  }

  private isRuleEnabled(rule: InterventionRule): boolean {
    return this.deps.config.rules[rule.name]?.enabled !== false;
  }

  /** 启动期校验：配置里出现的规则名必须已注册（拼错键名不静默放过）。 */
  private assertRegistryKnown(): void {
    const registered = new Set(
      [
        ...this.deps.rules.continuation,
        ...this.deps.rules.intake,
        ...this.deps.rules.evaluate,
        ...this.deps.rules.speak,
      ].map((rule) => rule.name),
    );
    for (const name of Object.keys(this.deps.config.rules)) {
      if (!registered.has(name)) {
        this.deps.logger.warn('配置里出现未注册的介入规则名，将被忽略', {
          rule: name,
          registered: [...registered],
        });
      }
    }
  }
}

/**
 * 把多条 pending 消息合并成一条合成 observed 消息（方案 §8.2 的合并格式）。
 * 同一发送者 → 「用户连发多条，合并处理：\n1. …\n2. …」；
 * 多发送者 → 每行带发送者名前缀，避免丢失归属。
 * eventId 合成 `merge:<首>:<尾>`（唯一性足以过 Ingress 去重）；
 * msgId/ts/senderId 取最后一条（被动回复锚点越新越好）。
 */
function mergePending(messages: readonly NormalizedObservedMessage[]): NormalizedObservedMessage {
  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  const sameSender = messages.every((m) => m.senderId === first.senderId);
  const lines = messages.map((m, i) => {
    const text = m.content.replace(/\n/g, ' ');
    return sameSender ? `${i + 1}. ${text}` : `${i + 1}. [${m.username ?? m.senderId}] ${text}`;
  });
  return {
    kind: 'group-message-observed',
    target: first.target,
    eventId: `merge:${first.eventId}:${last.eventId}`,
    msgId: last.msgId,
    senderId: last.senderId,
    ...(last.username !== undefined ? { username: last.username } : {}),
    content: `「用户连发多条，合并处理：\n${lines.join('\n')}」`,
    atOthers: false,
    ts: last.ts,
    raw: { mergedEventIds: messages.map((m) => m.eventId) },
  };
}
