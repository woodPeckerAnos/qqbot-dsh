import { immutableConstant } from '../../../readonly.js';
import type { DeepReadonly } from '../../../readonly.js';
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
import type { NormalizedMessage } from '../../../core/connector.js';
import type { Logger } from '../../../logger.js';
import type { ProactiveTaskRequest } from '../../../task/proactive-adapter.js';
import type { ObservationWindowStore } from '../../../store/window.js';
import type { InterestPool } from '../interests/pool.js';
import type { ConversationState, ConversationStateOptions } from './state.js';
import type { ProactiveJudge } from '../judge/client.js';
import type { ProactiveSpeaker, ProactiveTrigger } from '../deliver/speaker.js';
import type {
  SceneId,
  SceneTrigger,
  SessionCloseCause,
  VetoPolicy,
  WaitReason,
  WaitTicketTerminal,
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
export const DEFAULT_WATCHER_CONFIG = immutableConstant({
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
} as const);
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
export type NULL_WATCHER_METRICS = WatcherMetrics;
/** 一次投放的记录（`/metrics` 与 RUNBOOK 排障用）。 */
export interface ProposedRecord {
  readonly ts: number;
  readonly scene: SceneId;
  readonly trigger: SceneTrigger;
  readonly delivered: boolean;
}
export interface ProactiveWatcherDeps {
  submitTask?: (request: ProactiveTaskRequest) => Promise<boolean>;
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
   * @deprecated 历史措辞回归接缝，仅供旧测试夹具使用。
   * 生产注入 submitTask，由 ProactiveTaskAdapter 固定依据后提交双 lane Task。
   * 旧接缝返回 undefined 时按 compose-failed 降级记账。
   */
  compose?: (input: import('../contract.js').ProactiveComposeInput) => Promise<string | undefined>;
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
interface WatcherSnapshotValue {
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
  judgeRetries?: number;
  judgeFailuresByClass?: Record<string, number>;
  circuits?: Record<string, import('../../../judgment.js').JudgeCircuitSnapshot>;
  waitInvalidTargetsByReason?: Record<string, number>;
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
export type WatcherSnapshot = DeepReadonly<WatcherSnapshotValue>;
export interface ProactiveWatcher {
  /**
   * 旁听消息入口（**同步、永不抛错**）。
   *
   * 顺序即成本纪律：白名单 + 总开关 → 入状态 → 立即评估（场景 1/4）
   * → 问题探针（场景 3）→ 滚动收敛（场景 2/5）。
   */
  observe(message: NormalizedMessage): void;
  /**
   * 一条**已被 @** 的消息（走 Ingress 的那条）也记进旁听缓冲。
   *
   * 理由：场景 1 的判据是"接续 bot 上一条"，而 bot 的回复与用户的 @ 消息
   * 都不在旁听流里。不记的话，判定看到的转录会缺掉对话的另一半。
   *
   * 写入的是**共享的**观察窗口（不是本模块私有的缓冲）：被动回复路径读的是
   * 同一个窗口，所以"这个人问的是哪件事"两边看到的是同一份事实。
   */
  observeAddressed(message: NormalizedMessage): void;
  /**
   * bot 在本群发了一条**主动**发言（组装层在投递成功后调用，用于记账）。
   *
   * `text` 可选：给了就一并写进**共享观察窗口**（被动回复路径据此看到"bot 刚说过
   * 什么"）。判定层要不要看它由 `judgeSeesBotSpeaks` 决定，本方法不做取舍。
   */
  notifyBotSpoke(convKey: string, ts?: number, text?: string): void;
  /**
   * 该会话是否在介入范围内（白名单 + 总开关）。
   *
   * 判据实现搬到了 `store/window.ts` 的 `matchesGroupAllowlist`：介入层与观察
   * 窗口必须用**同一份**白名单解析（条目有 `onebot:123456` 与 `ob11:g123456`
   * 两种写法，各写一份迟早分叉，而分叉的表现是"介入层认这个群、滚窗不认"）。
   */
  isAllowed(convKey: string): boolean;
  /** 取某会话的旁听状态（排障与测试；只读语义由调用方自觉）。 */
  stateFor(convKey: string): ConversationState;
  snapshot(): WatcherSnapshot;
}
export type createProactiveWatcherFactory = (deps: ProactiveWatcherDeps) => ProactiveWatcher;
/** 场景 id → 投递层的 trigger 标签（进指标与日志）。 */
export type sceneTriggerName = (scene: SceneId) => ProactiveTrigger;

import {
  DEFAULT_MAX_WAIT_PER_ITEM,
  DEFAULT_SESSION_BUDGET,
  DEFAULT_SESSION_IDLE_MS,
  DEFAULT_SESSION_MIN_GAP_MS,
  DEFAULT_WAIT_YIELD_MS,
} from '../contract.js';
