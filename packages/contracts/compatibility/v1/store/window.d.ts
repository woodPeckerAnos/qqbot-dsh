/**
 * 观察窗口（旁听滚窗）：**全局**共享的"群里刚刚说了什么"。
 *
 * 窗口独立于主动介入开关，白名单内消息始终记录。ProactiveWatcher 与
 * PromptPreparer 都是消费者，分别选择判定窗口和 Task 输入窗口，不拥有窗口状态。
 *
 * ## 纪律（与介入层的三条硬纪律同源）
 *
 * 1. **静默**：本模块不做任何判断、不调 LLM、不写日志（除配置错误）、永不抛错。
 *    写入失败的唯一可能后果是"少一条上下文"，绝不能让主链路失败；
 * 2. **窗口纯内存、不落盘**：进程重启即清空。冷启动由 ConversationStore 的
 *    bot 相关轮次回放补偿。有效 Task 在准入时固定所需窗口摘录和原消息引用，
 *    这些输入由 TaskStore 按 Task 保留期持久化，不是整个旁听窗口的磁盘副本。
 * 3. **准入只有一处**：窗口收不收某条消息，只由 `allowlist` 决定，且**与
 *    `proactive.enabled` 无关**——这正是解耦的意义。白名单为空 = 什么都不收
 *    （fail-closed，与介入层口径一致）。
 *
 * ## 与 `ConversationState` 的关系
 *
 * `ConversationState` 不再自己持有缓冲，改为**委托**本模块（它保留的是判定层
 * 自己的状态：挂起问题台账、活动窗口计数、话题 session）。因此：
 *
 *   - `bufferMax*` 这两个限制从 `proactive.*` 搬到 `observation.*`（旧的
 *     `proactive.bufferMax*` 仍然接受，见 `src/config.ts` 的兼容说明）；
 *   - **保留期**（`maxMessages` / `maxAgeMs`）与**读取范围**（`activityWindowMs`）
 *     是两个概念：前者决定我们记得多久，后者决定"当前话题"有多长。判定层要宽窗
 *     （宁可多读），Task 输入由 `PromptPreparer.capture` 按上下文边界固定。
 *
 * ## 媒体（图片 / 文件）
 *
 * 条目里除了扁平化文本，还留着**媒体引用**（`ObservationMedia`）：被 @ 时注入的
 * 群聊上下文如果只有 `[图片: x.jpg]` 这种占位，模型就永远看不到"群里刚发的那张
 * 图"——而这正是最常被 @ 的场景。引用在写入时只存不取，由 `collectWindowMedia`
 * 在注入时按配额挑出来，再交给与当前消息**同一条**下载/降采样/落盘通路。
 */
/**
 * 观察窗口（旁听滚窗）：**全局**共享的"群里刚刚说了什么"。
 *
 * 窗口独立于主动介入开关，白名单内消息始终记录。ProactiveWatcher 与
 * PromptPreparer 都是消费者，分别选择判定窗口和 Task 输入窗口，不拥有窗口状态。
 *
 * ## 纪律（与介入层的三条硬纪律同源）
 *
 * 1. **静默**：本模块不做任何判断、不调 LLM、不写日志（除配置错误）、永不抛错。
 *    写入失败的唯一可能后果是"少一条上下文"，绝不能让主链路失败；
 * 2. **窗口纯内存、不落盘**：进程重启即清空。冷启动由 ConversationStore 的
 *    bot 相关轮次回放补偿。有效 Task 在准入时固定所需窗口摘录和原消息引用，
 *    这些输入由 TaskStore 按 Task 保留期持久化，不是整个旁听窗口的磁盘副本。
 * 3. **准入只有一处**：窗口收不收某条消息，只由 `allowlist` 决定，且**与
 *    `proactive.enabled` 无关**——这正是解耦的意义。白名单为空 = 什么都不收
 *    （fail-closed，与介入层口径一致）。
 *
 * ## 与 `ConversationState` 的关系
 *
 * `ConversationState` 不再自己持有缓冲，改为**委托**本模块（它保留的是判定层
 * 自己的状态：挂起问题台账、活动窗口计数、话题 session）。因此：
 *
 *   - `bufferMax*` 这两个限制从 `proactive.*` 搬到 `observation.*`（旧的
 *     `proactive.bufferMax*` 仍然接受，见 `src/config.ts` 的兼容说明）；
 *   - **保留期**（`maxMessages` / `maxAgeMs`）与**读取范围**（`activityWindowMs`）
 *     是两个概念：前者决定我们记得多久，后者决定"当前话题"有多长。判定层要宽窗
 *     （宁可多读），Task 输入由 `PromptPreparer.capture` 按上下文边界固定。
 *
 * ## 媒体（图片 / 文件）
 *
 * 条目里除了扁平化文本，还留着**媒体引用**（`ObservationMedia`）：被 @ 时注入的
 * 群聊上下文如果只有 `[图片: x.jpg]` 这种占位，模型就永远看不到"群里刚发的那张
 * 图"——而这正是最常被 @ 的场景。引用在写入时只存不取，由 `collectWindowMedia`
 * 在注入时按配额挑出来，再交给与当前消息**同一条**下载/降采样/落盘通路。
 */
import type { MessageImagePart, MessageMediaPart, NormalizedMessage } from '../core/connector.js';
import type { DeepReadonly } from '@qqbot/contracts';
/**
 * 会话键是否落在群白名单内。
 *
 * 为什么必须是**同一个**函数而不是各写一遍：白名单有两个等价写法
 * （`onebot:123456` 的平台:群号 与 `ob11:g123456` 的会话键形态），
 * 两处各写一份迟早会分叉，而分叉的表现是"介入层认这个群、滚窗不认"——
 * 一种只有到线上才会被发现的静默不一致。
 *
 * 判据：条目与整条会话键相等，或条目里的群号部分与 `:g<群号>` 相符。
 */
export type matchesGroupAllowlist = (convKey: string, allowlist: readonly string[]) => boolean;
/**
 * 窗口里的一条消息。
 *
 * 字段刻意与判定层的 `ObservationEntry` 同构（这就是它搬过来的那份），只多了
 * 一个 `isBot`：判定层需要知道"哪句是我说的"（场景 1 的判据），被动注入同样
 * 需要——否则模型看到群友追问却看不到自己刚回答过什么。
 */
export interface ObservationEntry {
    readonly reference?: import('../core/connector.js').OriginalMessageReference;
    readonly taskId?: string;
    readonly lane?: 'fast' | 'slow';
    readonly msgId: string;
    readonly eventId: string;
    readonly senderId: string;
    readonly senderName?: string;
    readonly text: string;
    readonly ts: number;
    /** 这条消息是否**已经把疑问抛给 bot**（@ 了 bot 或接着 bot 的话说）。 */
    readonly addressed: boolean;
    /** 是否是 bot 自己的发言（被动回复或主动发言）。渲染时标成「我」。 */
    readonly isBot?: boolean;
    /**
     * 这条消息里的**媒体引用**（只有地址/标识，没有字节）。
     *
     * 见 {@link ObservationMedia}：`text` 里的 `[图片: x.jpg]` 只是占位，光有它
     * 不足以让模型看到那张图。
     */
    readonly media?: ObservationMedia;
    /**
     * 这条消息里**还没展开**的聊天记录 id（合并转发；按出现顺序）。
     *
     * 刻意不进 `text`：聊天记录一条动辄几十条发言，当"普通群聊上下文"灌进去既烧
     * token 又把真正在聊的事淹掉。只有被 @ 且这次的问题**明确提到**它时，才凭这个
     * id 去回查（见 {@link latestPendingRecord} 与 `BotConnector.fetchForward`）。
     */
    readonly recordIds?: readonly string[];
}
/**
 * 一条消息里能取到字节的媒体引用。
 *
 * ## 为什么窗口要留下它
 *
 * `text` 是给人（和模型）看的**扁平化文本**：图片只剩 `[图片: DF77A739.jpg]`。
 * 而被 @ 时注入的群聊上下文只有这一份文本，于是"群里刚发的那张图，@ 一下让 bot
 * 看看"必然失败——模型如实回答"我这边只收到一个占位符"，工作区里也没有文件，
 * 如果只保留扁平文本，PromptPreparer 就无法恢复旁听消息的图片；直接携带的图
 * 则可从当前消息的 `parts` 读取。
 *
 * 所以窗口除了文本，还要留下**能重新取到字节的东西**（url 快路径 + fileId 回查，
 * 与当前消息完全同一套，见 `dsh/media.ts` 与 `dsh/files.ts`）。取字节发生在注入时
 * （见 {@link collectWindowMedia} 的调用方），不是写入时：
 *
 *   - 写入时不产生任何 IO——群里的图不该因为我们旁听就被下载；
 *   - 读取时按配额取，只有真的被 @ 且真的用得上才付出代价。
 *
 * 纪律与窗口本体一致：**只存引用、不存字节、不落盘**。
 */
export interface ObservationMedia {
    /** 图片（含引用消息里的图片；转发块里的不在这里，见 `core/content.ts` 的说明） */
    images: readonly MessageImagePart[];
    /**
     * 文件（`mediaKind === 'file'`）。
     *
     * 视频等其它形态**刻意不收**：当前消息的处理面也只到"渲染成一行标记"，
     * 窗口里多留一份只会让"清单里有的却没读"看起来像 bug。
     */
    files: readonly MessageMediaPart[];
}
/**
 * 把一条归一化消息变成窗口条目——**唯一的转换点**。
 *
 * 为什么必须收在一处：写入窗口有两条路（`ObservationWindow.observe*` 与
 * 判定层的 `ConversationState.observe*`，后者绕过前者直接写 `observeEntry`）。
 * 两边各拼一份的话，"旁听消息带不带媒体引用"就会有两个答案，而这类分叉的表现是
 * "旁听消息的图能进来、@ 消息的图进不来"这种没人能解释的状态。
 */
export type toObservationEntry = (message: NormalizedMessage, addressed: boolean) => ObservationEntry;
export interface ObservationPolicy {
    /** 观察范围：只有落在白名单里的会话才入窗（空 = 不观察任何会话） */
    allowlist: readonly string[];
    /** 每会话保留的消息条数上限 */
    maxMessages?: number;
    /** 每条消息在窗口里的最长保留时长（毫秒） */
    maxAgeMs?: number;
}
/** 保留期的默认值（沿用介入层搬过来的原值，避免行为漂移）。 */
export declare const DEFAULT_OBSERVATION_MAX_MESSAGES = 200;
export declare const DEFAULT_OBSERVATION_MAX_AGE_MS: number;
/**
 * 被 @ 时最多内联几张上下文里的图片（`observation.injectImages`）。
 *
 * 2 的取法：最常见的形态是"发一张图 + @ 一句问"，第二张用于"这两张哪个好"；
 * 再往上就是拿背景图片烧 token 了——而真正被问的那张几乎总是最近的。
 */
export declare const DEFAULT_OBSERVATION_INJECT_IMAGES = 2;
/**
 * 被 @ 时最多摄取几个上下文里的文件（`observation.injectFiles`）。
 *
 * 1 而不是 2：文件要下载 + 落 inbox + 可能起抽取子进程，"翻背景资料"通常
 * 只需要最近那一个（"这个 PDF 讲的是什么"）。
 */
export declare const DEFAULT_OBSERVATION_INJECT_FILES = 1;
/** 读取窗口的选项。三个条件同时生效（先按时间/条数裁，再排除指定消息）。 */
export interface ReadWindowOptions {
    /** 最多取多少条（取**最近**的 N 条，缺省不限） */
    limit?: number;
    /**
     * 只取 `sinceTs` 之后的消息。
     *
     * 注意语义是"窗口起点"，不是"距现在多久"——调用方自己算
     * `now - activityWindowMs`。这样时钟只有一个来源（调用方的 `now`），
     * 本模块里不出现 `Date.now()`，单测因此可复现。
     */
    sinceTs?: number;
    /** 排除某条消息（典型用法：排除当前这条触发消息，避免与单独渲染的当前行重复） */
    excludeMsgId?: string;
}
export interface ObservationWindow {
    readonly convKey: string;
    /** 记一条**旁听**消息（群里没 @ bot 的那条）。 */
    observe(message: NormalizedMessage): void;
    /**
     * 记一条**已被 @** 的消息（它走 Ingress 管线，不会经过 `observe`）。
     *
     * 两条路径都写同一份窗口：判定层需要"bot 回答了谁"（场景 1），被动注入需要
     * "这个人问的是哪件事"。
     */
    observeAddressed(message: NormalizedMessage): void;
    /**
     * 记一条 **bot 自己的发言**。
     *
     * 为什么必须记：在此之前 bot 的回复既不进缓冲、也不在转录里，于是"续聊"
     * 的判定方是在**不知道自己刚才说了什么**的情况下决定要不要接话
     * （`docs/PROACTIVE-INTERVENTION-ARCH.md` §3.6 的未修缺口），被动注入也会
     * 看到"群友追问、没有回答"的半截对话。
     */
    recordBotReply(input: {
        msgId?: string;
        text: string;
        ts: number;
        dryRun?: boolean;
        reference?: import('../core/connector.js').OriginalMessageReference;
        taskId?: string;
        lane?: 'fast' | 'slow';
    }): void;
    /**
     * 直接写入一条（供委托方与测试使用）。
     *
     * 清理用**已观察来源时间的高水位**（不是刚写进来的那条的）：平台事件时间未必有序
     * ——转发的旧消息、补投的延迟消息、以及"进程睡过去再醒来"都会让 `ts` 回退。
     * 拿新条目的 `ts` 当基准会算出偏早的 cutoff，于是**什么都不淘汰**，窗口悄悄
     * 长到几百条却没人发现（单测踩过）。
     *
     * 淘汰的边界是"严格更旧"（`ts < cutoff`）：同一毫秒内到达的多条消息必须一起
     * 留下，否则 OneBot 的秒级时间戳（`time * 1000`）下并发消息会被逐条吃掉。
     */
    observeEntry(entry: ObservationEntry): void;
    /** 当前保留的全部条目。快照隔离内部引用，后续写入不会改写已读取的数据。 */
    get entries(): DeepReadonly<ObservationEntry[]>;
    get size(): number;
    /** 最近一条消息的时间戳（窗口为空时 undefined）。 */
    get lastTs(): number | undefined;
    /**
     * 按条件读窗口。
     *
     * 实现刻意朴素（一次 `filter` + 一次 `slice`）：窗口上限是几百条，
     * 二分/索引带来的复杂度不值得，而"读到的与写入的完全一致"这件事更值钱。
     */
    read(options?: ReadWindowOptions): DeepReadonly<ObservationEntry[]>;
    /**
     * `since` 之后是否有新内容（严格大于）。
     *
     * 这是判定层"唯一的本地闸"的底层实现（`hasNewContentSince`）：语义必须是
     * **严格大于**，否则"判定那一刻已经在转录里的那条消息"会被算作新增，
     * 每次唤醒都会被自己上一轮的触发消息喂饱（等于没有这道检查）。
     */
    anySince(since: number): boolean;
    /** 时间跨度（毫秒）：最早一条到最晚一条。空窗口或单条返回 0。 */
    spanMs(): number;
}
export type createObservationWindowFactory = (convKey: string, options?: {
    maxMessages?: number;
    maxAgeMs?: number;
}) => ObservationWindow;
export interface ObservationWindowStore {
    /** 该会话是否在观察范围内（白名单；与介入层共用同一份判据）。 */
    accepts(convKey: string): boolean;
    /** 取（或首次创建）某会话的窗口。**不做准入判断**——那是 `observe*` 的事。 */
    for(convKey: string): ObservationWindow;
    /**
     * 记一条旁听消息（不在观察范围内 = 静默丢弃，连窗口都不建）。
     * @returns 是否真的记下了
     */
    observe(message: NormalizedMessage): boolean;
    /** 记一条被 @ 的消息。 @returns 是否真的记下了 */
    observeAddressed(message: NormalizedMessage): boolean;
    /** 记一条 bot 自己的发言。 @returns 是否真的记下了 */
    recordBotReply(convKey: string, input: {
        msgId?: string;
        text: string;
        ts: number;
        dryRun?: boolean;
        reference?: import('../core/connector.js').OriginalMessageReference;
        taskId?: string;
        lane?: 'fast' | 'slow';
    }): boolean;
    /** 只读读取（不创建窗口：读一个从未收过消息的会话应当返回空，而不是建一个）。 */
    read(convKey: string, options?: ReadWindowOptions): DeepReadonly<ObservationEntry[]>;
    /** 已建立窗口的会话数（health 展示用）。 */
    get size(): number;
    /** 全部窗口的条目总数（health 展示用）。 */
    get buffered(): number;
    /** 全部会话键（health / 排障用）。 */
    keys(): readonly string[];
}
export type createObservationWindowStoreFactory = (policy: ObservationPolicy) => ObservationWindowStore;
/** 滚窗里被选中送入 prompt 的一条媒体：带来源，说明文本才能指认"这是谁发的那张"。 */
export interface WindowMediaRef<T> {
    part: T;
    /** 来自哪条消息（说明文本用 sender + placeholder 指认；这个给排障与测试用） */
    msgId: string;
    /** 发送者显示名（缺省退到 id） */
    sender: string;
    /**
     * 这条媒体在窗口正文里的**原样占位文本**（`[图片: x.jpg]` / `[文件: a.pdf]`）。
     *
     * 说明文本里必须用它指认（而不是"第几张图"这种自造编号）：模型要能把它与
     * `<群聊上下文>` 里那一行**逐字对上**——多个群友都发过图时，没有这个对应关系
     * 就只能猜哪张是谁发的。
     */
    placeholder: string;
}
export interface WindowMediaSelection {
    /** 选中的图片，**时间顺序**（与上下文块一致） */
    images: WindowMediaRef<MessageImagePart>[];
    /** 选中的文件，时间顺序 */
    files: WindowMediaRef<MessageMediaPart>[];
    /** 因配额没被选中的张数 / 个数（说明文本要如实说出来，不能让模型以为只有这些） */
    imagesSkipped: number;
    filesSkipped: number;
}
export interface CollectWindowMediaOptions {
    /** 最多选几张图（缺省 0 = 不选） */
    maxImages?: number;
    /** 最多选几个文件（缺省 0 = 不选） */
    maxFiles?: number;
    /**
     * 已经随**当前这条消息**进来的媒体（url / fileId）。
     *
     * 为什么要排重：同一条消息既被 @ 又带图时它不在窗口里（注入时按 msgId 排除），
     * 但**引用**场景会重叠——用户引用别人那条带图的消息再 @ bot，引用里的图按
     * `messageImageParts` 已经要进来了，而那条被引用的消息十有八九也在窗口里。
     * 送两遍既烧 token，又会让模型以为群里发了两张一样的图。
     */
    exclude?: {
        readonly urls: ReadonlySet<string>;
        readonly fileIds: ReadonlySet<string>;
    };
}
/**
 * 从窗口条目里挑出要随本轮 prompt 送入的媒体（**纯函数**，不下载、不落盘）。
 *
 * 两条排序纪律：
 *   - **从最近往前挑**：被 @ 时最可能指的就是刚发的那张图 / 那个文件
 *     （"看看这个"的对象几乎总是紧邻的上一条），配额不够时先丢老的；
 *   - 选完**反过来**，让送进 prompt 的顺序仍是时间顺序——与 `<群聊上下文>` 的
 *     行序一致，模型对号入座才不用做心理排序。
 *
 * 取不到字节的（既没有 url 也没有 fileId）**直接跳过且不占配额**：它们注定失败，
 * 让它们挤掉能读的图只会把"看不到"从一个换成另一个。同一条媒体在窗口里出现
 * 两次（同一个人重发同一张图）也只取最近的那次。
 */
export type collectWindowMedia = (entries: readonly ObservationEntry[], options?: CollectWindowMediaOptions) => WindowMediaSelection;
/** 窗口里等着被展开的一条聊天记录（最近的优先）。 */
export interface PendingRecordRef {
    /** 平台侧 id：交给 `BotConnector.fetchForward` 回查 */
    refId: string;
    /** 来自哪条消息（说明文本里指认"是谁发的那条"） */
    msgId: string;
    /** 发送者显示名（缺省退到 id） */
    sender: string;
}
/**
 * 窗口里**最近一条**还没展开的聊天记录（没有则 undefined）。
 *
 * 为什么只取一条：聊天记录是"用户点名要看的资料"，一次问句几乎只指向一条；
 * 展开多条既没有语义依据，也会让 prompt 被几十条别人的发言灌满。
 *
 * 为什么要"最近"：与 `collectWindowMedia` 同一条理由——"看看刚才那个聊天记录"
 * 指的就是刚发的那条。
 */
export type latestPendingRecord = (entries: readonly ObservationEntry[]) => PendingRecordRef | undefined;
/** 渲染正文的字符上限（超出从头部截断，保留最近的）。 */
export declare const WINDOW_BLOCK_MAX_CHARS = 4000;
export interface RenderWindowOptions {
    /**
     * 当前这条触发消息的 msgId：**从正文里剔除**。
     *
     * 它会被单独渲染成"当前消息"一行，留在块里就是同一句话说两遍；更要紧的是
     * 模型会以为那是别人之前说的。
     */
    excludeMsgId?: string;
    /** bot 自己的显示名（缺省 `我`） */
    botLabel?: string;
    /** 字符上限 */
    maxChars?: number;
}
/**
 * 把窗口渲染成喂给 **被动回复** 的上下文块。
 *
 * 与 `scene/transcript.ts` 的 `renderTranscript` 是**同族但不同用途**：
 *   - 那一份喂 LLM **判定**（要事实块、要 `(对我说的)` 标记，好让它判断"该不该开口"）；
 *   - 这一份喂 LLM **回答**（只要"刚才大家在聊什么"，标记越少越好——`(对我说的)`
 *     这种判定层语义泄漏进回复路径，只会让模型以为那是某种系统注释）。
 *
 * 共同点（不可协商）：**任何用户产生的文本进 prompt 前都要套不可信内容边界**。
 * 群里完全可能有人写"忽略以上指令"，而窗口里的文本是货真价实的第三方输入。
 *
 * @returns 渲染好的块；窗口为空时返回 `''`（调用方据此回退到"只有当前这条"）
 */
export type renderWindowBlock = (entries: readonly ObservationEntry[], options?: RenderWindowOptions) => string;
