/**
 * 主动介入的**唯一 runner**：把「旁听消息 → 状态 → 搜集 → 判定 → 否决 → 投递」
 * 串起来，并持有全部定时器。这是本模块唯一有副作用的组件。
 *
 * ## 触发面（三种，与场景声明一一对应）
 *
 * | 触发 | 什么时候 | 参与的场景 |
 * |---|---|---|
 * | `message` | 每条旁听消息 | 场景 1（续聊追问）、场景 4（指代） |
 * | `question-probe` | 问题挂起 `questionProbeMs`（默认 90s）后 | 场景 3（无人应答） |
 * | `topic-roll` | 每 N 条消息**或** M 分钟无评估 | 场景 2（持续讨论）、场景 5（兴趣） |
 *
 * ## 四条硬纪律
 *
 * 1. **永不抛错**：入口 `observe()` 同步返回（只入状态、排定时器），真正的
 *    评估在 `void evaluate().catch()` 里收口——旁听消息绝不能把主链路带崩。
 * 2. **成本闸在最前面**：白名单关 → 直接 return（连状态都不入）；
 *    `collectCandidates` 返回空 → **不调 LLM**。
 * 3. **同一会话不并发评估**：评估中再来触发就丢弃（主动发言"排队"没有意义，
 *    话题早翻篇了——与准入 try 同构）。
 * 4. **额度按会话记**：限流计数是**每会话**的，不是全局的。全局计数会让
 *    A 群的发言把 B 群的额度吃掉（多群部署下这是最容易被忽略的串味）。
 */

import type { ConversationTarget, NormalizedMessage } from '../../../core/connector.js';
import type { Logger } from '../../../logger.js';
import type { InterestPool } from '../interests/pool.js';
import { buildSceneEvidence, collectCandidates } from './collect.js';
import {
  ConversationStateStore,
  type ConversationState,
  type ConversationStateOptions,
} from './state.js';
import { renderFacts, renderTranscript } from './transcript.js';
import { DEFAULT_VETO_POLICY, evaluateVeto } from '../veto/veto.js';
import type { ProactiveJudge } from '../judge/client.js';
import {
  isSent,
  isWouldSend,
  type ProactiveSpeaker,
  type ProactiveTrigger,
} from '../deliver/speaker.js';
import type {
  ProactiveDecision,
  SceneCandidate,
  SceneEvidence,
  SceneId,
  SceneTrigger,
  VetoContext,
  VetoPolicy,
} from '../contract.js';

export interface ProactiveWatcherConfig {
  /** 总开关（默认 false） */
  enabled: boolean;
  /** 灰度观察：判定照跑、记录"本应发送"，但不真发 */
  dryRun: boolean;
  /**
   * 群白名单：**空数组 = 不接任何群**（fail-closed）。
   * 条目可以是会话键（`ob11:g123456`）或 `平台:群号`（`onebot:123456`）。
   */
  whitelistGroups: readonly string[];
  /** bot 在本群的别名（场景 4 指代检测） */
  botAliases: readonly string[];
  /** 话题滚动：每多少条旁听消息收敛一次（场景 2/5） */
  topicRollMessages: number;
  /** 话题滚动：多久没评估则兜底收敛一次 */
  topicRollMs: number;
  /** 问题挂起多久后探针（场景 3 的答案窗口） */
  questionProbeMs: number;
  /** 同一问题最多探针几次（超过即静默，不反复撞同一堵墙） */
  maxQuestionProbes: number;
  /** 判定连续失败多少次后暂停该会话的评估（避免往坏掉的 API 刷请求） */
  maxJudgeFailures: number;
  /** 每会话限流窗口：10 分钟 / 1 小时内的主动发言上限（与 veto 策略同口径） */
  rateLimit10Min: number;
  rateLimit1Hour: number;
  /** 旁听状态参数（缓冲上限等） */
  stateOptions?: ConversationStateOptions;
  /** 否决层策略（覆盖默认值） */
  vetoPolicy?: Partial<VetoPolicy>;
}

export const DEFAULT_WATCHER_CONFIG = {
  whitelistGroups: [] as readonly string[],
  botAliases: [] as readonly string[],
  topicRollMessages: 30,
  topicRollMs: 300_000,
  questionProbeMs: 90_000,
  maxQuestionProbes: 2,
  maxJudgeFailures: 3,
  rateLimit10Min: 3,
  rateLimit1Hour: 8,
} as const;

export interface WatcherMetrics {
  /** 进入判定的评估次数（按触发面） */
  evaluated(trigger: SceneTrigger): void;
  /** 判定失败（timeout / http / 解析） */
  judgeFailed(trigger: SceneTrigger): void;
  /** 因判定失败次数过多而暂停评估 */
  judgeSuspended(convKey: string): void;
  /** 被否决（否决层原因） */
  vetoed(reason: string, scene?: string): void;
  /** 真的发出去了 / dryRun 本应发送 */
  spoke(scene: SceneId, dryRun: boolean): void;
  /** 投递层降级（平台不支持、限流、错误） */
  deliveryDegraded(reason: string, scene: SceneId): void;
}

export const NULL_WATCHER_METRICS: WatcherMetrics = {
  evaluated: () => {},
  judgeFailed: () => {},
  judgeSuspended: () => {},
  vetoed: () => {},
  spoke: () => {},
  deliveryDegraded: () => {},
};

/** 一次投放的记录（`/metrics` 与 RUNBOOK 排障用）。 */
export interface ProposedRecord {
  readonly ts: number;
  readonly scene: SceneId;
  readonly trigger: SceneTrigger;
  readonly delivered: boolean;
}

export interface ProactiveWatcherDeps {
  config: ProactiveWatcherConfig;
  speaker: ProactiveSpeaker;
  /** 判定能力；未注入 = 只收集不判定（"只听不说"的部署形态） */
  judge?: ProactiveJudge;
  interests?: InterestPool;
  metrics?: WatcherMetrics;
  logger: Logger;
  /** 注入时钟（测试用）；缺省 Date.now */
  now?: () => number;
  /** 注入调度器（测试用手动时钟）；返回取消函数 */
  schedule?: (fn: () => void, delayMs: number) => () => void;
}

/** health / 排障用的快照。 */
export interface WatcherSnapshot {
  enabled: boolean;
  dryRun: boolean;
  conversations: number;
  /** 当前缓冲的旁听消息总数 */
  buffered: number;
  /** 台账里仍挂起的问题数 */
  pendingQuestions: number;
  /** 正在评估的会话数 */
  evaluating: number;
  /** 因判定连续失败被暂停的会话数 */
  suspended: number;
  /** 评估计数（按触发面：message / question-probe / topic-roll） */
  evaluatedByTrigger: Record<string, number>;
  /** 每个场景被判定"成立"的次数 */
  satisfiedByScene: Record<string, number>;
  /** 按否决原因的计数 */
  vetoed: Record<string, number>;
  /** 真的发出 / dryRun 本应发送 */
  spoke: number;
  wouldSend: number;
  /** 投递层降级计数（按原因） */
  deliveryDegraded: Record<string, number>;
  /** 本地有候选但没有判定能力（只收集不判定）的次数 */
  collectedOnly: number;
  judgeFailures: number;
}

/** 触发来源（watcher 自己的调度面 + 场景声明用的三个）。 */
export type WatcherTrigger = Extract<SceneTrigger, 'message' | 'question-probe' | 'topic-roll'>;

export class ProactiveWatcher {
  private readonly deps: ProactiveWatcherDeps;
  private readonly states: ConversationStateStore;
  private readonly config: ProactiveWatcherConfig;
  private readonly policy: VetoPolicy;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, delayMs: number) => () => void;
  private readonly metrics: WatcherMetrics;

  /** 每会话一个 in-flight 标记（同会话不并发评估） */
  private readonly evaluating = new Set<string>();
  /** 每会话一个待触发的滚动定时器 */
  private readonly rollTimers = new Map<string, () => void>();
  /** 每会话一个待触发的问题探针定时器 */
  private readonly probeTimers = new Map<string, () => void>();
  /** 每会话距上次滚动的消息数 */
  private readonly sinceRoll = new Map<string, number>();
  /** 每会话的投放时间戳（限流窗口） */
  private readonly proposals = new Map<string, number[]>();
  /** 每会话连续判定失败次数（成功即归零） */
  private readonly judgeFailures = new Map<string, number>();
  /** 因失败过多而暂停评估的会话 */
  private readonly suspended = new Set<string>();

  private readonly counters = {
    evaluatedByTrigger: new Map<string, number>(),
    satisfiedByScene: new Map<string, number>(),
    vetoed: new Map<string, number>(),
    deliveryDegraded: new Map<string, number>(),
    collectedOnly: 0,
    spoke: 0,
    wouldSend: 0,
    judgeFailures: 0,
  };

  constructor(deps: ProactiveWatcherDeps) {
    this.deps = deps;
    this.config = deps.config;
    this.policy = {
      ...DEFAULT_VETO_POLICY,
      // 限流上限以 watcher 配置为准（它同时决定 veto 的判定与 watcher 的记账口径）
      maxPer10Min: deps.config.rateLimit10Min,
      maxPerHour: deps.config.rateLimit1Hour,
      ...(deps.config.vetoPolicy ?? {}),
    };
    this.now = deps.now ?? (() => Date.now());
    this.schedule =
      deps.schedule ??
      ((fn, delayMs) => {
        const timer = setTimeout(fn, delayMs);
        // unref：定时器不该阻止进程退出
        if (typeof timer === 'object' && 'unref' in timer) timer.unref();
        return () => clearTimeout(timer);
      });
    this.metrics = deps.metrics ?? NULL_WATCHER_METRICS;
    this.states = new ConversationStateStore(deps.config.stateOptions ?? {});
  }

  // -------------------------------------------------------------------------
  // 入口
  // -------------------------------------------------------------------------

  /**
   * 旁听消息入口（**同步、永不抛错**）。
   *
   * 顺序即成本纪律：白名单 + 总开关 → 入状态 → 立即评估（场景 1/4）
   * → 问题探针（场景 3）→ 滚动收敛（场景 2/5）。
   */
  observe(message: NormalizedMessage): void {
    if (!this.config.enabled || !this.isAllowed(message.target.key)) return;

    const ts = Number.isFinite(message.ts) ? message.ts : this.now();
    const state = this.states.for(message.target.key);

    // ⚠️ 顺序要紧：**先**做本地预筛（读的是这条消息之前的状态），**再**入状态。
    // 反过来会让"没人理我就停"这一步永远失效——`state.observe` 会把
    // 无人回应计数清零，于是后面再读就永远是 0（实测踩过：连说两次没人接，
    // 第三条消息照样会触发判定）。
    const evidence = buildSceneEvidence({
      state,
      trigger: 'message',
      now: ts,
      message: { text: message.content },
      ...(this.deps.interests === undefined ? {} : { interests: this.deps.interests }),
      botAliases: this.config.botAliases,
    });
    const candidates = collectCandidates(evidence, {
      maxUnansweredStreak: this.policy.maxUnansweredStreak,
    });

    state.observe(message);

    // 场景 1/4：每条消息都可能命中，且本地预筛很廉价 → 立即评估
    this.kickWith(message.target.key, message.target, 'message', evidence, candidates);
    // 场景 3：刚登记的问题排一个探针
    this.armQuestionProbe(message.target.key, message.target);
    // 场景 2/5：滚动收敛（条数或时间先到者）
    this.armTopicRoll(message.target.key, message.target);
  }

  /**
   * 一条**已被 @** 的消息（走 Ingress 的那条）也记进旁听缓冲。
   *
   * 理由：场景 1 的判据是"接续 bot 上一条"，而 bot 的回复与用户的 @ 消息
   * 都不在旁听流里。不记的话，判定看到的转录会缺掉对话的另一半。
   */
  observeAddressed(message: NormalizedMessage): void {
    if (!this.config.enabled || !this.isAllowed(message.target.key)) return;
    this.states.for(message.target.key).observeEntry({
      msgId: message.msgId,
      eventId: message.eventId,
      senderId: message.senderId,
      ...(message.username !== undefined ? { senderName: message.username } : {}),
      text: message.content,
      ts: Number.isFinite(message.ts) ? message.ts : this.now(),
      addressed: true,
    });
  }

  /** bot 在本群发了一条**主动**发言（组装层在投递成功后调用，用于记账）。 */
  notifyBotSpoke(convKey: string, ts: number = this.now()): void {
    if (!this.config.enabled || !this.isAllowed(convKey)) return;
    this.states.for(convKey).recordBotSpoke(ts);
    const list = this.proposals.get(convKey) ?? [];
    list.push(ts);
    // 只保留 1 小时窗口内的（限流窗口最长就是 1 小时）
    const cutoff = ts - 3_600_000;
    this.proposals.set(
      convKey,
      list.filter((item) => item >= cutoff),
    );
  }

  /** 该会话是否在介入范围内（白名单 + 总开关）。 */
  isAllowed(convKey: string): boolean {
    if (this.config.whitelistGroups.length === 0) return false;
    const groupId = convKey.includes(':g') ? convKey.slice(convKey.indexOf(':g') + 2) : undefined;
    return this.config.whitelistGroups.some((item) => {
      const trimmed = item.trim();
      if (trimmed === '' ) return false;
      if (trimmed === convKey) return true;
      const [, itemGroup] = trimmed.split(':');
      return groupId !== undefined && (itemGroup === groupId || trimmed.endsWith(`g${groupId}`));
    });
  }

  /** 取某会话的旁听状态（排障与测试；只读语义由调用方自觉）。 */
  stateFor(convKey: string): ConversationState {
    return this.states.for(convKey);
  }

  snapshot(): WatcherSnapshot {
    let buffered = 0;
    let pending = 0;
    const now = this.now();
    for (const state of this.states.all()) {
      buffered += state.entries.length;
      pending += state.pendingQuestions(now).length;
    }
    return {
      enabled: this.config.enabled,
      dryRun: this.config.dryRun,
      conversations: this.states.size,
      buffered,
      pendingQuestions: pending,
      evaluating: this.evaluating.size,
      suspended: this.suspended.size,
      evaluatedByTrigger: Object.fromEntries(this.counters.evaluatedByTrigger),
      satisfiedByScene: Object.fromEntries(this.counters.satisfiedByScene),
      vetoed: Object.fromEntries(this.counters.vetoed),
      spoke: this.counters.spoke,
      wouldSend: this.counters.wouldSend,
      deliveryDegraded: Object.fromEntries(this.counters.deliveryDegraded),
      collectedOnly: this.counters.collectedOnly,
      judgeFailures: this.counters.judgeFailures,
    };
  }

  // -------------------------------------------------------------------------
  // 内部：调度
  // -------------------------------------------------------------------------

  /**
   * 立即评估。
   *
   * 关键结构：**本地预筛在占用 in-flight 标记之前跑**。异步评估会短暂占用
   * 标记，而"每条消息都触发一次"的触发面很密——如果把廉价的无候选路径也算作
   * "正在评估"，紧跟着到来的滚动收敛就会被静默丢掉（实测踩过：
   * 第一条消息触发一次无候选评估，第三条消息的滚动收敛因此永远不生效）。
   * 所以：**没候选 = 同步返回，不占标记**；占用标记的只有真的要调 LLM 的那段。
   */
  private kick(
    convKey: string,
    target: ConversationTarget,
    trigger: WatcherTrigger,
    extra: { text?: string } = {},
  ): void {
    if (this.suspended.has(convKey)) return;

    const evidence = this.buildEvidence(convKey, trigger, extra);
    const candidates = collectCandidates(evidence, {
      maxUnansweredStreak: this.policy.maxUnansweredStreak,
    });
    this.kickWith(convKey, target, trigger, evidence, candidates);
  }

  /** 用**已算好的**证据与候选继续评估（`observe` 走这条，避免重复算一遍）。 */
  private kickWith(
    convKey: string,
    target: ConversationTarget,
    trigger: WatcherTrigger,
    evidence: SceneEvidence,
    candidates: readonly SceneCandidate[],
  ): void {
    if (candidates.length === 0) {
      // 成本闸：连标记都不占（这是最高频的路径）
      this.bump(this.counters.vetoed, 'no-candidate');
      return;
    }
    if (this.suspended.has(convKey) || this.evaluating.has(convKey)) return;

    this.evaluating.add(convKey);
    void this.evaluate(convKey, target, trigger, evidence, candidates)
      .catch((error: unknown) => {
        this.deps.logger.warn('主动介入评估异常（已忽略）', {
          conversation: convKey,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.evaluating.delete(convKey);
      });
  }

  /** 组装证据（本地、同步、零成本）。 */
  private buildEvidence(
    convKey: string,
    trigger: WatcherTrigger,
    extra: { text?: string } = {},
  ) {
    return buildSceneEvidence({
      state: this.states.for(convKey),
      trigger,
      now: this.now(),
      ...(extra.text === undefined ? {} : { message: { text: extra.text } }),
      ...(this.deps.interests === undefined ? {} : { interests: this.deps.interests }),
      botAliases: this.config.botAliases,
    });
  }

  /**
   * 滚动收敛（场景 2/5 的入口）。
   *
   * 两个条件谁先到都算：消息数攒够 `topicRollMessages`，或静默
   * `topicRollMs`。**用户消息一到就重新武装**——所以只有"真的没人说话了"
   * 才会走时间那条路，不会在热聊中途插话。
   */
  private armTopicRoll(convKey: string, target: ConversationTarget): void {
    const count = (this.sinceRoll.get(convKey) ?? 0) + 1;
    this.sinceRoll.set(convKey, count);

    if (count >= Math.max(1, this.config.topicRollMessages)) {
      this.rollTimers.get(convKey)?.();
      this.rollTimers.delete(convKey);
      // 计数在此清零（而不是等评估成功）：否则正在评估时被丢弃的那次收敛
      // 会让计数继续累积，下一个窗口要等更久才再来一次。
      this.sinceRoll.set(convKey, 0);
      this.kick(convKey, target, 'topic-roll');
      return;
    }
    // 已经有定时器在跑：**不重排**。它在到点时自己会检查"是否真的静默了"，
    // 所以热聊中的消息只会让它多查几次，而不会把收敛无限推迟，
    // 也不会让它在有人说话的中途插话。
    if (this.rollTimers.has(convKey)) return;
    this.scheduleTopicRoll(convKey, target);
  }

  /** 到点先看静默：没静够就按剩余时间重排；静够了才收敛。 */
  private scheduleTopicRoll(convKey: string, target: ConversationTarget): void {
    this.rollTimers.set(
      convKey,
      this.schedule(() => {
        this.rollTimers.delete(convKey);
        const state = this.states.for(convKey);
        const now = this.now();
        const lastHuman = state.lastHumanSpoke;
        const silentFor = lastHuman === undefined ? Number.POSITIVE_INFINITY : now - lastHuman;
        if (silentFor < this.config.topicRollMs) {
          // 还在热聊：等剩余的静默时间再看一次（不做任何评估）
          this.scheduleTopicRoll(convKey, target);
          return;
        }
        this.sinceRoll.set(convKey, 0);
        this.kick(convKey, target, 'topic-roll');
      }, this.config.topicRollMs),
    );
  }

  /**
   * 问题探针（场景 3 的入口）。
   *
   * 每会话最多一个待触发探针；到点后**重新查一次台账**（问题可能已被答、
   * 已过 TTL、或话题翻篇清空了），再记一次探针并评估。
   */
  private armQuestionProbe(convKey: string, target: ConversationTarget): void {
    if (this.probeTimers.has(convKey)) return;
    const state = this.states.for(convKey);
    const pending = state.pendingQuestions(this.now());
    if (pending.length === 0) return;
    this.probeTimers.set(
      convKey,
      this.schedule(() => {
        this.probeTimers.delete(convKey);
        const now = this.now();
        const current = this.states.for(convKey);
        const stillPending = current
          .pendingQuestions(now)
          .filter((question) => question.probes < this.config.maxQuestionProbes);
        if (stillPending.length === 0) return;
        for (const question of stillPending) current.recordProbe(question.id);
        this.kick(convKey, target, 'question-probe');
      }, this.config.questionProbeMs),
    );
  }

  // -------------------------------------------------------------------------
  // 内部：一次完整评估（collect → judge → veto → deliver）
  // -------------------------------------------------------------------------

  private async evaluate(
    convKey: string,
    target: ConversationTarget,
    trigger: WatcherTrigger,
    evidence: SceneEvidence,
    candidates: readonly SceneCandidate[],
  ): Promise<void> {
    const state = this.states.for(convKey);
    const now = evidence.now;

    // ② LLM 层。未注入判定能力 = 只收集不判定（"只听不说"的部署形态）。
    const judge = this.deps.judge;
    if (judge === undefined) {
      this.counters.collectedOnly += 1;
      this.deps.logger.debug('主动介入：未配置判定能力，本次只收集', {
        conversation: convKey,
        candidates: candidates.map((item) => item.scene),
      });
      return;
    }

    const pendingTexts = state.pendingQuestions(now).map((question) => {
      const seconds = Math.round((now - question.askedAt) / 1000);
      const who = question.askerName ?? question.askerId;
      return `${who}：${question.text}（已静默 ${seconds} 秒，探针 ${question.probes} 次）`;
    });

    this.bump(this.counters.evaluatedByTrigger, trigger);
    this.metrics.evaluated(trigger);

    const verdicts = await judge.judge({
      candidates,
      evidence,
      transcript: `${renderFacts(evidence, pendingTexts)}\n\n${renderTranscript(state.entries)}`,
    });
    if (verdicts === undefined) {
      this.counters.judgeFailures += 1;
      this.metrics.judgeFailed(trigger);
      const failures = (this.judgeFailures.get(convKey) ?? 0) + 1;
      this.judgeFailures.set(convKey, failures);
      if (failures >= this.config.maxJudgeFailures) {
        this.suspended.add(convKey);
        this.metrics.judgeSuspended(convKey);
        this.deps.logger.warn('主动介入：判定连续失败，暂停该会话的评估', {
          conversation: convKey,
          failures,
        });
      }
      return;
    }
    this.judgeFailures.set(convKey, 0);

    for (const verdict of verdicts) {
      if (verdict.satisfied) this.bump(this.counters.satisfiedByScene, verdict.scene);
    }

    // ③ 否决层（纯函数）：顺序、额度、wait 采纳都在这里。
    const decision = evaluateVeto(
      { candidates, verdicts, context: this.vetoContext(convKey, state, now) },
      this.policy,
    );

    if (decision.action === 'silent') {
      this.bump(this.counters.vetoed, decision.reason);
      this.metrics.vetoed(decision.reason, decision.detail);
      // 拒绝也落标记：避免同一个问题被反复重探（撞同一堵墙）
      if (trigger === 'question-probe') {
        for (const question of state.pendingQuestions(now)) state.markSilenced(question.id);
      }
      return;
    }
    if (decision.action === 'wait') {
      this.bump(this.counters.vetoed, 'wait');
      this.schedule(
        () => this.kick(convKey, target, 'question-probe'),
        Math.max(1000, decision.delayMs),
      );
      return;
    }

    // ④ 投递：唯一出口（dryRun / 平台能力差异都在它内部处理）。
    await this.deliver(convKey, target, decision, now);
  }

  private vetoContext(convKey: string, state: ConversationState, now: number): VetoContext {
    const list = this.proposals.get(convKey) ?? [];
    return {
      now,
      spokeCount10Min: list.filter((ts) => now - ts <= 600_000).length,
      spokeCount1Hour: list.filter((ts) => now - ts <= 3_600_000).length,
      // 「每话题一次」的话题口径 = state 的活动窗口（静默超过窗口即翻篇，
      // 由 state.botSpeaks 内部判定并归零），watcher 不再自己算一遍。
      topicBotSpeaks: state.botSpeaks(now),
      waitRetries: 0,
    };
  }

  private async deliver(
    convKey: string,
    target: ConversationTarget,
    decision: Extract<ProactiveDecision, { action: 'speak' }>,
    now: number,
  ): Promise<void> {
    // 内容：本模块**不写文案**，只把"该说什么"的要点交给投递层；
    // 真实措辞由 agent turn 生成（S1 之后接 TurnRunner 时替换这里）。
    const parts = [decision.directive ?? decision.reason];
    if (decision.evidence !== undefined) parts.push(`（依据：${decision.evidence}）`);
    const outcome = await this.deps.speaker.deliver({
      target,
      content: { text: parts.join('\n') },
      trigger: sceneTriggerName(decision.scene),
      reason: decision.reason,
    });

    if (isSent(outcome) || isWouldSend(outcome)) {
      const dryRun = isWouldSend(outcome);
      if (dryRun) this.counters.wouldSend += 1;
      else this.counters.spoke += 1;
      this.metrics.spoke(decision.scene, dryRun);
      // dryRun 也记账：否则"每话题一次"的观察结果会失真
      this.notifyBotSpoke(convKey, now);
      return;
    }
    // 走到这里只可能是 degraded（sent / would-send 已在上面 return）
    if (outcome.status !== 'degraded') return;
    this.bump(this.counters.deliveryDegraded, outcome.reason);
    this.metrics.deliveryDegraded(outcome.reason, decision.scene);
    if (outcome.reason === 'unsupported') {
      this.deps.logger.debug('主动介入：本平台不支持主动发言，判定结果不投递', {
        conversation: convKey,
        scene: decision.scene,
      });
    }
  }

  private bump<T>(map: Map<T, number>, key: T): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
}

/** 场景 id → 投递层的 trigger 标签（进指标与日志）。 */
export function sceneTriggerName(scene: SceneId): ProactiveTrigger {
  return `intervention:${scene}` as ProactiveTrigger;
}
