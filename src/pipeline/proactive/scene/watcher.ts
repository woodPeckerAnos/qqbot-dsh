/**
 * 主动介入的**唯一 runner**：把「旁听消息 → 状态 → 搜集 → 判定 → 否决 → 投递」
 * 串起来，并持有全部定时器。这是本模块唯一有副作用的组件。
 *
 * ## 触发面（四种，与场景声明一一对应）
 *
 * | 触发 | 什么时候 | 参与的场景 |
 * |---|---|---|
 * | `message` | 每条旁听消息 | 场景 1（续聊追问）、场景 4（指代） |
 * | `question-probe` | 问题挂起 `questionProbeMs`（默认 90s）后 | 场景 3（无人应答） |
 * | `topic-roll` | 每 N 条消息**或** M 分钟无评估 | 场景 2（持续讨论）、场景 5（兴趣） |
 * | `wait-wakeup` | wait 票据到期（`waitYieldMs`，默认 45s） | 场景 3（重查） |
 *
 * `wait-wakeup` 与 `question-probe` **刻意分开**：上一轮重查复用了
 * `question-probe` 标签，于是"探针"与"重查"在指标里再也分不开，
 * 而"wait 到底有没有价值"正是靠这份数据回答的。
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
 *
 * ## wait 的收敛（见 docs/WAIT-CONVERGENCE-REQUIREMENT.md）
 *
 * 「让路」不再是一台独立于任何对象的调度机制，而是**把下一次唤醒提前一点**：
 * 票据挂在**挂起问题**上、每张只有一次唤醒机会、每会话只有一个唤醒点，
 * 且唤醒前的两道本地检查（对象还在吗 / 转录有新增吗）只要有一道不过
 * 就**不调 LLM**。
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
import { extractWaitTargetId } from '../judge/judge.js';
import type { ProactiveJudge } from '../judge/client.js';
import {
  isSent,
  isWouldSend,
  type ProactiveSpeaker,
  type ProactiveTrigger,
} from '../deliver/speaker.js';
import {
  DEFAULT_MAX_WAIT_PER_ITEM,
  DEFAULT_WAIT_YIELD_MS,
  effectiveMaxWaitPerItem,
  effectiveWaitYieldMs,
  MAX_WAIT_PER_ITEM_CAP,
  type ProactiveDecision,
  type SceneCandidate,
  type SceneEvidence,
  type SceneId,
  type SceneTrigger,
  type SceneVerdict,
  type VetoContext,
  type VetoPolicy,
  type WaitReason,
  type WaitTarget,
  type WaitTicketTerminal,
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
  /**
   * 每个挂起问题最多"让路"几次（默认 1；硬上限 `MAX_WAIT_PER_ITEM_CAP`）。
   *
   * 默认值刻意保守：**让路只能让一次**。配得比硬上限大时按硬上限处理并 warn
   * ——否则"把收敛改回不收敛"只需改一行配置。
   */
  maxWaitPerItem: number;
  /** "让路"理由的等待时长（毫秒；默认 45000，范围 15000–120000） */
  waitYieldMs: number;
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
  maxWaitPerItem: DEFAULT_MAX_WAIT_PER_ITEM,
  waitYieldMs: DEFAULT_WAIT_YIELD_MS,
  maxJudgeFailures: 3,
  rateLimit10Min: 3,
  rateLimit1Hour: 8,
} as const;

/**
 * 触发来源（watcher 自己的调度面）。
 *
 * `wait-wakeup` 是**独立标签**：wait 票据到期重查**不再复用** `question-probe`
 * ——否则 `evaluatedByTrigger` 分不清"探针"与"重查"，而"wait 到底有没有价值"
 * 正是上一轮灰度里完全缺失的那份数据。
 */
export type WatcherTrigger = Extract<
  SceneTrigger,
  'message' | 'question-probe' | 'topic-roll' | 'wait-wakeup'
>;

export interface WatcherMetrics {
  /** 进入判定的评估次数（按触发面，含 `wait-wakeup`） */
  evaluated(trigger: WatcherTrigger): void;
  /** 判定失败（timeout / http / 解析） */
  judgeFailed(trigger: WatcherTrigger): void;
  /** 因判定失败次数过多而暂停评估 */
  judgeSuspended(convKey: string): void;
  /** 被否决（否决层原因） */
  vetoed(reason: string, scene?: string): void;
  /** 真的发出去了 / dryRun 本应发送 */
  spoke(scene: SceneId, dryRun: boolean): void;
  /** 投递层降级（平台不支持、限流、错误） */
  deliveryDegraded(reason: string, scene: SceneId): void;
  /**
   * wait 票据的记账（每张票据**只有一个终局**，因此这四个之和 == created）。
   * 与 `waitDeclined` / `waitInvalidTarget` 分开：那两者**不产生票据**。
   */
  waitTicket(terminal: WaitTicketTerminal, scene: SceneId): void;
  /** 建票据（模型想等，且对象仍挂起） */
  waitTicketCreated(reason: WaitReason, scene: SceneId): void;
  /** 模型想等但被否决层按下（`not-yet` / `watching` / 理由无效 / 对象已关闭） */
  waitDeclined(reason: string, scene: SceneId): void;
  /** 模型引用的挂起问题不存在（或它压根没给引用） */
  waitInvalidTarget(scene: SceneId): void;
}

export const NULL_WATCHER_METRICS: WatcherMetrics = {
  evaluated: () => {},
  judgeFailed: () => {},
  judgeSuspended: () => {},
  vetoed: () => {},
  spoke: () => {},
  deliveryDegraded: () => {},
  waitTicket: () => {},
  waitTicketCreated: () => {},
  waitDeclined: () => {},
  waitInvalidTarget: () => {},
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
  /**
   * 真的发起过判定调用的次数。
   * 与 `judgeFailures` 一起读才能分清三种「没说话」：
   *   有候选但 judgeCalls=0 → 没有判定能力（缺密钥 / 只收集）；
   *   judgeCalls > judgeFailures → LLM 答了但判不成立（判据问题）；
   *   judgeCalls == judgeFailures → 每次调用都失败（超时 / 密钥 / 解析）。
   */
  judgeCalls: number;
  judgeFailures: number;
  /**
   * wait 票据账目。**每张票据只有一个终局**，因此稳态下
   * `created === resolved + spent + stale + unchanged`（灰度一周后据此判断
   * 这个机制该保留还是删掉：`resolved` 长期为 0 = 答案可能是"直接删"）。
   *
   * `invalidTarget` 与 `waitDeclined` **不产生票据**，所以不参与上面的等式。
   */
  waitTickets: {
    /** 当前待唤醒的票据数 */
    pending: number;
    created: number;
    resolved: number;
    spent: number;
    stale: number;
    unchanged: number;
    invalidTarget: number;
  };
  /**
   * 建票据的**理由分布**（`wait_ticket_created{reason}`）。
   * 按理由拆开才能回答"模型为什么想等"——那是判据要不要调的唯一直读数据。
   */
  waitTicketsCreatedByReason: Record<string, number>;
  /** 模型想等、但被否决层按下的次数（按理由：not-yet / watching / 理由无效 / …） */
  waitDeclined: Record<string, number>;
}

/** 兴趣匹配看最近多少条消息（话题是"这几句话在聊什么"，不是单条）。 */
const RECENT_MATCH_MESSAGES = 5;

/**
 * wait 票据（挂在**对象**上，不是挂在会话上）。
 *
 * 纪律（见 docs/WAIT-CONVERGENCE-REQUIREMENT.md 判定三）：
 *   - 票据只挂在"一个挂起问题"上（话题类暂不建票据）；
 *   - 每张票据**只有一次唤醒机会**；
 *   - 每次唤醒都只有一个终局（`resolved` / `spent` / `stale` / `unchanged`），
 *     于是灰度一周后账目必须闭合：`resolved+spent+stale+unchanged == created`。
 */
interface WaitTicket {
  readonly convKey: string;
  /** 对象 id = 挂起问题 id */
  readonly targetId: string;
  readonly scene: SceneId;
  /** 让路的理由（目前只可能是 `yielding`） */
  readonly reason: WaitReason;
  /** 建票据的时刻 */
  readonly createdAt: number;
  /** 本次唤醒的到期时刻 */
  readonly dueAt: number;
  /** 该对象在**建票据那一刻**的判定时刻（"无新增"检查的基准，此后不再变） */
  readonly evaluatedAt: number;
  readonly target: ConversationTarget;
}

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

  /**
   * 每会话**只有一个唤醒点**（第四节的硬要求）。
   *
   * 同一会话内多张票据合并成一个定时器（取最近的到期时间），唤醒时逐张按表
   * 判断、互不影响。**不允许**每张票据各排一个定时器——三个挂起问题一起等
   * 就是三个定时器，唤醒时各调一次 LLM。
   */
  private readonly yieldTimers = new Map<string, () => void>();
  /** 待唤醒的票据（会话键 → 对象 id → 票据） */
  private readonly waitTickets = new Map<string, Map<string, WaitTicket>>();

  private readonly counters = {
    evaluatedByTrigger: new Map<string, number>(),
    satisfiedByScene: new Map<string, number>(),
    vetoed: new Map<string, number>(),
    deliveryDegraded: new Map<string, number>(),
    waitDeclined: new Map<string, number>(),
    waitTicketsCreatedByReason: new Map<string, number>(),
    collectedOnly: 0,
    judgeCalls: 0,
    spoke: 0,
    wouldSend: 0,
    judgeFailures: 0,
    waitTickets: {
      created: 0,
      resolved: 0,
      spent: 0,
      stale: 0,
      unchanged: 0,
      invalidTarget: 0,
    },
  };

  constructor(deps: ProactiveWatcherDeps) {
    this.deps = deps;
    this.config = deps.config;
    // 硬上限在**装配时**就生效（否决层里还有一道，双保险）：配成 5 时按 3 处理并 warn，
    // 而不是让一行配置把"让路只能让一次"的收敛改回不收敛。
    const configured = deps.config.maxWaitPerItem;
    const maxWaitPerItem = effectiveMaxWaitPerItem(configured);
    if (Number.isFinite(configured) && configured > MAX_WAIT_PER_ITEM_CAP) {
      deps.logger.warn('proactive:maxWaitPerItem 超过硬上限，按硬上限处理', {
        configured,
        effective: maxWaitPerItem,
        cap: MAX_WAIT_PER_ITEM_CAP,
      });
    }
    this.policy = {
      ...DEFAULT_VETO_POLICY,
      // 限流上限以 watcher 配置为准（它同时决定 veto 的判定与 watcher 的记账口径）
      maxPer10Min: deps.config.rateLimit10Min,
      maxPerHour: deps.config.rateLimit1Hour,
      maxWaitPerItem,
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
    // 问题关闭 → 立即作废其票据并取消唤醒（第五节：本地可判的事不要等定时器到点）。
    // 订阅必须在这里完成：watcher 之后才创建各个会话的状态。
    this.states.onQuestionClosed((convKey, event) => {
      this.closeTicket(convKey, event.id);
      this.deps.logger.debug('主动介入：挂起问题已关闭，其 wait 票据立即作废', {
        conversation: convKey,
        question: event.id,
        cause: event.cause,
      });
    });
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
      text: this.matchText(state, message.content),
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
    let tickets = 0;
    const now = this.now();
    for (const state of this.states.all()) {
      buffered += state.entries.length;
      pending += state.pendingQuestions(now).length;
    }
    for (const byTarget of this.waitTickets.values()) tickets += byTarget.size;
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
      judgeCalls: this.counters.judgeCalls,
      judgeFailures: this.counters.judgeFailures,
      waitTickets: {
        pending: tickets,
        ...this.counters.waitTickets,
      },
      waitTicketsCreatedByReason: Object.fromEntries(this.counters.waitTicketsCreatedByReason),
      waitDeclined: Object.fromEntries(this.counters.waitDeclined),
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
    extra: { text?: string; waitWakeup?: SceneEvidence['waitWakeup'] } = {},
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
    extra: { text?: string; waitWakeup?: SceneEvidence['waitWakeup'] } = {},
  ) {
    const state = this.states.for(convKey);
    const now = this.now();
    return buildSceneEvidence({
      state,
      trigger,
      now,
      ...(extra.text === undefined ? {} : { message: { text: extra.text } }),
      ...(extra.waitWakeup === undefined ? {} : { waitWakeup: extra.waitWakeup }),
      ...(this.deps.interests === undefined ? {} : { interests: this.deps.interests }),
      botAliases: this.config.botAliases,
      // 兴趣匹配用**整段近期对话**而不是单条消息：话题是"这几句话在聊什么"，
      // 只看触发那一条会漏掉（实测："这个折线图怎么画" + "要不换个图？"，
      // 只看后一条命中不了任何兴趣条目）。
      text: this.matchText(state, extra.text),
    });
  }

  /** 兴趣匹配的输入文本：最近若干条（含本轮）拼起来。 */
  private matchText(state: ConversationState, extraText?: string): string {
    const recent = state.entries
      .slice(-RECENT_MATCH_MESSAGES)
      .map((entry) => entry.text)
      .join('\n');
    return extraText === undefined ? recent : `${recent}\n${extraText}`;
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
  // 内部：wait 票据（每会话一个唤醒点 + 唤醒前两道本地检查）
  // -------------------------------------------------------------------------

  /**
   * 排（或重排）本会话的**唯一**唤醒点。
   *
   * 同一会话内多张票据取**最近的到期时间**合并成一个定时器：三个挂起问题
   * 一起等不该是三个定时器、三次 LLM 调用（第四节）。
   */
  private armWaitYield(convKey: string, target: ConversationTarget): void {
    const byTarget = this.waitTickets.get(convKey);
    if (byTarget === undefined || byTarget.size === 0) return;
    const dueAt = Math.min(...[...byTarget.values()].map((ticket) => ticket.dueAt));

    this.yieldTimers.get(convKey)?.();
    this.yieldTimers.delete(convKey);

    const delay = Math.max(0, dueAt - this.now());
    this.yieldTimers.set(
      convKey,
      this.schedule(() => {
        this.yieldTimers.delete(convKey);
        // 到点后**先跑本地检查**，过了才调 LLM；没过的票据就地作废。
        this.wakeWaitTickets(convKey, target);
      }, delay),
    );
  }

  /**
   * 唤醒点：逐张票据先跑两道**本地**检查，再决定是否重新判定。
   *
   * 「关键纪律」：唤醒前的两道本地检查必须先跑，任何一道不过都不调 LLM
   * （否则又是"群里完全安静也每 30 秒问一次"的老毛病）。
   *
   * 三道闸（对应需求判定三的表格 + 验收 3/4）：
   *   1. 到点了吗（同一会话合并定时器，到点时可能只有一部分到期）；
   *   2. 对象还在吗（已答 / 过期 / 话题翻篇 → `stale`，不调 LLM）；
   *   3. 转录自上次判定以来有新增吗（没有 → `unchanged`，不调 LLM）。
   *
   * `stale` 与 `unchanged` 的票据在这里**就地作废**；过了两道闸的票据进入
   * "重新判定一次"的阶段，其终局由 `finishWaitWakeup` 在判定后收口。
   */
  private wakeWaitTickets(convKey: string, target: ConversationTarget): void {
    const byTarget = this.waitTickets.get(convKey);
    if (byTarget === undefined || byTarget.size === 0) return;

    const state = this.states.for(convKey);
    const now = this.now();
    // 台账查一次：既判"对象是否仍挂起"，也判"转录有没有新增"。
    const openIds = new Set(state.pendingQuestions(now).map((question) => question.id));
    const woken: WaitTicket[] = [];

    for (const [targetId, ticket] of [...byTarget.entries()]) {
      // 同一会话合并成一个定时器，到点时可能只有一部分票据到期
      if (ticket.dueAt > now) continue;
      byTarget.delete(targetId);
      if (!openIds.has(targetId)) {
        // 对象已关闭（问题被答 / 过期 / 话题翻篇）→ 这是一次"省下来的调用"
        this.metrics.waitTicket('stale', ticket.scene);
        this.bumpWaitTicket('stale');
        continue;
      }
      if (!state.hasNewContentSince(ticket.evaluatedAt)) {
        // 转录无新增：群里完全安静，不花 LLM（杜绝"纯靠沉默累积反复唤醒"）
        this.metrics.waitTicket('unchanged', ticket.scene);
        this.bumpWaitTicket('unchanged');
        continue;
      }
      woken.push(ticket);
    }

    // 过闸的票据交给重新判定（它们的终局在 evaluate / finishWaitWakeup 里收口）
    if (woken.length > 0) {
      void this.rejudgeWaitTickets(convKey, target, woken).catch((error: unknown) => {
        // 唤醒路径的兜底：票据终局**无论如何都要收口**，否则账目不闭合
        for (const ticket of woken) {
          this.bumpWaitTicket('spent');
          this.metrics.waitTicket('spent', ticket.scene);
          this.finishWaitWakeup(convKey, ticket);
        }
        this.deps.logger.warn('主动介入：wait 唤醒重判异常（票据按 spent 收口）', {
          conversation: convKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // 还有没到点的票据 → 唤醒点重排到**剩余票据里最近的那个**到期时间
    const upcoming = [...(this.waitTickets.get(convKey)?.values() ?? [])];
    if (upcoming.length === 0) {
      this.waitTickets.delete(convKey);
      return;
    }
    this.rearmWaitYield(
      convKey,
      target,
      Math.min(...upcoming.map((ticket) => ticket.dueAt)),
    );
  }

  /** 按明确的到期时间重排唤醒点（不重新计算 min，避免被浮点/边界绕进去）。 */
  private rearmWaitYield(
    convKey: string,
    target: ConversationTarget,
    dueAt: number,
  ): void {
    this.yieldTimers.get(convKey)?.();
    this.yieldTimers.delete(convKey);
    this.yieldTimers.set(
      convKey,
      this.schedule(() => {
        this.yieldTimers.delete(convKey);
        this.wakeWaitTickets(convKey, target);
      }, Math.max(0, dueAt - this.now())),
    );
  }

  /**
   * 唤醒后的**重新判定**（每张票据只剩这一次机会）。
   *
   * 逐个对象跑，但触发标签固定为独立的 `wait-wakeup`，因此
   * `evaluatedByTrigger` 终于能把"探针"与"重查"分开。
   */
  private async rejudgeWaitTickets(
    convKey: string,
    target: ConversationTarget,
    woken: readonly WaitTicket[],
  ): Promise<void> {
    for (const ticket of woken) {
      const state = this.states.for(convKey);
      const pending = state.pendingQuestions(this.now());
      // 让判定知道"你上轮说有人在答，现在过了 N 秒，对象是 q:<id>"
      const evidence = this.buildEvidence(convKey, 'wait-wakeup', {
        waitWakeup: { targetId: ticket.targetId, yieldedForMs: this.now() - ticket.createdAt },
      });
      const candidates = collectCandidates(evidence, {
        maxUnansweredStreak: this.policy.maxUnansweredStreak,
      });
      await this.evaluate(convKey, target, 'wait-wakeup', evidence, candidates, {
        ticket,
        pendingAtEval: pending,
      });
      // 本票据的终局由 evaluate 决定；这里只保证它从账上消失
      this.finishWaitWakeup(convKey, ticket);
    }
  }

  /** 把已收口的票据从表里摘掉（终局计数已在 evaluate 里记过）。 */
  private finishWaitWakeup(convKey: string, ticket: WaitTicket): void {
    const byTarget = this.waitTickets.get(convKey);
    if (byTarget === undefined) return;
    // 只摘**这一张**：判定期间可能已经建了新的票据（那是另一张，不归本次收口）
    if (byTarget.get(ticket.targetId) === ticket) byTarget.delete(ticket.targetId);
    if (byTarget.size === 0) this.waitTickets.delete(convKey);
  }

  private bumpWaitTicket(terminal: WaitTicketTerminal): void {
    if (terminal === 'resolved') this.counters.waitTickets.resolved += 1;
    else if (terminal === 'spent') this.counters.waitTickets.spent += 1;
    else if (terminal === 'stale') this.counters.waitTickets.stale += 1;
    else this.counters.waitTickets.unchanged += 1;
  }

  /**
   * 问题关闭（或被台账淘汰 / 话题翻篇）→ **立即**作废票据并取消唤醒。
   *
   * 这就是"本地可判的事不要花 LLM"：不等定时器到点再发现对象已经没了。
   */
  private closeTicket(convKey: string, targetId: string): void {
    const byTarget = this.waitTickets.get(convKey);
    const ticket = byTarget?.get(targetId);
    if (byTarget === undefined || ticket === undefined) return;
    byTarget.delete(targetId);
    this.bumpWaitTicket('stale');
    this.metrics.waitTicket('stale', ticket.scene);
    if (byTarget.size === 0) {
      this.waitTickets.delete(convKey);
      this.yieldTimers.get(convKey)?.();
      this.yieldTimers.delete(convKey);
      return;
    }
    // 还有别的票据在等 → 唤醒点重排到最近的到期时间
    const remaining = [...this.waitTickets.values()][0];
    const dueAt = Math.min(...[...(remaining?.values() ?? [])].map((item) => item.dueAt));
    if (Number.isFinite(dueAt)) this.rearmWaitYield(convKey, ticket.target, dueAt);
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
    wait?: { ticket: WaitTicket; pendingAtEval: readonly { id: string }[] },
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

    // 记账基准与判定调用**同一时刻**：唤醒时的"转录有没有新增"要跟
    // "上一次真正跑到判定的那一刻"比，而不是跟建票据那一刻比。
    const evaluatedAt = this.now();
    for (const question of wait?.pendingAtEval ?? []) {
      state.markEvaluated(question.id, evaluatedAt);
    }

    this.bump(this.counters.evaluatedByTrigger, trigger);
    this.counters.judgeCalls += 1;
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
      // 唤醒后的重判失败：票据**照样收口**（spent），否则账目不闭合、
      // 而且这张票据会在"判定坏掉"期间反复重排成一次新的唤醒。
      if (wait !== undefined) {
        this.bumpWaitTicket('spent');
        this.metrics.waitTicket('spent', wait.ticket.scene);
      }
      return;
    }
    this.judgeFailures.set(convKey, 0);

    for (const verdict of verdicts) {
      if (verdict.satisfied) this.bump(this.counters.satisfiedByScene, verdict.scene);
    }

    // ③ 否决层（纯函数）：顺序、额度、wait 采纳都在这里。
    const decision = evaluateVeto(
      {
        candidates,
        verdicts,
        context: this.vetoContext(convKey, state, now, evidence, verdicts, wait?.ticket),
      },
      this.policy,
    );

    // 唤醒后的重新判定：**任何结果都消耗票据**（同一对象不会再有第二次唤醒）。
    // 终局只有两种：判成立 → `resolved`；其余一律 `spent`（预算已用尽，静默）。
    // 注意"又给 yielding"也走 spent——让路预算在**建票据时**就已经扣掉了。
    if (wait !== undefined) {
      const resolved = decision.action === 'speak';
      const terminal: WaitTicketTerminal = resolved ? 'resolved' : 'spent';
      this.bumpWaitTicket(terminal);
      this.metrics.waitTicket(terminal, wait.ticket.scene);
      if (!resolved) {
        // 这次没让路（模型又给 yielding 也过不去预算）→ 对象到此为止，
        // 不再反复撞同一堵墙（与既有"拒绝也落标记"的口径一致）。
        state.markSilenced(wait.ticket.targetId);
      }
    }

    if (decision.action === 'silent') {
      this.bump(this.counters.vetoed, decision.reason);
      this.metrics.vetoed(decision.reason, decision.detail);
      this.countWaitDeclined(decision.reason, decision.detail, verdicts);
      // 拒绝也落标记：避免同一个问题被反复重探（撞同一堵墙）
      if (trigger === 'question-probe') {
        for (const question of state.pendingQuestions(now)) state.markSilenced(question.id);
      }
      return;
    }
    if (decision.action === 'wait') {
      this.bump(this.counters.vetoed, 'wait');
      this.createWaitTicket(convKey, target, decision.targetId, decision.reason, now, evaluatedAt);
      return;
    }

    // ④ 投递：唯一出口（dryRun / 平台能力差异都在它内部处理）。
    await this.deliver(convKey, target, decision, now);
  }

  /**
   * 建票据：把"等待"从会话级收窄为**条目级**（票据挂在对象上，不挂在会话上）。
   *
   * 同一对象已有一张待唤醒的票据时不重复排——每张票据只有一次唤醒机会，
   * 而"同一会话只有一个唤醒点"由 `armWaitYield` 保证。
   */
  private createWaitTicket(
    convKey: string,
    target: ConversationTarget,
    targetId: string,
    reason: WaitReason,
    now: number,
    evaluatedAt: number,
  ): void {
    const state = this.states.for(convKey);
    const byTarget = this.waitTickets.get(convKey) ?? new Map<string, WaitTicket>();
    if (byTarget.has(targetId)) {
      this.deps.logger.debug('主动介入：该对象已有待唤醒票据，不重排', {
        conversation: convKey,
        question: targetId,
      });
      return;
    }
    const waitYieldMs = effectiveWaitYieldMs(this.config.waitYieldMs);
    byTarget.set(targetId, {
      convKey,
      targetId,
      scene: 'scene-3',
      reason,
      createdAt: now,
      dueAt: now + waitYieldMs,
      evaluatedAt,
      target,
    });
    this.waitTickets.set(convKey, byTarget);
    // 预算记在**问题那一行**上（不是会话上）：这是"状态只按会话/话题/问题/
    // 花费窗口记账，永不按场景记账"的直接应用。
    state.recordYield(targetId);
    this.counters.waitTickets.created += 1;
    this.bump(this.counters.waitTicketsCreatedByReason, reason);
    this.metrics.waitTicketCreated(reason, 'scene-3');
    this.armWaitYield(convKey, target);
    this.deps.logger.debug('主动介入：让路（建 wait 票据）', {
      conversation: convKey,
      question: targetId,
      reason,
      waitYieldMs,
    });
  }

  /**
   * `not-yet` / `watching` **不得**进入 `vetoed.wait`：它们不是"被否决"，
   * 是"模型说不用等"。但必须有独立计数——否则模型意图在指标里彻底消失，
   * 调判据时无从下手（验收 10）。
   *
   * 引用无效（`wait:invalid-target`）单独计数，且**不**计入 `wait_declined`：
   * 前者是模型引用了不存在的对象，后者是模型明确说"先别说"。
   */
  private countWaitDeclined(
    reason: string,
    detail: string | undefined,
    verdicts: readonly SceneVerdict[],
  ): void {
    if (reason !== 'wait-declined' || detail === undefined) return;
    const scene = verdicts.find((verdict) => verdict.waitReason !== undefined)?.scene ?? 'scene-3';
    const payload = detail.startsWith('wait:') ? detail.slice('wait:'.length) : detail;
    const kind = payload.split('|')[0] ?? 'unknown';
    if (kind === 'invalid-target') {
      this.counters.waitTickets.invalidTarget += 1;
      this.metrics.waitInvalidTarget(scene);
      return;
    }
    // `stale`：唤醒时（或建票据前的复核里）发现对象已关闭。那张票据本来就没
    // 建出来，因此它既不算 declined 也不进账目等式（见 veto.ts 判定树第 ③ 步）。
    if (kind === 'stale') return;
    const label = kind === '' ? 'unknown' : kind;
    this.bump(this.counters.waitDeclined, label);
    this.metrics.waitDeclined(label, scene);
  }

  private vetoContext(
    convKey: string,
    state: ConversationState,
    now: number,
    evidence: SceneEvidence,
    verdicts: readonly SceneVerdict[],
    woken?: WaitTicket,
  ): VetoContext {
    const list = this.proposals.get(convKey) ?? [];
    const wait = this.resolveWaitTarget(state, evidence, verdicts, woken);
    return {
      now,
      spokeCount10Min: list.filter((ts) => now - ts <= 600_000).length,
      spokeCount1Hour: list.filter((ts) => now - ts <= 3_600_000).length,
      // 「每话题一次」的话题口径 = state 的活动窗口（静默超过窗口即翻篇，
      // 由 state.botSpeaks 内部判定并归零），watcher 不再自己算一遍。
      topicBotSpeaks: state.botSpeaks(now),
      ...(wait === undefined ? {} : { wait }),
    };
  }

  /**
   * 把模型给的对象引用（`q:<id>`）解析成**结构化事实**。
   *
   * 这一步是整条链的接缝：模型说"在等这个"，这里负责回答"台账里有没有它、
   * 它还挂着吗、让路预算用了多少"。三种结果对应三种完全不同的终局：
   *   - 台账里从来没有过 → `exists:false` → `wait_ticket_invalid_target`；
   *   - 曾经有过、现在没了 → `open:false` → `wait:stale`（省下一次调用）；
   *   - 仍挂着 → 看预算 → `wait` 或 `wait-spent`。
   *
   * 唤醒路径（`woken`）必须单独走一条：**那时对象已经不在挂起清单里了**
   * （问题没被答、没被关，票据才会走到重判），拿"当前清单"去判会把一次
   * 正常的重判误判成"引用无效"。所以判断依据换成"这张票据是不是我们自己
   * 建的那一张"——它当然是，因此 `exists:true`，`open` 用当前台账复核。
   */
  private resolveWaitTarget(
    state: ConversationState,
    evidence: SceneEvidence,
    verdicts: readonly SceneVerdict[],
    woken?: WaitTicket,
  ): WaitTarget | undefined {
    // ⚠️ 这里只筛"有没有说先别说"，**不筛理由是不是 yielding**：
    // 理由的采纳与否是否决层的决定（`not-yet` / `watching` 会被按下并单独计数）。
    // 若在这里顺手过滤掉它们，`not-yet` 会被误报成"引用了不存在的对象"——
    // 两个完全不同的原因混成一个计数，判据就再也调不动了。
    const waiter = verdicts.find(
      (verdict) =>
        !verdict.satisfied &&
        (verdict.waitReason ?? (verdict.suggestsWait === true ? 'yielding' : undefined)) !==
          undefined,
    );
    if (waiter === undefined) return undefined;

    // 唤醒路径：对象 id 以**我们自己建的票据**为准（那时它已经不在挂起清单里了）
    if (woken !== undefined && extractWaitTargetId(waiter.evidence) === undefined) {
      const open = evidence.pendingQuestions.some((question) => question.id === woken.targetId);
      return {
        id: woken.targetId,
        exists: true,
        open,
        yieldBudgetUsed: state.yieldBudget(woken.targetId),
      };
    }

    const targetId = extractWaitTargetId(waiter.evidence) ?? woken?.targetId;
    if (targetId === undefined) return undefined;

    if (woken !== undefined && woken.targetId === targetId) {
      const open = evidence.pendingQuestions.some((question) => question.id === targetId);
      return { id: targetId, exists: true, open, yieldBudgetUsed: state.yieldBudget(targetId) };
    }

    const inLedger = state.questionsById.has(targetId);
    const open = evidence.pendingQuestions.some((question) => question.id === targetId);
    if (!inLedger) {
      // 引用了台账里从来没有过的对象：留一条日志，便于对着
      // `wait_ticket_invalid_target` 的数据改判据描述（需求：持续 > 0 说明判据要更明确）
      this.deps.logger.debug('主动介入：模型引用了台账里不存在的挂起问题', {
        conversation: state.convKey,
        question: targetId,
      });
    }
    return { id: targetId, exists: inLedger, open, yieldBudgetUsed: state.yieldBudget(targetId) };
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
