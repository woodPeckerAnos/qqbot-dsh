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
 *      产出：ProactiveDecision（speak / wait / defer-to-scene / silent）
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
 * - `speak-followup` bot 刚发过言，接续对它的回应（可选的收紧通道）
 */
export type SceneTrigger = 'message' | 'question-probe' | 'topic-roll' | 'speak-followup';

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
   * 模型自己说"现在不该说，但等一会值得再看"。
   * 只有 LLM 能提这个建议（它才知道话题是不是正在展开），
   * 但**是否真的 defer 由否决层决定**（预算/限流可以说"不，直接放弃"）。
   */
  readonly suggestsWait?: boolean;
}

// ---------------------------------------------------------------------------
// ③ 否决层
// ---------------------------------------------------------------------------

/** 被否决的原因（有序：数组顺序即排查顺序）。 */
export type VetoReason =
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
  /** 同一话题已介入过 */
  | 'topic-spent'
  /** 采纳 LLM 的 wait 建议，但推迟次数已用尽 */
  | 'wait-exhausted';

export const VETO_REASON_ORDER: readonly VetoReason[] = [
  'no-candidate',
  'no-scene',
  'no-response',
  'rate-limit',
  'topic-spent',
  'budget',
  'wait-exhausted',
];

/** 否决层看到的上下文：**结构化的**额度与顺序，没有原始文本。 */
export interface VetoContext {
  readonly now: number;
  /** 该会话在硬限流窗口内的主动发言次数 */
  readonly spokeCount10Min: number;
  readonly spokeCount1Hour: number;
  /** 该话题已被介入的次数（话题记账） */
  readonly topicBotSpeaks: number;
  /** 本次评估是第几次 wait 重查（0 = 首查） */
  readonly waitRetries: number;
  /** 场景顺序覆盖（缺省用 `SCENE_ORDER`；用于 A/B 与回放对比） */
  readonly order?: readonly SceneId[];
}

export interface VetoPolicy {
  /** 「没人理我就停」上限 */
  readonly maxUnansweredStreak: number;
  readonly maxPer10Min: number;
  readonly maxPerHour: number;
  /** 同一话题允许的主动介入次数（默认 1） */
  readonly maxPerTopic: number;
  /** 是否启用按场景置信度加权的分位数预算（默认关：先用固定顺序，见 S4） */
  readonly quantileBudget: boolean;
  /** 每个窗口期望的发言次数（分位数预算的目标） */
  readonly targetRate: number;
  /** wait 建议最多被采纳几次 */
  readonly maxWaitRetries: number;
}

export const DEFAULT_VETO_POLICY: VetoPolicy = {
  maxUnansweredStreak: 2,
  maxPer10Min: 3,
  maxPerHour: 8,
  maxPerTopic: 1,
  quantileBudget: false,
  targetRate: 1.5,
  maxWaitRetries: 1,
};

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
  | { readonly action: 'wait'; readonly scene: SceneId; readonly delayMs: number; readonly reason: string }
  | { readonly action: 'silent'; readonly reason: VetoReason; readonly detail?: string };

/** 是否放行（给调用方省一个判断）。 */
export function isSpeak(decision: ProactiveDecision): boolean {
  return decision.action === 'speak';
}
