/**
 * 主动介入三层架构的**共享契约**（唯一的类型接缝）。
 *
 * ## 三层与各自**绝不能**做的事
 *
 * ```
 * ① 搜集层 collect.ts   本地、零 LLM 成本、纯函数
 *      产出：SceneEvidence（客观事实）+ SceneCandidate[]（候选，带权重）
 *      禁止：语义判断、发起 LLM 调用、决定谁赢
 * ② LLM 层  judge.ts    「每个候选场景是否成立」逐个判定（多标签）
 *      产出：SceneVerdict[]（成立与否 + 置信度 + 理由 + 证据）
 *      禁止：做优先级/预算裁决（那是策略，不是语义）；产生清单外的场景
 * ③ 否决层 veto.ts      确定性约束 + **顺序与预算的唯一实现**
 *      产出：ProactiveDecision（speak / wait / silent）
 *      禁止：读原始消息文本、调用 LLM、做任何语义判断
 * ```
 *
 * ## 为什么「取第一个」必须在否决层（本文件最重要的一条）
 *
 * 「多个场景同时命中时取第一个」是**策略**：它是资源分配（把有限的发言机会
 * 给谁），不是语义判断。如果把它写进 prompt（"只输出 order 最小的那个"），
 * 就再也无法做到：
 *   - 用回放数据**离线对比不同顺序**的效果（prompt 里的顺序无法被参数化）；
 *   - 把「按场景置信度加权的分位数预算」这种机制接进来（那是阈值计算）；
 *   - 单测「同时命中多个场景时谁赢」——只能靠真实 LLM 输出碰运气。
 *
 * 所以：**LLM 只回答"每个场景成立不成立"，谁赢由 `veto.ts` 的代码算**。
 * 这也是三层拆分带来的最大收益（见 docs/PROACTIVE-INTERVENTION-ARCH.md §4.2）。
 */

import type { ConversationTarget } from '../../core/connector.js';

// ---------------------------------------------------------------------------
// 场景标识
// ---------------------------------------------------------------------------

export type SceneId = 'scene-1' | 'scene-2' | 'scene-3' | 'scene-4' | 'scene-5';

/**
 * 场景顺序（越小越优先）——**建议值，已由维护者拍板**：
 * 4 指代 → 1 续聊追问 → 3 无人应答 → 2 持续讨论 → 5 兴趣 / 性格。
 *
 * 唯一来源：prompt 渲染、候选权重、否决层裁决、trace 都读它。
 */
export const SCENE_ORDER: readonly SceneId[] = [
  'scene-4',
  'scene-1',
  'scene-3',
  'scene-2',
  'scene-5',
];

/** 场景 id → 优先级序号（越小越优先）。未知 id 返回列表长度（永远排最后）。 */
export function sceneOrder(id: SceneId): number {
  const index = SCENE_ORDER.indexOf(id);
  return index < 0 ? SCENE_ORDER.length : index;
}

/** 按全局顺序排列场景 id。 */
export function sortSceneIds(ids: readonly SceneId[]): SceneId[] {
  return [...ids].sort((left, right) => sceneOrder(left) - sceneOrder(right));
}

// ---------------------------------------------------------------------------
// 触发平面
// ---------------------------------------------------------------------------

/**
 * 一次评估的触发来源。场景通过 `triggers` 声明自己在哪些来源下参与，
 * 于是「时机」不是散落在 runner 里的 if 语句。
 *
 * - `message`        一条旁听消息到达（场景 1、4）
 * - `question-probe` 问题台账探针到期（场景 3；T1=90s / T2=10min）
 * - `topic-roll`     话题滚动收敛点（场景 2、5；每 N 条或 M 分钟）
 * - `wait-wakeup`    wait 票据到期重查（场景 3；与探针**分开**，见 docs/WAIT-CONVERGENCE-REQUIREMENT.md）
 * - `speak-followup` bot 刚发过言，接续对它的回应（可选的收紧通道）
 */
export type SceneTrigger =
  | 'message'
  | 'question-probe'
  | 'topic-roll'
  | 'wait-wakeup'
  | 'speak-followup';

// ---------------------------------------------------------------------------
// 话题 session：主动发言的**唯一放行闸门**（见 docs/TOPIC-SESSION-REQUIREMENT.md）
// ---------------------------------------------------------------------------

/**
 * 一个**话题 session**：LLM 判"值得聊"时开一次，之后只数预算。
 *
 * 三个字段就是全部状态——这是本机制的**唯一目的**：把上一版"5 个本地信号 +
 * 锚点 + 台账交互"塌缩成三个字段。刻意**没有** `topicChange` 字段、没有话题指纹、
 * 没有跨会话共享：话题是 LLM 之后才明确的东西，用本地启发式去划分它只会得到
 * 假精确（与架构文档 §3.1 拒绝"话题聚簇"的理由同源）。
 *
 * ## 生命周期：开与关**都由话题驱动**，预算只决定"还能不能开口"
 *
 * 这是维护者拍过板的一条硬口径（`session 不应该被预算驱动，它的驱动动机应该
 * 只是话题`）：
 *
 *   - `budgetLeft` 减到 0 **不关闭 session**：这个话题的会话仍然开着，只是
 *     闸门不再放行（`silent('budget-exhausted')`）。预算因此是"这个话题还能说
 *     几句"的账，不是会话的寿命；
 *   - 关闭只有三种**话题级/时间级**的原因：模型说这个话题收口了（`llm-closed`）、
 *     模型说换话题了（`topic-changed`，见 `SessionDirective`）、或者静默超时
 *     （`idle`，本项目的"话题翻篇"口径）；会话状态被清理时连带关闭
 *     （`conversation-gone`）。
 *
 * 存放位置：`ConversationState` 上，**每会话最多一个**（与既有"一会话一状态"一致）。
 */
export interface TopicSession {
  /** LLM 判定"值得聊"的那一刻（也是 idle 计时的兜底锚点） */
  readonly openedAt: number;
  /**
   * 这个话题还能主动说几句（= `sessionBudget`；每说一句减 1，减到 0 就闭嘴）。
   *
   * ⚠️ 减到 0 **不关闭 session**：它进入"已耗尽"状态——闸门不再放行，直到模型
   * 说这个话题收口（`close`）、说换话题了（`new-topic`），或者静默到 `idle`。
   */
  readonly budgetLeft: number;
  /** 最近一次在**这个 session 里**发言的时间（最小间隔 `sessionMinGapMs` 的锚点） */
  readonly lastSpokeAt?: number;
}

/** session 的四种关闭原因（**穷举**；每次关闭只记一个，见需求验收 11 的账目闭合）。 */
export type SessionCloseCause =
  /** LLM：判定说这个话题收口了（`session:'close'`） */
  | 'llm-closed'
  /** LLM：判定说换话题了（`session:'new-topic'`）——旧会话为**新话题**让位 */
  | 'topic-changed'
  /** 代码：距 `lastSpokeAt`（无则 `openedAt`）超过 `sessionIdleMs` */
  | 'idle'
  /** 代码：会话状态被清理时连带关闭（当前运行期没有淘汰路径，留给将来的收口） */
  | 'conversation-gone';

export const SESSION_CLOSE_CAUSES: readonly SessionCloseCause[] = [
  'llm-closed',
  'topic-changed',
  'idle',
  'conversation-gone',
];

/** 一次 session 关闭的通知载荷（调度层据此记 `proactiveSessionClosedBy{reason}`）。 */
export interface SessionClosedEvent {
  readonly cause: SessionCloseCause;
  /** 关闭时的 session 快照（用于算"这个 session 里说了几句"） */
  readonly session: TopicSession;
}

/**
 * LLM 对"**当前这个话题的 session 该怎么办**"的回答（判定输出的唯一新增字段）。
 *
 * 三态而不是两态，是因为"关掉旧的"与"为现在这个话题开一个新的"是两件不同的事
 * ——而后者是**预算用尽之后唯一的重启正门**（维护者口径：session 不该被预算驱动，
 * 它的驱动动机只能是话题）。两态时这两件事被挤进同一个 `close` 里，只能靠
 * "关掉之后下一次唤醒再开"来近似，于是"预算一重置就能接着说"，预算形同虚设。
 *
 * | 值 | 模型想说的 | 代码做什么 |
 * |---|---|---|
 * | `keep-open` | 还是刚才那个话题，会话该继续 | 没有 session 就开一个；已有就继续用（**已耗尽时仍然闭嘴**） |
 * | `close` | 刚才那个话题收口了 | 关掉会话（`llm-closed`）；本次该说的那句照样说（验收 5） |
 * | `new-topic` | 已经换到另一个话题了 | 关掉旧会话（`topic-changed`）并为**新话题**开一个（预算重置） |
 *
 * 只在本次判定有场景成立（要发言）时才有意义；`close` 也允许与 `satisfied:false`
 * 同时出现——"该收口了"与"这次没什么可补"是两个维度。
 */
export type SessionDirective = 'keep-open' | 'close' | 'new-topic';

export const SESSION_DIRECTIVES: readonly SessionDirective[] = [
  'keep-open',
  'close',
  'new-topic',
];

/** 是否是一个合法的 session 指令（解析模型输出时用它挡掉幻觉值）。 */
export function isSessionDirective(value: unknown): value is SessionDirective {
  return typeof value === 'string' && (SESSION_DIRECTIVES as readonly string[]).includes(value);
}

/**
 * 把逐场景判定里的 `session` 字段**聚合成会话级的一个结论**（唯一实现，
 * 否决层与调度层共用它，避免"闸门放行了、调度层却不认"这种只在冲突输出下显形的分裂）。
 *
 * 冲突时的优先级：`new-topic` > `close` > `keep-open`。
 *
 * - `new-topic` 最优先：它是**话题边界**这一更强的事实声明。把它限定成"必须所有
 *   判定一致"会让这个能力在实际输出里几乎不可达，而它是预算重启的唯一正门；
 *   放宽的风险由**代码侧**兜住——最小间隔（`sessionMinGapMs`）照样要过，
 *   硬限流也照样先在前面拦（上限活在模型之下）。
 * - `close` 次之：模型在任一条判定里说"收口了"，就按收口处理（保守一侧）。
 *
 * `keep-open` 是没有任何一个判定说别的时的默认值——即**多数情况下的常态**。
 */
export function aggregateSessionDirective(verdicts: readonly SceneVerdict[]): {
  /** 模型明确说换话题了（预算重启的唯一正门） */
  readonly restart: boolean;
  /** 模型明确说这个话题收口了 */
  readonly close: boolean;
} {
  const restart = verdicts.some((verdict) => verdict.session === 'new-topic');
  const close = !restart && verdicts.some((verdict) => verdict.session === 'close');
  return { restart, close };
}

/** `sessionBudget` 的硬上限：配得再大也按它处理（防止"预算"变成刷屏许可）。 */
export const MAX_SESSION_BUDGET_CAP = 5;

/** `sessionBudget` 的内置默认：**一个 session 里最多主动说两句**。 */
export const DEFAULT_SESSION_BUDGET = 2;

/** `sessionIdleMs`（静默关闭 session）的合法范围与默认值：默认 10 分钟，与活动窗口同值。 */
export const SESSION_IDLE_MS_MIN = 60_000;
export const SESSION_IDLE_MS_MAX = 3_600_000;
export const DEFAULT_SESSION_IDLE_MS = 600_000;

/** `sessionMinGapMs`（同一 session 内两次发言的最小间隔）的范围与默认值。 */
export const SESSION_MIN_GAP_MS_MIN = 10_000;
export const SESSION_MIN_GAP_MS_MAX = 300_000;
export const DEFAULT_SESSION_MIN_GAP_MS = 45_000;

/** 把任意配置值收敛成**生效的** session 预算（至少 1，硬上限 5）。 */
export function effectiveSessionBudget(configured: number): number {
  if (!Number.isFinite(configured)) return DEFAULT_SESSION_BUDGET;
  return Math.min(Math.max(1, Math.trunc(configured)), MAX_SESSION_BUDGET_CAP);
}

/** 把任意配置值收敛成**生效的**静默关闭时长（毫秒）。 */
export function effectiveSessionIdleMs(configured: number): number {
  if (!Number.isFinite(configured)) return DEFAULT_SESSION_IDLE_MS;
  return Math.min(Math.max(SESSION_IDLE_MS_MIN, Math.trunc(configured)), SESSION_IDLE_MS_MAX);
}

/** 把任意配置值收敛成**生效的**最小发言间隔（毫秒）。 */
export function effectiveSessionMinGapMs(configured: number): number {
  if (!Number.isFinite(configured)) return DEFAULT_SESSION_MIN_GAP_MS;
  return Math.min(
    Math.max(SESSION_MIN_GAP_MS_MIN, Math.trunc(configured)),
    SESSION_MIN_GAP_MS_MAX,
  );
}

// ---------------------------------------------------------------------------
// ① 搜集层
// ---------------------------------------------------------------------------

/**
 * 一次评估的**客观事实**（全部来自本地状态，零 LLM 成本）。
 *
 * 它同时喂给两层：场景预筛读它判断"这个场景有没有可能成立"，
 * prompt 渲染读它生成"结构化事实"块（让 LLM 不必从转录里数数）。
 */
export interface SceneEvidence {
  readonly convKey: string;
  readonly trigger: SceneTrigger;
  readonly now: number;
  /** 本轮消息（探针/滚动触发时可能没有消息） */
  readonly message?: {
    readonly msgId?: string;
    readonly senderId?: string;
    readonly senderName?: string;
    readonly text: string;
    /** 平台提供的「@ 了 bot」标记 */
    readonly atSelf?: boolean;
  };
  /** bot 在本群的别名（指代场景用；配置注入） */
  readonly botAliases: readonly string[];
  /** bot 最近一次在本群发言的时间 */
  readonly lastBotSpeakAt?: number;
  /** bot 是否仍是某活跃话题的参与方（话题口径，不是纯时间口径） */
  readonly inBotTopicWindow: boolean;
  readonly topic?: {
    readonly id: string;
    readonly startedAt: number;
    readonly lastAt: number;
    readonly humanParticipants: number;
    readonly botSpeaks: number;
  };
  /** 旁听窗口内的消息条数 / 人头数（场景 2 的活跃度） */
  readonly recentMessageCount: number;
  readonly recentHumanCount: number;
  /** 问题台账里仍挂起的问题数（场景 3） */
  readonly pendingQuestionCount: number;
  /**
   * 仍挂起的问题清单（结构化事实 + **对象引用**的来源）。
   *
   * 为什么必须进 evidence：模型要给 `yielding` 就得说清"在等的是哪一个问题"，
   * 而"引用一个对象"要求那个对象在 prompt 里有稳定的名字。旧实现没有它，
   * 于是重查时"等的是谁"已经完全丢失（`question-probe` 标签下的候选集
   * 只剩场景 3，与原来的等待对象毫无关系）。
   */
  readonly pendingQuestions: readonly PendingQuestionFact[];
  /**
   * 本次评估是"让路后到期重查"时，带上被唤醒的那个对象。
   * 判定 prompt 据此告诉模型"你上轮说有人在答，现在过了 N 秒"。
   */
  readonly waitWakeup?: {
    readonly targetId: string;
    /** 从"让路"那一刻到本次唤醒经过了多久（毫秒） */
    readonly yieldedForMs: number;
  };
  /**
   * 当前**开启中**的话题 session（没有则省略）。
   *
   * 为什么它必须进证据：判定层新增了"说完这句，这个话题还要不要继续跟"
   * （`session: 'keep-open' | 'close'`），而模型要回答它就得知道"我已经在这个
   * 话题里说过几句、预算还剩几句"——否则它只能靠转录里数，那是幻觉来源。
   */
  readonly session?: TopicSession;
  /** 命中的兴趣池条目 id（场景 5；空数组 = 无候选） */
  readonly matchedInterestIds: readonly string[];
  /** 连续「介入后无人回应」的次数（任何用户发言归零） */
  readonly unansweredStreak: number;
  /**
   * 近窗消息的**回放统计**：每个场景的"命中 × speak"历史频率。
   * 缺省表示没有数据——此时分位数预算退化为固定顺序（见 veto.ts）。
   */
  readonly sceneRates?: Readonly<Partial<Record<SceneId, number>>>;
}

/** 本地预筛命中：只带证据与置信度，场景 id 由注册表绑定。 */
export interface SceneHit {
  confidence: number;
  evidence?: string;
}

/**
 * 一条挂起问题在**结构化事实块**里的样子（判定 prompt 只读这个，不读台账对象）。
 *
 * `id` 是模型唯一被允许用来引用对象的名字；`askerLabel` / `silentSeconds` /
 * `probes` 是给模型判断"够不够久了"的事实，不需要它从转录里数。
 */
export interface PendingQuestionFact {
  readonly id: string;
  readonly askerLabel: string;
  readonly text: string;
  readonly silentSeconds: number;
  readonly probes: number;
}

export interface ScenePrecheckContext extends SceneEvidence {
  readonly scene: SceneId;
}

/** 一个场景的静态描述（搜集层的注册表条目）。 */
export interface SceneDefinition {
  readonly id: SceneId;
  readonly name: string;
  /** 在哪些触发来源下参与（弱信号场景只绑 topic-roll） */
  readonly triggers: readonly SceneTrigger[];
  /** 本地预筛：纯函数；返回 undefined = 本次不参与，**不得否决别人** */
  readonly precheck?: (ctx: ScenePrecheckContext) => SceneHit | undefined;
}

/** 搜集层交给 LLM 层的候选：一个场景 + 它被本地看到的证据 + 估算权重。 */
export interface SceneCandidate {
  readonly scene: SceneId;
  /** 本地置信度（0..1）；LLM 可以推翻它 */
  readonly localConfidence: number;
  /** 本地证据（渲染进 prompt 的结构化事实块） */
  readonly evidence?: string;
  /**
   * 估算命中率：用于否决层的分位数预算。优先取 `sceneRates`（回放统计），
   * 没有数据时退化为本地置信度。**只影响预算排序，不影响语义成立与否。**
   */
  readonly expectedRate: number;
}

// ---------------------------------------------------------------------------
// ② LLM 层
// ---------------------------------------------------------------------------

/**
 * 模型说"先别说"的**理由**——三态，取代原来的布尔 `suggestsWait`。
 *
 * 为什么必须是三态：一个布尔值同时表达了三件**时间尺度完全不同**的事，
 * 于是被实现成了一个独立于任何对象的新调度机制（`wait` 占比 46%、产出为零，
 * 见 docs/WAIT-CONVERGENCE-REQUIREMENT.md）。拆开之后：
 *
 * | 理由 | 模型想说的 | 谁负责下次唤醒 | 是否建票据 |
 * |---|---|---|---|
 * | `yielding`  | 有人在答（正在打字、刚接话） | 本机制：`waitYieldMs` 后 | **是** |
 * | `not-yet`   | 还没到时候（问题太新、话题刚起） | 已有的 90 秒问题探针 / 话题滚动 | 否 |
 * | `watching`  | 刚说完，看反应 | 不排唤醒；由下一条人类消息自然唤醒 | 否 |
 */
export type WaitReason = 'yielding' | 'not-yet' | 'watching';

export const WAIT_REASONS: readonly WaitReason[] = ['yielding', 'not-yet', 'watching'];

/** 票据的四种终局。**每张票据只有一个终局**（账目闭合：resolved+spent+stale+unchanged == created）。 */
export type WaitTicketTerminal =
  /** 唤醒时对象仍挂起、模型判成立 → 等待熬到了成立 */
  | 'resolved'
  /** 唤醒后重新判定，任何结果都消耗票据（又让路 / 给别的理由 / 判不成立） */
  | 'spent'
  /** 唤醒时对象已关闭，或关闭时被就地取消（问题被答 / 过期 / 话题翻篇） */
  | 'stale'
  /** 唤醒时转录自上次判定以来无新增 → 不花 LLM */
  | 'unchanged';

/** 是否是一个合法的三态理由（解析模型输出时用它挡掉幻觉值）。 */
export function isWaitReason(value: unknown): value is WaitReason {
  return typeof value === 'string' && (WAIT_REASONS as readonly string[]).includes(value);
}

/**
 * LLM 对**单个**场景的语义判定。
 *
 * 刻意是"逐场景多标签"而不是"五选一 + 是否发言"：把选择权留在代码里，
 * 模型只回答它能回答的问题（这个场景成不成立）。
 */
export interface SceneVerdict {
  readonly scene: SceneId;
  readonly satisfied: boolean;
  /** 0..1；**用于预算与排序，不用于放行**（放行与否决在 veto 层） */
  readonly confidence: number;
  readonly reason: string;
  /** 事实性纠错时的被纠错原文片段 / 场景 3 的问题原文 */
  readonly evidence?: string;
  /** 交给介入 turn 的「该说什么」要点 */
  readonly directive?: string;
  /**
   * 模型自己说"现在不该说，但等一下"——三态理由，见 `WaitReason`。
   *
   * 只有 LLM 能提这个建议（它才知道话题是不是正在展开），
   * 但**是否真的 defer、以及 defer 多久，由否决层与调度层决定**。
   */
  readonly waitReason?: WaitReason;
  /**
   * 模型对"当前这个话题的 session 该怎么办"的回答（本次需求唯一新增的字段）。
   *
   * 三态语义、冲突时的聚合规则、以及"为什么 `new-topic` 是预算重启的唯一正门"，
   * 见 `SessionDirective` 与 `aggregateSessionDirective`。**是否真的开/关仍由代码
   * 决定**——预算是代码里的硬闸门，模型只有建议权。
   */
  readonly session?: SessionDirective;
  /**
   * 旧版布尔位，**仅为兼容存量回放数据而保留**（等价于 `waitReason:'yielding'`）。
   * 判据正文与 JSON 契约都已经改成三态，解析器不再产出它。
   */
  readonly suggestsWait?: boolean;
}

// ---------------------------------------------------------------------------
// ③ 否决层
// ---------------------------------------------------------------------------

/** 被否决的原因（有序：数组顺序即排查顺序）。 */
export type VetoReason =
  /** 没有场景成立（LLM 全判不成立），而当时**也没有**开启中的 session */
  | 'no-session'
  /**
   * 本话题的发言预算已经用尽（`budgetLeft <= 0`）。
   *
   * 这是闸门的**主路径之一**，不是防御性分支：预算耗尽**不关闭** session
   * （维护者口径：session 不该被预算驱动），所以后续唤醒会一次次落在这里，
   * 直到模型说这个话题收口（`close`）、说换话题了（`new-topic`，唯一的重启正门）
   * 或者静默到 `idle`。
   */
  | 'budget-exhausted'
  /** 同一 session 内距上次发言不足 `sessionMinGapMs`（不消耗预算） */
  | 'min-gap'
  /** 没有场景成立（LLM 全判不成立） */
  | 'no-scene'
  /** 本地预筛没给出任何候选（连问都不用问 LLM） */
  | 'no-candidate'
  /** 「没人理我就停」保险 */
  | 'no-response'
  /** 分位数预算 / 顺序预算拒绝（低优场景被高优占满） */
  | 'budget'
  /** 硬限流（10 分钟 3 次 / 1 小时 8 次） */
  | 'rate-limit'
  /** 该挂起问题的"让路"预算已用尽（`maxWaitPerItem`，含唤醒后的那一次） */
  | 'wait-spent'
  /** 模型想等，但按下的理由不排唤醒 / 理由无效（`not-yet` / `watching` / 无目标） */
  | 'wait-declined';

export const VETO_REASON_ORDER: readonly VetoReason[] = [
  'no-candidate',
  'no-scene',
  'no-session',
  'no-response',
  'rate-limit',
  'budget-exhausted',
  'min-gap',
  'budget',
  'wait-spent',
  'wait-declined',
];

/**
 * wait 票据要挂在的**对象**（本轮只支持"一个挂起问题"这一类）。
 *
 * 由调用方从台账组装成**结构化事实**传进来——否决层依然不读原始文本、
 * 不碰状态，只按这张表做决定，因此仍然可以完全用单测穷举。
 *
 * 这是本机制最重要的一个改变：等待**从会话级收窄为条目级**。
 * 旧实现的重查触发标签固定写成 `question-probe`，于是"等的是谁"在重查时
 * 已经丢了——不绑定对象的等待等于在问一个已经被换掉的问题。
 */
export interface WaitTarget {
  /** 挂起问题 id（`<msgId>@<ts>`，由台账生成并原样回给模型） */
  readonly id: string;
  /**
   * 台账里**有没有**这个 id。
   *
   * 必须与 `open` 分开，否则两件必须被分开计数的事会混成一件：
   * 模型幻觉出一个不存在的 id（`wait_ticket_invalid_target`，
   * 说明判据描述需要更明确）与"对象曾存在但已关闭"（`stale`，是**好事**，
   * 说明本地检查省下了一次调用）在只看"当前挂起清单"时长得一模一样。
   */
  readonly exists: boolean;
  /** 该问题是否**仍挂起**（已答 / 过期 / 话题翻篇后为 false） */
  readonly open: boolean;
  /** 该问题已经让路几次（与 `maxWaitPerItem` 比，判断预算是否用尽） */
  readonly yieldBudgetUsed: number;
}

/** 否决层看到的上下文：**结构化的**额度与顺序，没有原始文本。 */
export interface VetoContext {
  readonly now: number;
  /** 该会话在硬限流窗口内的主动发言次数 */
  readonly spokeCount10Min: number;
  readonly spokeCount1Hour: number;
  /**
   * 当前**开启中的**话题 session（`undefined` = 没有）。
   *
   * 它是本层的**唯一放行闸门**：闸门的位置就是原来"每话题一次"那一行的位置
   * （顺序 → 硬限流 → session 闸门 → 顺序/分位数预算）。四类不过见
   * `VetoReason` 的 `no-session` / `budget-exhausted` / `min-gap`，
   * 以及不进本层的 `no-new-content`（转录未增长，在调度层就短路了）。
   */
  readonly session?: TopicSession;
  /**
   * wait 的对象状态（模型引用的那个挂起问题）。
   * `undefined` = 模型没有给出对象引用，或引用的 id 在台账里不存在。
   */
  readonly wait?: WaitTarget;
  /** 场景顺序覆盖（缺省用 `SCENE_ORDER`；用于 A/B 与回放对比） */
  readonly order?: readonly SceneId[];
}

export interface VetoPolicy {
  /** 「没人理我就停」上限 */
  readonly maxUnansweredStreak: number;
  readonly maxPer10Min: number;
  readonly maxPerHour: number;
  /**
   * 同一 session 内两次发言的**最小间隔**（毫秒，默认 45000）。
   *
   * 它是 session 闸门的三道检查之一。放在这一层是因为"顺序与额度的唯一实现"
   * 在这儿：闸门过不过必须能被单测穷举，而不是散在 runner 的 if 里。
   * （session 的**初始预算**不在这里：它由调度层在"开 session"时写入状态，
   * 否决层只读 `context.session.budgetLeft`。）
   */
  readonly sessionMinGapMs: number;
  /** 是否启用按场景置信度加权的分位数预算（默认关：先用固定顺序，见 S4） */
  readonly quantileBudget: boolean;
  /** 每个窗口期望的发言次数（分位数预算的目标） */
  readonly targetRate: number;
  /**
   * 每个挂起问题最多"让路"几次（默认 1）。
   *
   * 上限**必须活在这一层**（模型之下），不能写在 prompt 里当请求——
   * "让路只能让一次"是代码里的硬约束，模型无法用理由绕过它。
   */
  readonly maxWaitPerItem: number;
}

export const DEFAULT_VETO_POLICY: VetoPolicy = {
  maxUnansweredStreak: 2,
  maxPer10Min: 3,
  maxPerHour: 8,
  sessionMinGapMs: DEFAULT_SESSION_MIN_GAP_MS,
  quantileBudget: false,
  targetRate: 1.5,
  maxWaitPerItem: 1,
};

/** `maxWaitPerItem` 的硬上限：配得再大也按它处理（防止"把收敛改回不收敛"）。 */
export const MAX_WAIT_PER_ITEM_CAP = 3;

/** `maxWaitPerItem` 的内置默认：**让路只能让一次**。 */
export const DEFAULT_MAX_WAIT_PER_ITEM = 1;

/** `waitYieldMs`（"让路"等待时长）的合法范围与默认值：默认不超过 45 秒。 */
export const WAIT_YIELD_MS_MIN = 15_000;
export const WAIT_YIELD_MS_MAX = 120_000;
export const DEFAULT_WAIT_YIELD_MS = 45_000;

/** 把任意配置值收敛成**生效的**让路预算（硬上限之下，至少 1 次也不超过硬上限）。 */
export function effectiveMaxWaitPerItem(configured: number): number {
  if (!Number.isFinite(configured)) return DEFAULT_MAX_WAIT_PER_ITEM;
  return Math.min(Math.max(1, Math.trunc(configured)), MAX_WAIT_PER_ITEM_CAP);
}

/** 把任意配置值收敛成**生效的**让路时长（毫秒）。 */
export function effectiveWaitYieldMs(configured: number): number {
  if (!Number.isFinite(configured)) return DEFAULT_WAIT_YIELD_MS;
  return Math.min(Math.max(WAIT_YIELD_MS_MIN, Math.trunc(configured)), WAIT_YIELD_MS_MAX);
}

/** 否决层的终局：唯一会产生副作用（发言 / 排定时器）的东西。 */
export type ProactiveDecision =
  | {
      readonly action: 'speak';
      readonly scene: SceneId;
      readonly confidence: number;
      readonly reason: string;
      readonly evidence?: string;
      readonly directive?: string;
      /** 同时成立但被顺序/预算压下去的场景（进 trace，用于调序） */
      readonly alsoMatched: readonly SceneId[];
    }
  | {
      readonly action: 'wait';
      /** 让路的理由（目前只有 `yielding` 会走到这里） */
      readonly reason: WaitReason;
      /**
       * 票据挂载的**对象** id——调度层据此建票据、并在对象关闭时取消唤醒。
       * 走到这里必然是有效引用（无效引用在否决层就已经 silent 了）。
       */
      readonly targetId: string;
    }
  | { readonly action: 'silent'; readonly reason: VetoReason; readonly detail?: string };

/** 是否放行（给调用方省一个判断）。 */
export function isSpeak(decision: ProactiveDecision): boolean {
  return decision.action === 'speak';
}

// ---------------------------------------------------------------------------
// ④ 发言生成（compose）接缝
// ---------------------------------------------------------------------------

/**
 * 交给「发言生成」的输入：判定层的产出（要点 / 依据 / 场景），
 * 由一次真实的 agent turn 措辞成**可以直接发出去的话**。
 *
 * 为什么有这一层：判定层的 `directive` 是"该说什么"的**要点**（面向执行者的
 * 指令语气），不是能对群说的话。早期实现把它原样发送，群里看到的就是
 * "直接回答 xx 的可行性要点（依据：…）"这种元文本。措辞必须走与被动回复
 * 同一条 agent turn（`TurnRunner.runProactiveTurn`）：同一 runtime 会话
 * （人设与上下文连续）、同一观察窗口、可以用工具查证了再开口。
 *
 * 返回 `undefined` 的语义是"本次不发言"——会话忙 / 生成超时 / 模型看完
 * 完整上下文后选择不说，都走这里。调用方按投递降级记账（`compose-failed`），
 * **不消耗会话预算、不开 session**（没说出话就不记账，与投递降级同口径）。
 */
export interface ProactiveComposeInput {
  readonly target: ConversationTarget;
  readonly scene: SceneId;
  /** 判定给的「该说什么」要点（`directive ?? reason`） */
  readonly directive: string;
  /** 判定的可读理由（进日志与生成提示） */
  readonly reason: string;
  /** 判定给的证据（场景 3 的问题原文 / 纠错的原文片段） */
  readonly evidence?: string;
}

/** 发言生成能力（真实实现走 TurnRunner；测试注入 fake）。 */
export type ProactiveCompose = (input: ProactiveComposeInput) => Promise<string | undefined>;
