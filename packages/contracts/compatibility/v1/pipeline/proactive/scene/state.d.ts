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
import type { DeepReadonly } from '@qqbot/contracts';
import type { ObservationWindow, ObservationWindowStore, ObservationEntry } from '../../../store/window.js';
import type { SessionCloseCause, SessionClosedEvent, TopicSession } from '../contract.js';
/**
 * 旁听缓冲的一条消息 = 观察窗口的一条消息：**类型与实现在 `store/window.ts`**。
 *
 * 这里曾经是本模块私有的接口与私有数组。抽出去的理由见 `store/window.ts` 顶部：
 * 滚窗是所有唤醒路径共享的输入，不该由判定层的状态机拥有。保留这个 re-export
 * 只是为了让既有 import 路径（`scene/state.js`）不突然断掉。
 */
export type { ObservationEntry };
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
export declare const MIN_QUESTION_CHARS = 4;
export type looksLikeQuestion = (text: string) => boolean;
export interface ConversationStateOptions {
    /** 活动窗口：多久没新消息就算"话题翻篇"（bot 参与窗口与计数一并失效） */
    activityWindowMs?: number;
    /** 未答问题台账上限 */
    maxQuestions?: number;
    /** 挂了多久仍无人应答就作废（防止台账把十分钟前的问题一直当"挂起"） */
    questionTtlMs?: number;
    /** 话题预算身份生成器，仅用于依赖注入与确定性验收。 */
    idFactory?: () => string;
}
/**
 * 默认活动窗口（毫秒）：静默这么久就算话题翻篇。watcher 与 veto 上下文共用它。
 *
 * ⚠️ 与观察窗口的**保留期**（`observation.maxMessages` / `maxAgeMs`）不是一个概念：
 * 那个决定"我们记得多久"（由 `store/window.ts` 持有），这个决定"当前话题有多长"
 * （判定层的口径）。前者宽、后者窄，是有意的——判定要能回看，计数只算当下。
 */
export declare const DEFAULT_ACTIVITY_WINDOW_MS: number;
export type DEFAULT_STATE_OPTIONS = Required<ConversationStateOptions>;
export interface ConversationState {
    readonly convKey: string;
    /**
     * 记一条旁听消息（**委托**给观察窗口，本类只做自己的记账）。
     *
     * 与 `observeEntry` 的差别只有两处：文本从 `NormalizedMessage` 里取、
     * `addressed` 固定为 false。判定层把两者都看作"群里有人说话了"。
     */
    observe(message: NormalizedMessage): void;
    /**
     * 记一条**已被 @** 的消息（用于转录完整性：场景 1 要看到"bot 回答了谁"）。
     * 它同样算作"话题在延续"，因此也刷新活动窗口与参与人——**但不登记挂起问题**
     * （它已经直接问 bot 了，不属于"无人应答"，见 `noteHumanMessage` 的说明）。
     */
    observeAddressed(message: NormalizedMessage): void;
    /** 记一条窗口条目（`addressed` 由调用方标）——被动回复路径与判定层共用的写入口。 */
    observeEntry(entry: ObservationEntry): void;
    /**
     * bot 在本群发了一条**主动**发言：无人回应计数 +1、话题额度 +1。
     *
     * 语义提醒：计数是"连续几次主动发言之间没有人接话"。用户 @ bot 后的回复
     * **不算**主动发言（那是被叫到的应答），因此不会让计数上涨——否则
     * "没人理我就停"会被一轮正常问答误触发。
     */
    recordBotSpoke(ts: number): void;
    /**
     * 当前**开启中**的 session（`undefined` = 没有）。
     *
     * 读它是**只读**语义：否决层据此判"闸门过不过"，判定层据此渲染结构化事实。
     * 关闭后立即返回 `undefined`——"关闭后下次唤醒回到流程 ①"靠的就是这一条。
     */
    get session(): TopicSession | undefined;
    /**
     * 开一个新 session（LLM 判"值得"、且该次发言真的发出去时调用）。
     *
     * **已有 session 时拒绝覆盖并返回 false**：正常路径下不可能发生（闸门只在
     * 没有 session 时才放行），真发生了说明调用方接线错了——静默覆盖会把上一个
     * session 的预算账吞掉，那是最难查的一类问题。返回 false 由调用方记日志。
     */
    openSession(now: number, budget: number): boolean;
    /**
     * 旧 compose 回归的提交接口；生产通过 taskBudgetScope 投影 TaskBudget。
     *
     * 返回 false = 没有开启中的 session（什么都没做）。**减到 0 不在这里关闭**：
     * 关闭要通知监听者、要区分四种原因，统一走 `closeSession()`
     * （预算耗尽只限制新 Task，不触发关闭）。
     */
    consumeSessionBudget(now: number): boolean;
    /** Capture the trigger's scope. Completion never charges a later topic. */
    taskBudgetScope(limit: number): {
        id: string;
        limit: number;
        reserve: () => void;
        release: () => void;
        commit: (ts: number) => void;
        isCurrent: () => boolean;
    };
    /**
     * 关闭当前 session（幂等）：返回是否真的关掉了一个。
     *
     * 关闭是**四种原因的穷举**（`SessionCloseCause`），且每次关闭只报一次、
     * 只带一个原因——验收 11 的账目等式（`closed === Σ closedBy{reason}`）
     * 就建立在"只有这一个出口"上。
     */
    committedTaskCount(session: TopicSession): number;
    closeSession(cause: SessionCloseCause): boolean;
    /** 订阅"session 关闭"事件（返回取消订阅函数）。 */
    onSessionClosed(listener: (event: SessionClosedEvent) => void): () => void;
    /**
     * 记一次"**整个会话**真正跑到判定"（watcher 发起判定调用前调用）。
     *
     * 时钟只前进不回退（与问题级 `markEvaluated` 同款纪律）：并发/乱序调用不该
     * 把标记拉回去，否则"转录有没有新增"会退化成"最近一次调用说了算"。
     */
    markEvaluatedAt(ts: number): void;
    /** 该会话上次进入判定的时刻（`undefined` = 还没判定过）。 */
    get lastEvaluatedAt(): number | undefined;
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
    hasNewContentSince(since?: number): boolean;
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
    hasNewContentSinceLastEvaluation(): boolean;
    /**
     * 保留期内的全部条目（**跨活动窗口**，按时间升序）。
     *
     * 为什么不按活动窗口过滤：转录的用途是"理解话题"，翻篇那一刻把上一段的
     * 上下文整段抹掉会让判定看不懂指代（"这个"指的是什么）。计数类
     * （`messageCount` / `humanParticipants`）才按活动窗口过滤。
     */
    get entries(): DeepReadonly<ObservationEntry[]>;
    get botLastSpoke(): number | undefined;
    /**
     * 最近一次**人类**发言时间（不含 bot 自己）。
     *
     * 用途：滚动收敛必须等到"真的没人说话了"——用 bot 自己的发言当锚点会让
     * 刚说完话就立刻收敛，反而更容易插话。
     */
    get lastHumanSpoke(): number | undefined;
    /** bot 是否仍在这个活动窗口里参与着话题（场景 1 的预筛条件）。 */
    inBotTopicWindow(now: number): boolean;
    /**
     * 本活动窗口内 bot 的发言次数。
     *
     * 用途只剩一处：场景 2/5 的**本地预筛**（bot 已经在这个窗口里插过话，
     * 那两个"补一句"的场景就不要再凑热闹）。放行额度早已不按它记账——
     * 那是话题 session 的预算（见本文件顶部的说明）。它也进结构化事实。
     */
    botSpeaks(now: number): number;
    /** 人类参与人数（本活动窗口内；不含 bot 自己）。 */
    humanParticipants(now: number): number;
    /** 旁听窗口内的消息条数（本活动窗口内）。 */
    messageCount(now: number): number;
    get unansweredStreak(): number;
    /**
     * 合成话题 id：`topic:<窗口起始时间戳>`。诚实标注"这是活动窗口，不是聚类结果"。
     * 窗口已过期则没有活跃话题（返回 undefined），这样调用方不会拿一个
     * 十分钟前的窗口去当作"话题还在延续"（场景 1/2/5 的预筛与结构化事实都读它）。
     */
    topicId(now?: number): string | undefined;
    /** 当前**仍挂起**的问题（按提问时间升序；已过期/已答/已静默的不返回）。 */
    pendingQuestions(now: number): DeepReadonly<PendingQuestion[]>;
    get questionsById(): DeepReadonly<Map<string, PendingQuestion>>;
    /**
     * 标记某条消息是对某个挂起问题的**回答**。
     *
     * 谁调用：watcher 在每次评估时，依据否决层/判定的结果来回写"问题已被回答"
     * （当前的实现是"同一窗口内有他人发言且判定说问题不再挂起"，见 watcher 注释）。
     * 关闭会**通知**调度层：该问题的 wait 票据立即作废、唤醒被取消。
     */
    markAnswered(questionId: string): void;
    /** 标记问题已被评估过但决定不说（避免反复撞同一堵墙：拒绝也落标记）。 */
    markSilenced(questionId: string): void;
    /**
     * 订阅"问题关闭"事件（返回取消订阅函数）。
     *
     * 只在**真正从"挂起"变成"关闭"**时触发一次——重复关闭同一条问题不会
     * 重复通知，因此监听者不必自己判重。
     */
    onQuestionClosed(listener: (event: QuestionClosedEvent) => void): () => void;
    /** 记录一次探针（watcher 排定时器时调用）。 */
    recordProbe(questionId: string): void;
    /** 该问题是否还有探针机会（由 watcher 与 veto 策略共同决定上限）。 */
    questionProbes(questionId: string): number;
    /** 记一次"让路"（否决层建票据时调用）。 */
    recordYield(questionId: string): void;
    /** 该问题已经让路几次。 */
    yieldBudget(questionId: string): number;
    /**
     * 记一次"真正跑到判定"（watcher 发起判定调用前调用）。
     *
     * 时钟只前进不回退：并发/乱序调用不该把标记拉回去。
     */
    markEvaluated(questionId: string, ts: number): void;
}
export type createConversationStateFactory = (convKey: string, window: ObservationWindow, options?: ConversationStateOptions) => ConversationState;
export interface ConversationStateStore {
    /** 取（或首次创建）某会话的状态。 */
    for(convKey: string): ConversationState;
    /**
     * 订阅**任意会话**的问题关闭事件（返回取消订阅函数）。
     * 只能拿到此后新建的会话——调用方应在组装期就订阅好（见 watcher 构造器）。
     */
    onQuestionClosed(listener: (convKey: string, event: QuestionClosedEvent) => void): () => void;
    /** 订阅**任意会话**的 session 关闭事件（返回取消订阅函数）。 */
    onSessionClosed(listener: (convKey: string, event: SessionClosedEvent) => void): () => void;
    /**
     * 丢弃某会话的状态（连带关闭它的 session，原因 `conversation-gone`）。
     *
     * 这是需求「session 的关闭条件（四条，穷举）」里最后一条的落点。当前运行期
     * **没有任何调用方**：会话状态一旦创建就常驻到进程结束（旁听状态本来就是
     * 进程内的、不落盘）。留着它是因为"状态被清理时连带关闭"必须只有一个入口，
     * 将来加状态淘汰（例如按白名单变化回收）时不必再想一遍 session 怎么收口。
     */
    dispose(convKey: string): boolean;
    /** 已跟踪的会话数（health 展示用）。 */
    get size(): number;
    /** 供 health / 控制面遍历（只读）。 */
    all(): readonly ConversationState[];
}
export type createConversationStateStoreFactory = (windows: ObservationWindowStore, options?: ConversationStateOptions) => ConversationStateStore;
