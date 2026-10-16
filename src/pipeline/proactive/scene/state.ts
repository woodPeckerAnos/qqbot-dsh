/**
 * ① 搜集层的**会话状态**：旁听缓冲 + 未答问题台账 + 无人回应计数 + bot 参与窗口
 * + **话题 session**（主动发言的唯一放行闸门）。
 *
 * 存在的理由：`SceneEvidence` 的字段必须**有生产者**。在此之前
 * `topic` / `inBotTopicWindow` / `recentMessageCount` / `recentHumanCount` /
 * `pendingQuestionCount` / `unansweredStreak` 全靠调用方手填——实际结果永远是
 * 默认值，场景 1/2/3/5 因此结构性不可能触发（且没有任何报错）。
 *
 * ## 这一版刻意**不**做的事（避免假装精确）
 *
 * - **不做话题聚簇**：话题指纹/相似度聚类需要真实群聊语料定标，
 *   草率实现只会给出"看起来有话题 id、实际随机"的假精确。取而代之的是
 *   **活动窗口**（`activityWindowMs` 内有新消息即视为话题仍在延续），
 *   并在 `SceneEvidence.topic` 里用 `topic:<起始时间戳>` 这种**诚实的合成 id**。
 * - **不做逐话题预算**：话题是 LLM 之后才明确的东西，本地记不准。放行额度由
 *   **话题 session**（`TopicSession`，LLM 开一次、之后只数预算）承担，
 *   见 docs/TOPIC-SESSION-REQUIREMENT.md；本层只如实记录那个 session 的三字段。
 * - **不做持久化**：状态全在内存，进程重启即清空（与旁听内容的隐私口径一致，
 *   见架构方案 §9 风险表）。要持久化是另一件事，需要单独评估留存期限。
 *   session 同理：**不落盘**，重启即重新由 LLM 决定要不要开。
 *
 * ## 三个计数器的语义（都有单测）
 *
 * | 计数器 | 何时 +1 | 何时归零 |
 * |---|---|---|
 * | `unansweredStreak` | bot 发言后（由 `watcher` 调 `recordBotSpoke`） | 任何**人类**消息到达 |
 * | `botSpeaksInWindow` | 同上 | 活动窗口过期（无新消息） |
 * | 未答问题 | 检测到疑问句时登记 | 被答/超时/被自己撤回 |
 */

import type { NormalizedMessage } from '../../../core/connector.js';
import type { SessionCloseCause, SessionClosedEvent, TopicSession } from '../contract.js';

// ---------------------------------------------------------------------------
// 数据类型
// ---------------------------------------------------------------------------

/** 旁听缓冲里的一条消息（只保留判定需要的字段，原始事件不留在内存里）。 */
export interface ObservationEntry {
  readonly msgId: string;
  readonly eventId: string;
  readonly senderId: string;
  readonly senderName?: string;
  readonly text: string;
  readonly ts: number;
  /**
   * 这条消息是否**已经把疑问抛给 bot**（@ 了 bot 或接着 bot 的话说）。
   * 由 watcher 在消息进入时判定：用于区分"有人问了但没人答"与"有人问 bot 了"。
   */
  readonly addressed: boolean;
}

/** 未答问题台账的一条。 */
export interface PendingQuestion {
  readonly id: string;
  readonly msgId: string;
  readonly askerId: string;
  readonly askerName?: string;
  readonly text: string;
  readonly topicId: string;
  readonly askedAt: number;
  /** 已经探针过几次（上限由 watcher 与 veto 策略决定） */
  probes: number;
  state: 'open' | 'answered' | 'expired' | 'silenced';
  /**
   * 该问题已经"让路"过几次（与 `VetoPolicy.maxWaitPerItem` 比）。
   *
   * 生命周期与问题本身一致：问题还在台账里就累计，问题关闭即随票据一起作废。
   * 记在**问题这一行**上（而不是会话上）是项目纪律的直接应用：
   * 「状态只按会话/话题/问题/花费窗口记账，永不按场景记账」
   * （架构文档 §3.0），同时把"等待"从会话级收窄为条目级。
   */
  yieldBudgetUsed: number;
  /**
   * 最近一次**真正跑到判定**的时刻（挂起问题版本）。
   *
   * 用途：唤醒前的第二道本地检查——"转录自上次判定以来无新增"就不调 LLM。
   * `undefined` = 还没判定过（此时一律按"有新增"处理，宁可多查一次）。
   */
  lastEvaluatedAt?: number;
}

/** 问题关闭的原因（回调里带出去，供调度层作废票据时记账）。 */
export type QuestionClosedCause = 'answered' | 'expired' | 'window-reset';

/** 台账里一条问题关闭时的通知载荷。 */
export interface QuestionClosedEvent {
  readonly id: string;
  readonly cause: QuestionClosedCause;
}

// ---------------------------------------------------------------------------
// 问题识别（本地、纯函数、宁漏不误报）
// ---------------------------------------------------------------------------

/** 疑问词表（与既有 10-strong-open-question 同族，但这里要求更长的最小长度）。 */
const QUESTION_WORDS = /吗|呢|怎么|为什么|哪|谁|啥|如何|有没有|能否|可否|是不是/;

/** 纯媒体占位（`[图片]` / `[图片: x.jpg]`）：本身不是问题。 */
const PURE_MEDIA_PLACEHOLDER = /^\s*(\[[^\]]{1,32}\]\s*)+$/;

/**
 * 这条消息是不是一个**在问所有人的问题**（场景 3 的入口）。
 *
 * 判据（必须同时满足，宁漏不误报）：
 *   1. 不是纯媒体占位；
 *   2. 不是 `/` 开头的命令（命令是给 bot 的，不是"无人应答"）；
 *   3. 有问号结尾，或含疑问词；
 *   4. 去掉问号后至少 `MIN_QUESTION_CHARS` 个字符——"?"或"在?"这种不算问题，
 *      否则场景 3 会在群里任何一句敷衍话上触发。
 */
export const MIN_QUESTION_CHARS = 4;

export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '' || PURE_MEDIA_PLACEHOLDER.test(trimmed)) return false;
  if (trimmed.startsWith('/')) return false;
  const isQuestion = /[？?]\s*$/.test(trimmed) || QUESTION_WORDS.test(trimmed);
  if (!isQuestion) return false;
  const body = trimmed.replace(/[？?\s]+$/g, '');
  return body.length >= MIN_QUESTION_CHARS;
}

// ---------------------------------------------------------------------------
// 会话状态
// ---------------------------------------------------------------------------

export interface ConversationStateOptions {
  /** 旁听缓冲上限（条）。超出淘汰最旧的——判定只需要近期上下文。 */
  maxEntries?: number;
  /** 每条旁听消息在缓冲里的最长保留时间 */
  maxAgeMs?: number;
  /** 活动窗口：多久没新消息就算"话题翻篇"（bot 参与窗口与计数一并失效） */
  activityWindowMs?: number;
  /** 未答问题台账上限 */
  maxQuestions?: number;
  /** 挂了多久仍无人应答就作废（防止台账把十分钟前的问题一直当"挂起"） */
  questionTtlMs?: number;
}

/** 默认活动窗口（毫秒）：静默这么久就算话题翻篇。watcher 与 veto 上下文共用它。 */
export const DEFAULT_ACTIVITY_WINDOW_MS = 10 * 60_000;

export const DEFAULT_STATE_OPTIONS: Required<ConversationStateOptions> = {
  maxEntries: 200,
  maxAgeMs: 30 * 60_000,
  activityWindowMs: DEFAULT_ACTIVITY_WINDOW_MS,
  maxQuestions: 20,
  questionTtlMs: 30 * 60_000,
};

export class ConversationState {
  readonly convKey: string;
  private readonly options: Required<ConversationStateOptions>;
  private readonly buffer: ObservationEntry[] = [];
  private readonly questions = new Map<string, PendingQuestion>();

  /** 最近一次人类发言时间（任何人类消息都刷新） */
  private lastHumanAt?: number;
  /** 最近一次 bot 在本群发言时间 */
  private botLastSpokeAt?: number;
  /** bot 当前活动窗口内的发言次数（窗口过期归零） */
  private botSpeaksInWindow = 0;
  /** 本活动窗口的起始时间（用于合成话题 id） */
  private windowStartedAt?: number;
  /** 连续「bot 发言后无人回应」次数 */
  private unansweredStreakCount = 0;
  /** 本轮活动窗口内出现过的人类发言者（不含 bot） */
  private readonly participants = new Map<string, number>();
  /**
   * 当前开启中的**话题 session**（每会话最多一个）。
   *
   * 字段刻意只有三个（`openedAt` / `budgetLeft` / `lastSpokeAt`）：这是本机制
   * 存在的意义——把上一版"5 个本地信号 + 锚点 + 台账交互"塌缩成三个字段。
   *
   * 类型与 `TopicSession` 同构（那份是 readonly 的**对外视图**，这里是可变实现）。
   */
  private topicSession?: { openedAt: number; budgetLeft: number; lastSpokeAt?: number };
  /**
   * 该会话**上次进入判定**的时刻（会话级字段，见 docs/TOPIC-SESSION-REQUIREMENT.md §三）。
   *
   * 用途只有一个：唯一的本地闸——"转录自上次评估以来没有新增 → 不调 LLM"，
   * 杜绝"群里完全安静时每 30 秒问一次同样的问题"。
   *
   * ⚠️ 与问题级的 `PendingQuestion.lastEvaluatedAt` **不是同一个东西**：
   * 那是"某个挂起问题上次被重判"的时刻（wait 票据的锚点），这是"整个会话上次
   * 进入判定"的时刻。两者都由 `hasNewContentSince()` 这同一份实现来消费。
   */
  private lastEvaluationAt?: number;
  /**
   * 判定那一刻**转录里最后一条**的 eventId（`hasNewContentSinceLastEvaluation`
   * 的**时间粒度兜底**）。
   *
   * 为什么时间戳不够：平台事件时间可能是**秒**（OneBot 转发的是 `time * 1000`，
   * 见 adapters/onebot/normalize.ts），同一秒内到达的新消息其 `ts` 并不大于
   * `lastEvaluationAt`（本机毫秒时钟），只比时间戳会把"刚到的消息"判成"没有新增"。
   * 于是再加一条与时间无关的判据：**转录末尾换人了就说明有新增**。
   */
  private lastEvaluationMarker?: string;
  /**
   * 问题关闭的监听者（调度层用它就地作废票据、取消唤醒）。
   *
   * 为什么用回调而不是让 watcher 自己扫：**问题关闭是本地可判的**，
   * 而"问题一旦关闭，其票据必须立即作废并取消唤醒，而不是等定时器到点再发现"
   * （见 docs/WAIT-CONVERGENCE-REQUIREMENT.md 第五节）。回调让关闭这件事
   * 只有一个出口，watcher 不需要在每条消息上都重扫一遍台账。
   */
  private readonly questionClosedListeners = new Set<(event: QuestionClosedEvent) => void>();
  /**
   * session 关闭的监听者（调度层用它记 `proactiveSessionClosedBy{reason}`、
   * 取消静默定时器）。与问题关闭同构：关闭只有一个出口，账目才对得上
   * （验收 11：`proactiveSessionClosed === Σ proactiveSessionClosedBy{reason}`）。
   */
  private readonly sessionClosedListeners = new Set<(event: SessionClosedEvent) => void>();

  constructor(convKey: string, options: ConversationStateOptions = {}) {
    this.convKey = convKey;
    this.options = { ...DEFAULT_STATE_OPTIONS, ...options };
  }

  // --- 写入 -----------------------------------------------------------------

  /**
   * 记录一条旁听消息。
   *
   * 副作用顺序刻意如此：**先归零无人回应计数**（有人说话了），再入缓冲、
   * 刷新活动窗口、登记可能的问题。任何人类消息都算"群里有人理"。
   */
  observe(message: NormalizedMessage): void {
    const entry: ObservationEntry = {
      msgId: message.msgId,
      eventId: message.eventId,
      senderId: message.senderId,
      ...(message.username !== undefined ? { senderName: message.username } : {}),
      text: message.content,
      ts: Number.isFinite(message.ts) ? message.ts : Date.now(),
      addressed: false,
    };
    this.observeEntry(entry);
  }

  /**
   * 记录一条**已被 @** 的消息（用于转录完整性：场景 1 要看到"bot 回答了谁"）。
   * 它同样算作"话题在延续"，因此也刷新活动窗口与参与人。
   */
  observeEntry(entry: ObservationEntry): void {
    const startsWindow = this.isExpiredAt(entry.ts);
    // 顺序要紧：**先**开窗口（它会清空上一窗口的参与人），**再**把本条消息的
    // 发送者记进去。反过来写会把每个窗口的第一位发言者清掉，于是
    // "有几个人在聊"永远比实际少一个（场景 2 的多人判据因此永远不成立）。
    if (startsWindow) this.startWindow(entry.ts);

    this.buffer.push(entry);
    this.trim(entry.ts);
    this.unansweredStreakCount = 0;
    // 时钟只前进不回退：探针/延迟到达的旧消息不该把窗口整体拉回去
    if (this.lastHumanAt === undefined || entry.ts > this.lastHumanAt) {
      this.lastHumanAt = entry.ts;
    }
    this.participants.set(entry.senderId, entry.ts);
    // 开窗口的那条消息同样可能是问题（"有人问了没人答"的第一现场就是它）
    if (looksLikeQuestion(entry.text)) this.registerQuestion(entry);
  }

  /**
   * bot 在本群发了一条**主动**发言：无人回应计数 +1、话题额度 +1。
   *
   * 语义提醒：计数是"连续几次主动发言之间没有人接话"。用户 @ bot 后的回复
   * **不算**主动发言（那是被叫到的应答），因此不会让计数上涨——否则
   * "没人理我就停"会被一轮正常问答误触发。
   */
  recordBotSpoke(ts: number): void {
    this.botLastSpokeAt = ts;
    this.unansweredStreakCount += 1;
    // 顺序要紧：先数这一句，再考虑要不要开新窗口。反过来写会让
    // "新窗口里的第一句 bot 发言"被 startWindow 的清零吃掉（场景 2/5 的
    // "bot 还没在这个窗口里说过话"预筛因此永远为真，等于这道预筛失效）。
    this.botSpeaksInWindow += 1;
    if (this.windowStartedAt === undefined || this.isExpiredAt(ts)) this.startWindow(ts);
  }

  // --- 话题 session（主动发言的唯一放行闸门） --------------------------------

  /**
   * 当前**开启中**的 session（`undefined` = 没有）。
   *
   * 读它是**只读**语义：否决层据此判"闸门过不过"，判定层据此渲染结构化事实。
   * 关闭后立即返回 `undefined`——"关闭后下次唤醒回到流程 ①"靠的就是这一条。
   */
  get session(): TopicSession | undefined {
    return this.topicSession;
  }

  /**
   * 开一个新 session（LLM 判"值得"、且该次发言真的发出去时调用）。
   *
   * **已有 session 时拒绝覆盖并返回 false**：正常路径下不可能发生（闸门只在
   * 没有 session 时才放行），真发生了说明调用方接线错了——静默覆盖会把上一个
   * session 的预算账吞掉，那是最难查的一类问题。返回 false 由调用方记日志。
   */
  openSession(now: number, budget: number): boolean {
    if (this.topicSession !== undefined) return false;
    this.topicSession = {
      openedAt: now,
      budgetLeft: Math.max(0, Math.trunc(budget)),
    };
    return true;
  }

  /**
   * 在**当前 session 里**说了一句：预算 -1、记下发言时刻。
   *
   * 返回 false = 没有开启中的 session（什么都没做）。**减到 0 不在这里关闭**：
   * 关闭要通知监听者、要区分四种原因，统一走 `closeSession()`
   * （`budgetLeft <= 0` 时由调度层立刻调它，见需求验收 4）。
   */
  consumeSessionBudget(now: number): boolean {
    const session = this.topicSession;
    if (session === undefined) return false;
    session.budgetLeft = Math.max(0, session.budgetLeft - 1);
    session.lastSpokeAt = now;
    return true;
  }

  /**
   * 关闭当前 session（幂等）：返回是否真的关掉了一个。
   *
   * 关闭是**四种原因的穷举**（`SessionCloseCause`），且每次关闭只报一次、
   * 只带一个原因——验收 11 的账目等式（`closed === Σ closedBy{reason}`）
   * 就建立在"只有这一个出口"上。
   */
  closeSession(cause: SessionCloseCause): boolean {
    const session = this.topicSession;
    if (session === undefined) return false;
    this.topicSession = undefined;
    const event: SessionClosedEvent = { cause, session };
    for (const listener of this.sessionClosedListeners) listener(event);
    return true;
  }

  /** 订阅"session 关闭"事件（返回取消订阅函数）。 */
  onSessionClosed(listener: (event: SessionClosedEvent) => void): () => void {
    this.sessionClosedListeners.add(listener);
    return () => {
      this.sessionClosedListeners.delete(listener);
    };
  }

  // --- 判定时刻与"转录有新增吗" ---------------------------------------------

  /**
   * 记一次"**整个会话**真正跑到判定"（watcher 发起判定调用前调用）。
   *
   * 时钟只前进不回退（与问题级 `markEvaluated` 同款纪律）：并发/乱序调用不该
   * 把标记拉回去，否则"转录有没有新增"会退化成"最近一次调用说了算"。
   */
  markEvaluatedAt(ts: number): void {
    if (this.lastEvaluationAt === undefined || ts > this.lastEvaluationAt) {
      this.lastEvaluationAt = ts;
    }
    // 标记总是跟着"最近一次判定"走（它描述的是"那次判定看见了什么"）
    this.lastEvaluationMarker = this.buffer[this.buffer.length - 1]?.eventId;
  }

  /** 该会话上次进入判定的时刻（`undefined` = 还没判定过）。 */
  get lastEvaluatedAt(): number | undefined {
    return this.lastEvaluationAt;
  }

  /**
   * 转录自 `since` 以来是否有**新增内容**（唯一的本地闸）。
   *
   * 实现刻意是最朴素的"转录是否新增"（需求「明确不在本需求内」一节：
   * 先用最朴素的实现，等"新内容比例"落地后替换）。`since === undefined`
   * 表示还没判定过 → 一律按"有新增"处理（宁可多查一次，不可漏掉一段对话）。
   *
   * 调用方有两处，共用这**同一份实现**（需求「与既有需求/机制的关系」要求）：
   *   - session 的定时唤醒（`question-probe` / `topic-roll`）；
   *   - wait 票据的到期唤醒（对象级，锚点是票据自己的 `evaluatedAt`）。
   */
  hasNewContentSince(since?: number): boolean {
    if (since === undefined) return true;
    return this.buffer.some((entry) => entry.ts > since);
  }

  /**
   * 会话级：**自上次进入判定以来**转录有没有新增（唯一的本地闸，需求 §三）。
   *
   * 两条判据取或：
   *   1. `hasNewContentSince(lastEvaluationAt)`——时间戳，与 wait 票据**共用同一
   *      实现**（需求「与既有需求/机制的关系」一节要求）；
   *   2. 转录**末尾换人了**——平台事件时间可能是**秒**（OneBot 的 `time * 1000`），
   *      同一秒内到达的新消息其 `ts` 并不大于 `lastEvaluationAt`（本机毫秒时钟），
   *      只比时间戳会把它判成"没有新增"，表现就是"它从不主动说话"。
   *      `lastEvaluationMarker` 是判定那一刻转录的末尾，两者不同即说明有新增。
   *
   * 严格大于的边界仍然成立：判定那一刻已经在转录里的那条消息不算"新增"，
   * 否则每次唤醒都会被自己上一轮的触发消息喂饱（等于没有这道检查）。
   */
  hasNewContentSinceLastEvaluation(): boolean {
    if (this.lastEvaluationAt === undefined) return true;
    if (this.hasNewContentSince(this.lastEvaluationAt)) return true;
    const tail = this.buffer[this.buffer.length - 1];
    return (tail?.eventId ?? undefined) !== this.lastEvaluationMarker;
  }

  // --- 读取（供 buildSceneEvidence 消费） ------------------------------------

  get entries(): readonly ObservationEntry[] {
    return this.buffer;
  }

  get botLastSpoke(): number | undefined {
    return this.botLastSpokeAt;
  }

  /**
   * 最近一次**人类**发言时间（不含 bot 自己）。
   *
   * 用途：滚动收敛必须等到"真的没人说话了"——用 bot 自己的发言当锚点会让
   * 刚说完话就立刻收敛，反而更容易插话。
   */
  get lastHumanSpoke(): number | undefined {
    return this.lastHumanAt;
  }

  /** bot 是否仍在这个活动窗口里参与着话题（场景 1 的预筛条件）。 */
  inBotTopicWindow(now: number): boolean {
    if (this.botLastSpokeAt === undefined || this.windowStartedAt === undefined) return false;
    if (this.isExpiredAt(now)) return false;
    return this.botLastSpokeAt >= this.windowStartedAt;
  }

  /**
   * 本活动窗口内 bot 的发言次数。
   *
   * 用途只剩一处：场景 2/5 的**本地预筛**（bot 已经在这个窗口里插过话，
   * 那两个"补一句"的场景就不要再凑热闹）。放行额度早已不按它记账——
   * 那是话题 session 的预算（见本文件顶部的说明）。它也进结构化事实。
   */
  botSpeaks(now: number): number {
    return this.isExpiredAt(now) ? 0 : this.botSpeaksInWindow;
  }

  /** 人类参与人数（本活动窗口内；不含 bot 自己）。 */
  humanParticipants(now: number): number {
    if (this.isExpiredAt(now)) return 0;
    return this.participants.size;
  }

  /** 旁听窗口内的消息条数（本活动窗口内）。 */
  messageCount(now: number): number {
    if (this.isExpiredAt(now)) return 0;
    return this.buffer.filter((entry) => entry.ts >= (this.windowStartedAt ?? 0)).length;
  }

  get unansweredStreak(): number {
    return this.unansweredStreakCount;
  }

  /**
   * 合成话题 id：`topic:<窗口起始时间戳>`。诚实标注"这是活动窗口，不是聚类结果"。
   * 窗口已过期则没有活跃话题（返回 undefined），这样调用方不会拿一个
   * 十分钟前的窗口去当作"话题还在延续"（场景 1/2/5 的预筛与结构化事实都读它）。
   */
  topicId(now?: number): string | undefined {
    if (this.windowStartedAt === undefined) return undefined;
    if (now !== undefined && this.isExpiredAt(now)) return undefined;
    return `topic:${this.windowStartedAt}`;
  }

  /** 当前**仍挂起**的问题（按提问时间升序；已过期/已答/已静默的不返回）。 */
  pendingQuestions(now: number): readonly PendingQuestion[] {
    this.expireQuestions(now);
    return [...this.questions.values()]
      .filter((question) => question.state === 'open')
      .sort((left, right) => left.askedAt - right.askedAt);
  }

  get questionsById(): ReadonlyMap<string, PendingQuestion> {
    return this.questions;
  }

  /**
   * 标记某条消息是对某个挂起问题的**回答**。
   *
   * 谁调用：watcher 在每次评估时，依据否决层/判定的结果来回写"问题已被回答"
   * （当前的实现是"同一窗口内有他人发言且判定说问题不再挂起"，见 watcher 注释）。
   * 关闭会**通知**调度层：该问题的 wait 票据立即作废、唤醒被取消。
   */
  markAnswered(questionId: string): void {
    this.closeQuestion(questionId, 'answered');
  }

  /** 标记问题已被评估过但决定不说（避免反复撞同一堵墙：拒绝也落标记）。 */
  markSilenced(questionId: string): void {
    const question = this.questions.get(questionId);
    if (question !== undefined) question.state = 'silenced';
  }

  /**
   * 订阅"问题关闭"事件（返回取消订阅函数）。
   *
   * 只在**真正从"挂起"变成"关闭"**时触发一次——重复关闭同一条问题不会
   * 重复通知，因此监听者不必自己判重。
   */
  onQuestionClosed(listener: (event: QuestionClosedEvent) => void): () => void {
    this.questionClosedListeners.add(listener);
    return () => {
      this.questionClosedListeners.delete(listener);
    };
  }

  /** 记录一次探针（watcher 排定时器时调用）。 */
  recordProbe(questionId: string): void {
    const question = this.questions.get(questionId);
    if (question !== undefined) question.probes += 1;
  }

  /** 该问题是否还有探针机会（由 watcher 与 veto 策略共同决定上限）。 */
  questionProbes(questionId: string): number {
    return this.questions.get(questionId)?.probes ?? 0;
  }

  /** 记一次"让路"（否决层建票据时调用）。 */
  recordYield(questionId: string): void {
    const question = this.questions.get(questionId);
    if (question !== undefined) question.yieldBudgetUsed += 1;
  }

  /** 该问题已经让路几次。 */
  yieldBudget(questionId: string): number {
    return this.questions.get(questionId)?.yieldBudgetUsed ?? 0;
  }

  /**
   * 记一次"真正跑到判定"（watcher 发起判定调用前调用）。
   *
   * 时钟只前进不回退：并发/乱序调用不该把标记拉回去。
   */
  markEvaluated(questionId: string, ts: number): void {
    const question = this.questions.get(questionId);
    if (question === undefined) return;
    if (question.lastEvaluatedAt === undefined || ts > question.lastEvaluatedAt) {
      question.lastEvaluatedAt = ts;
    }
  }

  // --- 内部 -----------------------------------------------------------------

  /**
   * 关闭一条问题（幂等）：只在**从挂起变为关闭**的那一次通知监听者。
   * 已经是终态的问题不重复关闭、也不重复通知——否则同一张票据会被作废两次。
   */
  private closeQuestion(questionId: string, cause: QuestionClosedCause): void {
    const question = this.questions.get(questionId);
    if (question === undefined || question.state !== 'open') return;
    question.state = cause === 'answered' ? 'answered' : 'expired';
    for (const listener of this.questionClosedListeners) listener({ id: questionId, cause });
  }

  private startWindow(ts: number): void {
    this.windowStartedAt = ts;
    // 新话题开始 → 本窗口内的 bot 发言计数归零（场景 2/5 预筛与结构化事实读它）
    this.botSpeaksInWindow = 0;
    this.participants.clear();
    // 话题翻篇：上一窗口的未答问题不再算"这个群里有人问了没人答"
    // （否则十分钟前的问题会一直挂在台账里，让场景 3 凭空触发）。
    // 逐条关闭（而不是 clear）是必须的：挂在它们身上的 wait 票据要**立即**
    // 作废并取消唤醒，而不是等定时器到点才发现对象已经不存在了。
    for (const id of [...this.questions.keys()]) this.closeQuestion(id, 'window-reset');
    this.questions.clear();
    // 注意：不清 buffer——转录需要跨窗口的近期上下文；
    // 计数类（条数/人头）在读取时按 windowStartedAt 过滤。
  }

  /**
   * 窗口是否已过期。**只用状态里记录的时钟**（`lastHumanAt` / `windowStartedAt`），
   * 绝不调 `Date.now()`：本类是纯状态机，读墙上时钟会让单测不可复现，
   * 也会让"补投一条延迟到达的旧消息"把整个窗口算错。
   *
   * 锚点是**最近一次人类发言**（不是窗口起点）：窗口的语义是"话题还在延续"，
   * 只要持续有人说话就一直是同一个话题；静默超过 `activityWindowMs` 才算翻篇。
   */
  private isExpiredAt(ts: number): boolean {
    if (this.windowStartedAt === undefined) return true;
    const anchor = this.lastHumanAt ?? this.windowStartedAt;
    return ts - anchor > this.options.activityWindowMs;
  }

  private trim(now: number): void {
    const cutoff = now - this.options.maxAgeMs;
    while (this.buffer.length > 0 && (this.buffer[0] as ObservationEntry).ts < cutoff) {
      this.buffer.shift();
    }
    while (this.buffer.length > this.options.maxEntries) this.buffer.shift();
  }

  private registerQuestion(entry: ObservationEntry): void {
    // 同一条消息不重复登记
    for (const question of this.questions.values()) {
      if (question.msgId === entry.msgId) return;
    }
    const id = `${entry.msgId}@${entry.ts}`;
    this.questions.set(id, {
      id,
      msgId: entry.msgId,
      askerId: entry.senderId,
      ...(entry.senderName !== undefined ? { askerName: entry.senderName } : {}),
      text: entry.text,
      topicId: this.topicId() ?? 'topic:unknown',
      askedAt: entry.ts,
      probes: 0,
      state: 'open',
      yieldBudgetUsed: 0,
    });
    while (this.questions.size > this.options.maxQuestions) {
      const oldest = [...this.questions.values()].sort((a, b) => a.askedAt - b.askedAt)[0];
      if (oldest === undefined) break;
      // 台账满员淘汰也算"关闭"：票据得跟着作废，否则会留一张永远醒不来的孤儿票据
      this.closeQuestion(oldest.id, 'window-reset');
      this.questions.delete(oldest.id);
    }
  }

  private expireQuestions(now: number): void {
    for (const question of this.questions.values()) {
      if (question.state !== 'open') continue;
      if (now - question.askedAt > this.options.questionTtlMs) {
        this.closeQuestion(question.id, 'expired');
      }
    }
  }
}

/** 每会话一个状态的注册表（进程内；重启即清空）。 */
export class ConversationStateStore {
  private readonly states = new Map<string, ConversationState>();
  private readonly options: ConversationStateOptions;
  /** 问题关闭的统一分发（转发给每个会话自己的订阅者） */
  private readonly closers = new Set<(convKey: string, event: QuestionClosedEvent) => void>();
  /** session 关闭的统一分发（转发给每个会话自己的订阅者） */
  private readonly sessionClosers = new Set<(convKey: string, event: SessionClosedEvent) => void>();
  /** 每会话的取消订阅函数（会话被 `dispose` 时要一并摘掉，否则监听器泄漏） */
  private readonly unsubscribe = new Map<string, () => void>();

  constructor(options: ConversationStateOptions = {}) {
    this.options = options;
  }

  /** 取（或首次创建）某会话的状态。 */
  for(convKey: string): ConversationState {
    let state = this.states.get(convKey);
    if (state === undefined) {
      state = new ConversationState(convKey, this.options);
      // 每个会话的关闭事件都带上 convKey 转发出去——调度层据此作废票据 / 记
      // session 的关闭原因，而它只需要订阅一次（不必关心有多少个会话被创建过）。
      const offQuestion = state.onQuestionClosed((event) => {
        for (const listener of this.closers) listener(convKey, event);
      });
      const offSession = state.onSessionClosed((event) => {
        for (const listener of this.sessionClosers) listener(convKey, event);
      });
      this.unsubscribe.set(convKey, () => {
        offQuestion();
        offSession();
      });
      this.states.set(convKey, state);
    }
    return state;
  }

  /**
   * 订阅**任意会话**的问题关闭事件（返回取消订阅函数）。
   * 只能拿到此后新建的会话——调用方应在组装期就订阅好（见 watcher 构造器）。
   */
  onQuestionClosed(
    listener: (convKey: string, event: QuestionClosedEvent) => void,
  ): () => void {
    this.closers.add(listener);
    return () => {
      this.closers.delete(listener);
    };
  }

  /** 订阅**任意会话**的 session 关闭事件（返回取消订阅函数）。 */
  onSessionClosed(
    listener: (convKey: string, event: SessionClosedEvent) => void,
  ): () => void {
    this.sessionClosers.add(listener);
    return () => {
      this.sessionClosers.delete(listener);
    };
  }

  /**
   * 丢弃某会话的状态（连带关闭它的 session，原因 `conversation-gone`）。
   *
   * 这是需求「session 的关闭条件（四条，穷举）」里最后一条的落点。当前运行期
   * **没有任何调用方**：会话状态一旦创建就常驻到进程结束（旁听状态本来就是
   * 进程内的、不落盘）。留着它是因为"状态被清理时连带关闭"必须只有一个入口，
   * 将来加状态淘汰（例如按白名单变化回收）时不必再想一遍 session 怎么收口。
   */
  dispose(convKey: string): boolean {
    const state = this.states.get(convKey);
    if (state === undefined) return false;
    state.closeSession('conversation-gone');
    this.unsubscribe.get(convKey)?.();
    this.unsubscribe.delete(convKey);
    this.states.delete(convKey);
    return true;
  }

  /** 已跟踪的会话数（health 展示用）。 */
  get size(): number {
    return this.states.size;
  }

  /** 供 health / 控制面遍历（只读）。 */
  all(): readonly ConversationState[] {
    return [...this.states.values()];
  }
}
