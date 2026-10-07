/**
 * ① 搜集层的**会话状态**：旁听缓冲 + 未答问题台账 + 无人回应计数 + bot 参与窗口。
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
 * - **不做逐话题预算**：那属于否决层的 `VetoPolicy.maxPerTopic`，
 *   本层只如实报"bot 在这个活动窗口里说过几次"（`botSpeaksInWindow`）。
 * - **不做持久化**：状态全在内存，进程重启即清空（与旁听内容的隐私口径一致，
 *   见架构方案 §9 风险表）。要持久化是另一件事，需要单独评估留存期限。
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
    // "新窗口里的第一句 bot 发言"被 startWindow 的清零吃掉（每话题一次形同失效）。
    this.botSpeaksInWindow += 1;
    if (this.windowStartedAt === undefined || this.isExpiredAt(ts)) this.startWindow(ts);
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

  /** 本活动窗口内 bot 的发言次数（否决层的"每话题一次"口径）。 */
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
   * 十分钟前的话题 id 去做"每话题一次"的判断。
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
   */
  markAnswered(questionId: string): void {
    const question = this.questions.get(questionId);
    if (question !== undefined) question.state = 'answered';
  }

  /** 标记问题已被评估过但决定不说（避免反复撞同一堵墙：拒绝也落标记）。 */
  markSilenced(questionId: string): void {
    const question = this.questions.get(questionId);
    if (question !== undefined) question.state = 'silenced';
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

  // --- 内部 -----------------------------------------------------------------

  private startWindow(ts: number): void {
    this.windowStartedAt = ts;
    // 新话题开始 → 话题额度归零（"每话题一次"的口径就是这个窗口）
    this.botSpeaksInWindow = 0;
    this.participants.clear();
    // 话题翻篇：上一窗口的未答问题不再算"这个群里有人问了没人答"
    // （否则十分钟前的问题会一直挂在台账里，让场景 3 凭空触发）。
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
    });
    while (this.questions.size > this.options.maxQuestions) {
      const oldest = [...this.questions.values()].sort((a, b) => a.askedAt - b.askedAt)[0];
      if (oldest === undefined) break;
      this.questions.delete(oldest.id);
    }
  }

  private expireQuestions(now: number): void {
    for (const question of this.questions.values()) {
      if (question.state !== 'open') continue;
      if (now - question.askedAt > this.options.questionTtlMs) question.state = 'expired';
    }
  }
}

/** 每会话一个状态的注册表（进程内；重启即清空）。 */
export class ConversationStateStore {
  private readonly states = new Map<string, ConversationState>();
  private readonly options: ConversationStateOptions;

  constructor(options: ConversationStateOptions = {}) {
    this.options = options;
  }

  /** 取（或首次创建）某会话的状态。 */
  for(convKey: string): ConversationState {
    let state = this.states.get(convKey);
    if (state === undefined) {
      state = new ConversationState(convKey, this.options);
      this.states.set(convKey, state);
    }
    return state;
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
