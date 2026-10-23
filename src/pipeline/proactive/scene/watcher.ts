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
 *
 * ## 话题 session（见 docs/TOPIC-SESSION-REQUIREMENT.md）
 *
 * 主动发言的**唯一放行闸门**，本文件是它全部副作用的持有者：
 *
 * - **开**：判定判"值得"、而当时没有 session、且这一句真的说出去了 → 开一个
 *   （`budgetLeft = sessionBudget`，本次发言消耗 1 点）；
 * - **扣**：每说一句扣 1 点；扣到 0 **不关闭**，只让它在当前话题里闭嘴
 *   （闸门报 `budget-exhausted`）——**预算不驱动 session 的生死**；
 * - **关**：四种原因穷举（`SessionCloseCause`：`llm-closed` / `topic-changed` /
 *   `idle` / `conversation-gone`），关闭只有一个出口
 *   （`ConversationState.closeSession` → 监听器 → 记账），因此账目必然闭合；
 * - **重启**：模型说"换话题了"（`new-topic`）→ 关旧（`topic-changed`）开新、预算重置。
 *   这是预算**唯一**的重置正门（`min-gap` 照样要过，节奏不归模型管）；
 * - **静默**：距 `lastSpokeAt`（无则 `openedAt`）超过 `sessionIdleMs` 自动关闭，
 *   **不调 LLM**（定时器 + 唤醒路径上的兜底检查，双保险）。
 *
 * 唯一没有 session 也能做的事：`wait` 票据（它挂在**挂起问题**上，与会话无关）。
 */

import type { ConversationTarget, NormalizedMessage } from '../../../core/connector.js';
import type { Logger } from '../../../logger.js';
import {
  matchesGroupAllowlist,
  type ObservationEntry,
  type ObservationWindowStore,
} from '../../../store/window.js';
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
  aggregateSessionDirective,
  DEFAULT_MAX_WAIT_PER_ITEM,
  DEFAULT_SESSION_BUDGET,
  DEFAULT_SESSION_IDLE_MS,
  DEFAULT_SESSION_MIN_GAP_MS,
  DEFAULT_WAIT_YIELD_MS,
  effectiveMaxWaitPerItem,
  effectiveSessionBudget,
  effectiveSessionIdleMs,
  effectiveSessionMinGapMs,
  effectiveWaitYieldMs,
  MAX_SESSION_BUDGET_CAP,
  MAX_WAIT_PER_ITEM_CAP,
  type ProactiveCompose,
  type ProactiveDecision,
  type SceneCandidate,
  type SceneEvidence,
  type SceneId,
  type SceneTrigger,
  type SceneVerdict,
  type SessionCloseCause,
  type TopicSession,
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
  /**
   * 一个 session 内允许的主动发言条数（默认 2；硬上限 `MAX_SESSION_BUDGET_CAP` = 5）。
   *
   * 它是"防刷屏"的主闸：预算用完即关闭 session，之后要 LLM 重新判"值得"才会开
   * 新的。配得比硬上限大时按硬上限处理并 warn——否则"少说两句"只需改一行配置。
   */
  sessionBudget: number;
  /**
   * 静默多久自动关闭 session（毫秒；默认 600000 = 10 分钟，与活动窗口同值）。
   *
   * 锚点是 `lastSpokeAt`（还没说过则是 `openedAt`）——**不**被群里的新消息刷新：
   * "session 该不该继续"是 bot 自己说话的节奏，不是群消息的密度。
   */
  sessionIdleMs: number;
  /** 同一 session 内两次发言的最小间隔（毫秒；默认 45000），闸门三道检查之一 */
  sessionMinGapMs: number;
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
  sessionBudget: DEFAULT_SESSION_BUDGET,
  sessionIdleMs: DEFAULT_SESSION_IDLE_MS,
  sessionMinGapMs: DEFAULT_SESSION_MIN_GAP_MS,
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
  /**
   * **开了一个话题 session**（LLM 判"值得"且该次发言真的发出/本应发出时）。
   *
   * 与 `spoke` 一起看：开得多、说得少 = 判据偏松（每开一个只敢说一句就关）。
   */
  sessionOpened(scene: SceneId): void;
  /**
   * **关了一个话题 session**（四种原因之一；`speaks` = 这个 session 里说了几句）。
   *
   * 账目纪律：`Σ sessionClosed === sessionOpened`（每次开启只有一个终局）。
   * `speaks` 的分布是回答"预算 2 到底对不对"的核心数据。
   */
  sessionClosed(cause: SessionCloseCause, speaks: number): void;
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
  sessionOpened: () => {},
  sessionClosed: () => {},
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
  /**
   * 共享的观察窗口（滚窗）。
   *
   * **必填**：滚窗不再由本模块持有——它同时服务于被动回复路径
   * （见 `store/window.ts` 顶部）。组装层创建一次，按需注入给两侧。
   *
   * ⚠️ 本模块**仍然**用 `config.whitelistGroups` 做准入判断（判定不该为白名单外
   * 的群花一次 LLM）。两者用同一个 `matchesGroupAllowlist` 实现，因此不可能分叉。
   */
  windows: ObservationWindowStore;
  /** 判定能力；未注入 = 只收集不判定（"只听不说"的部署形态） */
  judge?: ProactiveJudge;
  /**
   * 发言生成能力（`TurnRunner.runProactiveTurn`）：把判定的 `directive` 要点
   * 措辞成真实文案（同一 runtime 会话、同一观察窗口、可以用工具）。
   *
   * 只在**真实发言**（`dryRun: false`）时调用；dryRun 不碰它——灰度观察的是
   * 判据质量，不该为一句不会发出去的话花一次 agent turn、污染会话记忆。
   * 未注入且 dryRun 关闭 = 退回"直接发判定要点"的旧行为（构造期会 warn，
   * 因为那会发出"直接回答 xx 的要点（依据：…）"这种元文本）。
   *
   * 返回 `undefined` = 本次不发言（会话忙 / 生成失败 / 模型看完完整上下文
   * 后选择不说），按 `compose-failed` 投递降级记账，不消耗预算、不开 session。
   */
  compose?: ProactiveCompose;
  interests?: InterestPool;
  metrics?: WatcherMetrics;
  logger: Logger;
  /** 注入时钟（测试用）；缺省 Date.now */
  now?: () => number;
  /** 注入调度器（测试用手动时钟）；返回取消函数 */
  schedule?: (fn: () => void, delayMs: number) => () => void;
  /**
   * 判定用的转录里是否包含 **bot 自己的发言**（缺省 `false`）。
   *
   * 为什么默认关：`store/window.ts` 现在**总是**记录 bot 的回复（被动注入需要
   * 它，否则模型看不到自己刚说过什么），但判定层要不要看它是另一件事——
   * 打开会实打实改变场景 1「续聊追问」的判据输入（转录里第一次出现 bot 自己的
   * 句子）。这是**行为变更**，不该混在一次"纯搬运"的重构里默认发生。
   *
   * 打开它的收益是明确的：`docs/PROACTIVE-INTERVENTION-ARCH.md` §3.6 记的
   * "判定方在不知道自己刚才说了什么的情况下决定要不要接话"从此有一个直接开关。
   */
  judgeSeesBotSpeaks?: boolean;
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
  /**
   * **话题 session 的账目与闸门**（本需求的核心观测面）。
   *
   * 一条等式必须成立：`opened === closed === Σ closedBy{reason}`。
   * `spokeInSession` 是"每个 session 里说了几句"的分布（键是句数）——
   * 它与 `opened` 的联合分布能一眼回答"预算 2 到底对不对"（需求「可观测性」）。
   */
  sessions: {
    /** 当前开启中的 session 数（**含预算已耗尽的**：预算不关会话，只让它闭嘴） */
    open: number;
    /** 其中预算已用尽、正在这个话题里闭嘴的会话数（`open - spent` = 还能开口的） */
    spent: number;
    /** 一天开了几个 session（`proactiveSessionOpened`） */
    opened: number;
    /** 关了几个（`proactiveSessionClosed`，等于 `Σ closedBy`） */
    closed: number;
    /** 按原因拆开（`proactiveSessionClosedBy{reason}`，四种原因穷举） */
    closedBy: Record<string, number>;
    /** 「每个 session 里说了几句」的分布：`{"1": N, "2": M}` */
    spokeInSession: Record<string, number>;
    /** 因为"没有 session"被挡的唤醒次数（`proactiveNoSession`） */
    noSession: number;
    /**
     * 因为"本话题的发言预算已用尽"被挡的次数（`proactiveBudgetExhausted`）。
     *
     * 它是本机制的**主路径之一**：预算耗尽不关会话，所以同一个话题里"还想说、
     * 但额度没了"会一次次记在这里（高 = 预算偏紧；低 = 预算够用）。
     */
    budgetExhausted: number;
    /** 因为"最小间隔没到"被挡的次数（`proactiveMinGap`） */
    minGap: number;
    /** 生效的三个参数（硬上限裁剪之后的值；health 里直接可读） */
    budget: number;
    idleMs: number;
    minGapMs: number;
  };
  /**
   * 被**唯一的本地闸**挡下的次数：转录自上次进入判定以来没有新增，连 LLM 都不调
   * （只装在滚动收敛 `topic-roll` 上，见 `kick()` 里的说明）。
   *
   * 需求说它"不单独计数（属未进入判定）"，所以它**不进 `vetoed`**；单列一个数字
   * 是为了排障时能回答"它为什么一直不说话"——这个数高说明群里根本没新消息，
   * 而不是判据把它们全否了。
   */
  skippedUnchanged: number;
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
  /** 共享的观察窗口（组装层注入；滚窗的唯一持有者） */
  private readonly windows: ObservationWindowStore;
  /**
   * 判定转录是否含 bot 自己的发言。
   *
   * 构造期就定成布尔值（而不是每次读 `deps`）：转录的形态不该在运行期漂移，
   * 否则"同一段对话两次判定的输入不一致"会变成一件可能发生的事。
   */
  private readonly judgeSeesBotSpeaks: boolean;

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

  /**
   * 每会话一个**静默关闭定时器**（`sessionIdleMs`；锚点 = `lastSpokeAt ?? openedAt`）。
   *
   * 为什么必须是定时器而不是"下次唤醒时顺便看一眼"：群里彻底安静时根本不会再有
   * 唤醒（唯一的本地闸会把定时唤醒全挡掉），于是 session 会带着剩余预算永远活着，
   * 下一次有人说话时它已经"过期两小时"却还算数。到点关闭是**零 LLM 成本**的兜底
   * （验收 6：`idle` 关闭不调 LLM）。
   */
  private readonly idleTimers = new Map<string, () => void>();

  /** 生效的三个 session 参数（构造期就把硬上限裁剪做掉，双保险：否决层还有一道） */
  private readonly sessionBudget: number;
  private readonly sessionIdleMs: number;

  private readonly counters = {
    evaluatedByTrigger: new Map<string, number>(),
    satisfiedByScene: new Map<string, number>(),
    vetoed: new Map<string, number>(),
    deliveryDegraded: new Map<string, number>(),
    waitDeclined: new Map<string, number>(),
    waitTicketsCreatedByReason: new Map<string, number>(),
    sessionClosedBy: new Map<string, number>(),
    spokeInSession: new Map<string, number>(),
    collectedOnly: 0,
    judgeCalls: 0,
    spoke: 0,
    wouldSend: 0,
    judgeFailures: 0,
    sessionOpened: 0,
    sessionClosed: 0,
    skippedUnchanged: 0,
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
      sessionMinGapMs: effectiveSessionMinGapMs(deps.config.sessionMinGapMs),
      ...(deps.config.vetoPolicy ?? {}),
    };
    // session 预算同样在**装配时**就把硬上限做掉（验收 9：配成 9 按 5 处理并 warn）。
    // 理由是同一句纪律：把"少说两句"改回"多说几句"不该只需要改一行配置。
    const configuredBudget = deps.config.sessionBudget;
    this.sessionBudget = effectiveSessionBudget(configuredBudget);
    if (Number.isFinite(configuredBudget) && configuredBudget > MAX_SESSION_BUDGET_CAP) {
      deps.logger.warn('proactive:sessionBudget 超过硬上限，按硬上限处理', {
        configured: configuredBudget,
        effective: this.sessionBudget,
        cap: MAX_SESSION_BUDGET_CAP,
      });
    }
    this.sessionIdleMs = effectiveSessionIdleMs(deps.config.sessionIdleMs);
    // 真实发言但没接发言生成：发出去的将是判定要点原文（"直接回答 xx 的要点
    // （依据：…）"这种元文本）。装配期就 warn，比灰度期间在群里看到好查。
    if (!deps.config.dryRun && deps.compose === undefined) {
      deps.logger.warn('主动介入：未注入发言生成（compose），真实发言将直接发送判定要点文本');
    }
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
    this.windows = deps.windows;
    this.judgeSeesBotSpeaks = deps.judgeSeesBotSpeaks === true;
    // 判定层状态：**不再自己造缓冲**，共用组装层注入的观察窗口（见 store/window.ts）
    this.states = new ConversationStateStore(deps.windows, deps.config.stateOptions ?? {});
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
    // session 关闭 → 记账（验收 11 的账目等式只有一个来源）+ 撤掉静默定时器。
    // 订阅同样必须在**创建会话状态之前**完成，否则早期关闭事件会丢。
    this.states.onSessionClosed((convKey, event) => {
      this.onSessionClosed(convKey, event.cause, event.session);
    });
  }

  /**
   * session 关闭的唯一收口（四种原因都从这里过）。
   *
   * `speaks` 用 `预算 - budgetLeft` 反算：session 的三个字段之外**不额外存计数器**
   * （需求 §一：状态就是三个字段），而开启时预算恰好等于 `sessionBudget`。
   */
  private onSessionClosed(convKey: string, cause: SessionCloseCause, session: TopicSession): void {
    this.cancelIdleTimer(convKey);
    const speaks = Math.max(0, this.sessionBudget - session.budgetLeft);
    this.counters.sessionClosed += 1;
    this.bump(this.counters.sessionClosedBy, cause);
    this.bump(this.counters.spokeInSession, String(speaks));
    this.metrics.sessionClosed(cause, speaks);
    this.deps.logger.debug('主动介入：话题 session 已关闭', {
      conversation: convKey,
      cause,
      speaks,
      openedAt: session.openedAt,
      budgetLeft: session.budgetLeft,
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
    // ⚠️ 两道准入判断的是**同一件事**，不是重复：`windows.accepts` 决定"记不记进
    // 滚窗"，`isAllowed` 决定"要不要为它花一次判定"。今天两者的白名单是同一个，
    // 所以结果总是同时为真/假；分开写是为了让"记多久"与"要不要评估"能各自演化
    // （例如将来允许某个群只旁听不插话）。
    if (!this.config.enabled || !this.isAllowed(message.target.key)) return;

    const ts = Number.isFinite(message.ts) ? message.ts : this.now();
    const state = this.states.for(message.target.key);

    // session 静默超时的兜底（排在读状态**之前**：证据与闸门看到的状态必须一致）：
    // 定时器到点是常态，但进程睡过去再醒来时它可能还没跑，而一个"过期两小时"的
    // session 会让下面的判定以为话题还热着。这里只关、**不终止本次评估**——
    // 一条刚到的消息本身就可能让 LLM 判"值得"，从而开一个新的（验收 13）。
    this.closeExpiredSession(message.target.key);

    // ⚠️ 顺序要紧：**先**做本地预筛（读的是这条消息之前的状态），**再**入状态。
    // 反过来会让"没人理我就停"这一步永远失效——入状态会把无人回应计数清零，
    // 于是后面再读就永远是 0（实测踩过：连说两次没人接，第三条消息照样会触发判定）。
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

    // 入状态 = 写共享窗口 + 判定层记账（两者在 `state.observeEntry` 里收口）
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
   *
   * 写入的是**共享的**观察窗口（不是本模块私有的缓冲）：被动回复路径读的是
   * 同一个窗口，所以"这个人问的是哪件事"两边看到的是同一份事实。
   */
  observeAddressed(message: NormalizedMessage): void {
    if (!this.config.enabled || !this.isAllowed(message.target.key)) return;
    // 走判定层的写入路径（而不是直接写窗口）：@ 也必须刷新活动窗口与参与人、
    // 并归零"没人理我"计数——它同样是"群里有人理我了"（见 scene-state 验收 7）。
    this.states.for(message.target.key).observeAddressed(message);
  }

  /**
   * bot 在本群发了一条**主动**发言（组装层在投递成功后调用，用于记账）。
   *
   * `text` 可选：给了就一并写进**共享观察窗口**（被动回复路径据此看到"bot 刚说过
   * 什么"）。判定层要不要看它由 `judgeSeesBotSpeaks` 决定，本方法不做取舍。
   */
  notifyBotSpoke(convKey: string, ts: number = this.now(), text?: string): void {
    if (!this.config.enabled || !this.isAllowed(convKey)) return;
    this.states.for(convKey).recordBotSpoke(ts);
    if (text !== undefined && text.trim() !== '') {
      // 共享窗口也记一份（供被动回复路径读取）。写不进去（例如白名单外）就跳过：
      // 窗口的准入由它自己判，调用方不重复判一次。
      this.windows.recordBotReply(convKey, { text, ts });
    }
    const list = this.proposals.get(convKey) ?? [];
    list.push(ts);
    // 只保留 1 小时窗口内的（限流窗口最长就是 1 小时）
    const cutoff = ts - 3_600_000;
    this.proposals.set(
      convKey,
      list.filter((item) => item >= cutoff),
    );
  }

  /**
   * 该会话是否在介入范围内（白名单 + 总开关）。
   *
   * 判据实现搬到了 `store/window.ts` 的 `matchesGroupAllowlist`：介入层与观察
   * 窗口必须用**同一份**白名单解析（条目有 `onebot:123456` 与 `ob11:g123456`
   * 两种写法，各写一份迟早分叉，而分叉的表现是"介入层认这个群、滚窗不认"）。
   */
  isAllowed(convKey: string): boolean {
    return matchesGroupAllowlist(convKey, this.config.whitelistGroups);
  }

  /** 取某会话的旁听状态（排障与测试；只读语义由调用方自觉）。 */
  stateFor(convKey: string): ConversationState {
    return this.states.for(convKey);
  }

  snapshot(): WatcherSnapshot {
    let pending = 0;
    let tickets = 0;
    let openSessions = 0;
    let spentSessions = 0;
    const now = this.now();
    for (const state of this.states.all()) {
      pending += state.pendingQuestions(now).length;
      if (state.session !== undefined) {
        openSessions += 1;
        // 预算已耗尽、正在这个话题里闭嘴的会话：它们**仍然开着**（预算不驱动
        // session 的生命周期），单独报出来，免得 `open` 看起来像"还能说"
        if (state.session.budgetLeft <= 0) spentSessions += 1;
      }
    }
    for (const byTarget of this.waitTickets.values()) tickets += byTarget.size;
    return {
      enabled: this.config.enabled,
      dryRun: this.config.dryRun,
      // `conversations` / `buffered` 报的是**共享观察窗口**的口径（不是判定状态的
      // 会话数）：滚窗现在服务两条唤醒路径，health 上要回答的是"我们记了多少"，
      // 而不是"介入层给几个群建了状态"。
      conversations: this.windows.size,
      buffered: this.windows.buffered,
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
      sessions: {
        open: openSessions,
        /** 其中预算已用尽、正在这个话题里闭嘴的（`open - spent` = 还能开口的） */
        spent: spentSessions,
        opened: this.counters.sessionOpened,
        closed: this.counters.sessionClosed,
        closedBy: Object.fromEntries(this.counters.sessionClosedBy),
        spokeInSession: Object.fromEntries(this.counters.spokeInSession),
        // 闸门三类不过**从 `vetoed` 派生**，不另立一本账：同一件事只有一个来源，
        // 否则"计数对不上"的排查成本会立刻转移到观测面本身。
        noSession: this.counters.vetoed.get('no-session') ?? 0,
        // 这个数现在是**活的主路径**：预算耗尽不关会话，所以每次"还想说但额度没了"
        // 的唤醒都会落在这里（维护者口径修正后，它才真正回答"预算该不该加"）。
        budgetExhausted: this.counters.vetoed.get('budget-exhausted') ?? 0,
        minGap: this.counters.vetoed.get('min-gap') ?? 0,
        budget: this.sessionBudget,
        idleMs: this.sessionIdleMs,
        minGapMs: this.policy.sessionMinGapMs,
      },
      skippedUnchanged: this.counters.skippedUnchanged,
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

    // ① 唯一的本地闸（需求 §三）：转录自上次进入判定以来**没有新增** → 直接返回，
    //    连 LLM 都不调。它不含任何语义判断，成本只有一次 `buffer.some()`；没有它，
    //    定时唤醒会在群里完全安静时反复问同一个问题（上一轮花力气修掉的永动机）。
    //
    //    它装在**滚动收敛**（`topic-roll`）与 wait 的定时重查上，**不装**在另外两处：
    //
    //    - `message`：一条旁听消息的到达本身就是"转录有新增"的证据，再拿时间戳比
    //      一次只会引入平台时钟粒度的假阴性——OneBot 的事件时间是**秒**
    //      （`time * 1000`，见 adapters/onebot/normalize.ts），同一秒内到达的后续
    //      消息会被误判成"没有新增"，最高频的那条触发面会被整体吞掉；
    //    - `question-probe`：它是**时间**触发（"这问题挂了 90 秒还没人答"），沉默
    //      本身就是它的信号，而不是它的反例；而且它天生有界（每个问题最多
    //      `maxQuestionProbes` 次、且只由消息重新武装），不会变成"群里安静时反复
    //      重问"的永动机——那正是这道闸门要防的东西。
    //
    //    ⚠️ 实测过的后果：把探针也闸掉时，"bot 刚主动开过口 → 有人提问 → 90 秒后
    //    接过来"这条链在本话题的活动窗口内**完全不会发生**（窗口内每条消息都会
    //    触发一次消息面判定，把"上次评估"推到最后一条消息上，探针永远"无新增"）。
    //    维护者口径：探针免闸。
    const state = this.states.for(convKey);
    const gated = trigger === 'topic-roll';
    if (gated && !state.hasNewContentSinceLastEvaluation()) {
      this.counters.skippedUnchanged += 1;
      this.deps.logger.debug('主动介入：转录自上次判定以来无新增，本次不调 LLM', {
        conversation: convKey,
        trigger,
      });
      return;
    }
    // ② session 静默超时的兜底（定时器没跑到时也不会让 session 越活越久）。
    //    关闭后本次唤醒**到此为止**——验收 6：idle 关闭不调 LLM。
    if (this.closeExpiredSession(convKey)) {
      this.deps.logger.debug('主动介入：session 静默超时，已关闭且本次不调 LLM', {
        conversation: convKey,
        trigger,
        sessionIdleMs: this.sessionIdleMs,
      });
      return;
    }

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
   * 判定转录的条目来源（**唯一**一处决定判定能看到什么）。
   *
   * 从共享窗口读，而不是从某个私有缓冲：滚窗同时喂被动回复路径，两条路径看到
   * 的必须是同一份事实（否则"判定说没人问过、回复时却看得到"这种不一致会成为
   * 常驻现象）。
   *
   * bot 自己的发言**默认剔除**：窗口里现在总有它（被动注入需要），但判定层的转录
   * 长期以来只含群友的话，把这个输入换掉是一次实打实的行为变更——由
   * `judgeSeesBotSpeaks` 显式打开，不混在重构里默认发生（见 deps 的说明）。
   */
  private judgeTranscriptEntries(state: ConversationState): readonly ObservationEntry[] {
    if (this.judgeSeesBotSpeaks) return state.entries;
    return state.entries.filter((entry) => entry.isBot !== true);
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
  // 内部：话题 session 的生命周期（开关、扣预算、静默定时器）
  // -------------------------------------------------------------------------

  /**
   * 一次判定的结果落到 session 上（**唯一入口**，验收 1/5 与"换话题重置预算"都在这里兑现）。
   *
   * ```
   * 说了（真的发出去 / dryRun 本应发出）
   *     ├ 没有 session                 → 开一个（预算 = sessionBudget）
   *     ├ 模型说换话题了（new-topic）   → 关旧（topic-changed）+ 为新话题开一个（预算重置）
   *     └ 扣 1 点预算、记 lastSpokeAt  → 减到 0 **不关闭**，只是闭嘴（闸门下次报 budget-exhausted）
   * 模型说这个话题收口了（close）
   *     └ 关闭（llm-closed）——本次该说的那句**照样已经说了**（验收 5）
   * ```
   *
   * 顺序要点：
   *   1. **先开再扣**：验收 1 要求"开启时 budgetLeft = sessionBudget，该次发言消耗 1 点"；
   *   2. **预算不驱动 session**（维护者口径）：预算减到 0 时这里**什么都不做**——
   *      会话留着，闸门下一次唤醒报 `budget-exhausted`；要重置预算只有两条路，
   *      都由话题驱动：模型明确说换了话题（`new-topic`），或会话自然结束
   *      （`close` / `idle`）后由下一次判定重新开；
   *   3. 没说出话（投递降级 / 平台不支持）时**不消耗预算、也不开 session**：
   *      预算是"说了几句"的账，不是"想过几次"的账。
   */
  private applySessionOutcome(
    convKey: string,
    now: number,
    scene: SceneId | undefined,
    spoken: boolean,
    directive: { restart: boolean; close: boolean },
  ): void {
    const state = this.states.for(convKey);
    if (spoken) {
      const current = state.session;
      if (current === undefined) {
        this.openTopicSession(convKey, now, scene);
      } else if (directive.restart) {
        // 模型明确说"换话题了"：旧会话为**新话题**让位。这是预算重启的唯一正门
        // （闸门那一侧也已按 `new-topic` 放行），关闭原因记 `topic-changed`。
        state.closeSession('topic-changed');
        this.openTopicSession(convKey, now, scene);
      }
      state.consumeSessionBudget(now);
      // ⚠️ 预算减到 0 **不关闭** session：它进入"已耗尽"状态，此后每次唤醒都被
      // 闸门挡在 `budget-exhausted` 上。这正是"session 不由预算驱动"。
    }
    if (directive.close) {
      // 验收 5：关闭不影响这一条（发言已经在上面的分支里发出去了）；
      // 边界表：`close` 与"要不要说"是两个维度，没说不代表不关。
      // （聚合规则保证 `restart` 与 `close` 不会同时为真。）
      state.closeSession('llm-closed');
      return;
    }
    if (spoken) this.armSessionIdle(convKey);
  }

  /** 开一个话题会话（唯一的开启入口——只有"真的说出去了一句"才会走到这里）。 */
  private openTopicSession(convKey: string, now: number, scene: SceneId | undefined): void {
    const state = this.states.for(convKey);
    if (!state.openSession(now, this.sessionBudget)) {
      // 正常路径下不可能发生（调用方已确认没有 session）；真发生了要留痕
      this.deps.logger.warn('主动介入：已有 session 时又尝试开启，已忽略', {
        conversation: convKey,
        scene,
      });
      return;
    }
    this.counters.sessionOpened += 1;
    // `scene` 只有"判定层说要发言"那条路径才给得出来；开启必然发生在那里，
    // 这里只是让类型对上（真出现 undefined 也不该丢账）。
    if (scene !== undefined) this.metrics.sessionOpened(scene);
    this.deps.logger.debug('主动介入：开启话题 session', {
      conversation: convKey,
      scene,
      budget: this.sessionBudget,
    });
  }

  /**
   * 按"距上次发言（无发言则开启）多久"排一个静默关闭定时器。
   *
   * 每次发言都会重排（锚点前移）；到点时**只关 session，不调 LLM**（验收 6）。
   */
  private armSessionIdle(convKey: string): void {
    this.cancelIdleTimer(convKey);
    const anchor = this.sessionAnchor(convKey);
    if (anchor === undefined) return;
    const delay = Math.max(0, anchor + this.sessionIdleMs - this.now());
    this.idleTimers.set(
      convKey,
      this.schedule(() => {
        this.idleTimers.delete(convKey);
        this.closeIdleSession(convKey);
      }, delay),
    );
  }

  private cancelIdleTimer(convKey: string): void {
    this.idleTimers.get(convKey)?.();
    this.idleTimers.delete(convKey);
  }

  /** 静默计时的锚点：`lastSpokeAt ?? openedAt`（没有 session 时返回 undefined）。 */
  private sessionAnchor(convKey: string): number | undefined {
    const session = this.states.for(convKey).session;
    if (session === undefined) return undefined;
    return session.lastSpokeAt ?? session.openedAt;
  }

  /**
   * 静默是否已经到点（**唯一的口径**，定时器与唤醒兜底共用它）。
   *
   * 边界取 `>=`：定时器就是按"锚点 + `sessionIdleMs`"排的，到点即过期。
   * 两处各写一次比较会出现"定时器关了、兜底却认为没过期"这种只在毫秒边界
   * 显形的分裂，所以这里只留一份。
   */
  private sessionIdleElapsed(convKey: string, now: number): boolean {
    const anchor = this.sessionAnchor(convKey);
    if (anchor === undefined) return false;
    return now - anchor >= this.sessionIdleMs;
  }

  /** 定时器到点：确认仍然静默超时，然后关闭（`idle`）。 */
  private closeIdleSession(convKey: string): void {
    const state = this.states.for(convKey);
    if (state.session === undefined) return;
    if (!this.sessionIdleElapsed(convKey, this.now())) {
      // 时钟被推进过 / 定时器早到：按剩余时间重排，不误关
      this.armSessionIdle(convKey);
      return;
    }
    state.closeSession('idle');
  }

  /**
   * 唤醒路径上的兜底检查：session 已静默超时 → 就地关闭并**终止本次唤醒**。
   *
   * 返回 true 表示"刚关掉一个过期的 session"，调用方必须直接返回：
   * 验收 6 要求 `idle` 关闭**不调 LLM**，而这次唤醒的全部意义已经被它用掉了。
   */
  private closeExpiredSession(convKey: string): boolean {
    const state = this.states.for(convKey);
    if (state.session === undefined) return false;
    if (!this.sessionIdleElapsed(convKey, this.now())) return false;
    state.closeSession('idle');
    return true;
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
    // 会话级与问题级**两个基准同刻写入**：它们各自服务一条唤醒路径
    // （session 的定时唤醒 / wait 票据的到期唤醒），但必须共用同一份
    // `hasNewContentSince` 实现（见 docs/TOPIC-SESSION-REQUIREMENT.md「关系」一节）。
    const evaluatedAt = this.now();
    state.markEvaluatedAt(evaluatedAt);
    for (const question of wait?.pendingAtEval ?? []) {
      state.markEvaluated(question.id, evaluatedAt);
    }

    this.bump(this.counters.evaluatedByTrigger, trigger);
    this.counters.judgeCalls += 1;
    this.metrics.evaluated(trigger);

    const verdicts = await judge.judge({
      candidates,
      evidence,
      transcript: `${renderFacts(evidence, pendingTexts)}\n\n${renderTranscript(
        this.judgeTranscriptEntries(state),
      )}`,
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

    // 判定层对"当前这个话题的 session 该怎么办"的回答（本次需求唯一新增的字段）。
    // 聚合规则只有一处实现（`aggregateSessionDirective`），否决层的闸门与本层共用
    // 它——否则会出现"闸门按 new-topic 放行了、本层却不认"这种只在冲突输出下显形的分裂。
    const sessionOutcome = aggregateSessionDirective(verdicts);

    // ③ 否决层（纯函数）：顺序、额度、session 闸门、wait 采纳都在这里。
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
      // 本次不发言，但模型说"这个话题该收口了" → 照样关闭（边界表：
      // `close` 与"要不要说"是两个维度）。`new-topic` 单独出现（没有发言）不做事：
      // 它是"为现在这个话题重开会话"，没有发言就没有要重开的东西。
      if (sessionOutcome.close) {
        this.applySessionOutcome(convKey, now, undefined, false, sessionOutcome);
      }
      return;
    }
    if (decision.action === 'wait') {
      this.bump(this.counters.vetoed, 'wait');
      // "让路"这一支**不动 session**：模型此刻说的是"有人在答，过几十秒再看"，
      // 与"这个话题还要不要继续"是两件事；真要收口，重判那次会给 close。
      this.createWaitTicket(convKey, target, decision.targetId, decision.reason, now, evaluatedAt);
      return;
    }

    // ④ 投递：唯一出口（dryRun / 平台能力差异都在它内部处理）。
    const spoken = await this.deliver(convKey, target, decision, now);
    // ⑤ session 的收口（唯一入口）：开 / 换话题重建 / 扣预算（**不减到 0 就关**）/
    //    按模型的建议收口。
    this.applySessionOutcome(convKey, now, decision.scene, spoken, sessionOutcome);
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
      // session 闸门的全部依据（**只读**）：有没有开、预算还剩几句、上次发言多久前。
      // 语义提醒：这里**没有**任何"话题"口径的计数——旧实现按活动窗口数"本话题
      // 说过几次"，而话题是 LLM 之后才明确的东西，本地数不准（见需求 §技术方向）。
      ...(state.session === undefined ? {} : { session: state.session }),
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

  /**
   * 投递：唯一出口（dryRun / 平台能力差异都在它内部处理）。
   *
   * 返回"**是不是真的说出去了**"（含 dryRun 的"本应发出"），调用方据此决定
   * session 的走向：说了才扣预算、才开 session；投递降级（平台不支持 / 错误 /
   * 发言生成未果）不算说过——预算是"说了几句"的账，不是"想过几次"的账。
   *
   * 文案来源（真实模式）：判定的 `directive` 只是"该说什么"的**要点**，不是
   * 能对群说的话——先经 `compose`（一次真实 agent turn，见 contract.ts 的
   * `ProactiveComposeInput`）措辞成自然口语再发送。`compose` 返回 undefined
   * （会话忙 / 超时 / 模型看完上下文选择不说）时本次按 `compose-failed`
   * 降级记账，**不发言**。
   */
  private async deliver(
    convKey: string,
    target: ConversationTarget,
    decision: Extract<ProactiveDecision, { action: 'speak' }>,
    now: number,
  ): Promise<boolean> {
    const gist = decision.directive ?? decision.reason;
    let spokenText: string;
    if (this.config.dryRun || this.deps.compose === undefined) {
      // dryRun / 未接发言生成：保持旧文本（要点 + 依据）——dryRun 下它只进
      // 观察窗口（标"灰度未发送"）与日志，不会真的发到群里。
      const parts = [gist];
      if (decision.evidence !== undefined) parts.push(`（依据：${decision.evidence}）`);
      spokenText = parts.join('\n');
    } else {
      const composed = await this.deps.compose({
        target,
        scene: decision.scene,
        directive: gist,
        reason: decision.reason,
        ...(decision.evidence === undefined ? {} : { evidence: decision.evidence }),
      });
      if (composed === undefined || composed.trim() === '') {
        this.bump(this.counters.deliveryDegraded, 'compose-failed');
        this.metrics.deliveryDegraded('compose-failed', decision.scene);
        this.deps.logger.debug('主动介入：发言生成未果，本次不发言', {
          conversation: convKey,
          scene: decision.scene,
        });
        return false;
      }
      spokenText = composed;
    }
    const outcome = await this.deps.speaker.deliver({
      target,
      content: { text: spokenText },
      trigger: sceneTriggerName(decision.scene),
      reason: decision.reason,
    });

    if (isSent(outcome) || isWouldSend(outcome)) {
      const dryRun = isWouldSend(outcome);
      if (dryRun) this.counters.wouldSend += 1;
      else this.counters.spoke += 1;
      this.metrics.spoke(decision.scene, dryRun);
      // dryRun 也记账：否则"每次介入之后话题还算不算活着"的观察结果会失真。
      // 文本一并入**观察窗口**（`dryRun` 由窗口标成"灰度未发送"）——被动回复路径
      // 读的是同一个窗口，它必须知道"这个话题上 bot 已经开过口"。
      this.notifyBotSpoke(convKey, now, spokenText);
      return true;
    }
    // 走到这里只可能是 degraded（sent / would-send 已在上面 return）
    if (outcome.status !== 'degraded') return false;
    this.bump(this.counters.deliveryDegraded, outcome.reason);
    this.metrics.deliveryDegraded(outcome.reason, decision.scene);
    if (outcome.reason === 'unsupported') {
      this.deps.logger.debug('主动介入：本平台不支持主动发言，判定结果不投递', {
        conversation: convKey,
        scene: decision.scene,
      });
    }
    return false;
  }

  private bump<T>(map: Map<T, number>, key: T): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
}

/** 场景 id → 投递层的 trigger 标签（进指标与日志）。 */
export function sceneTriggerName(scene: SceneId): ProactiveTrigger {
  return `intervention:${scene}` as ProactiveTrigger;
}
