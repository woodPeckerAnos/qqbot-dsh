/**
 * 接入层核心抽象：平台无关的连接器契约。
 *
 * 为什么需要这一层：
 *   官方开放平台（api.bot.qq.com）与社区框架（NapCat / LLOneBot / Lagrange 等
 *   OneBot v11 实现）在事件形状、回复语义、配额约束上完全不同，但编排层
 *   （去重、串行、并发闸门、进度回执、冷启动回放、runtime 池）与平台无关。
 *   本文件定义的就是两侧之间的唯一接缝：
 *
 *     适配器（adapters/*） ──NormalizedEvent──▶ 编排层（pipeline/*）
 *     适配器 ◀──reply(ReplyContext, OutgoingMessage)── 编排层
 *
 * 设计约束：
 *   - 编排层只允许 import 本文件与 reply.ts，不允许 import 任何 adapters/* 内部；
 *   - 平台专有行为（msg_seq、markdown 请求体、被动窗口、CQ 码）全部留在适配器内；
 *   - 会话键 key 的构造归各适配器所有（官方保持裸 openid 以兼容既有部署，
 *     OneBot 用 `ob11:g<id>` / `ob11:u<id>` 前缀隔离命名空间），
 *     存储层与编排层一律把 key 当不透明字符串。
 */

// ---------------------------------------------------------------------------
// 会话目标
// ---------------------------------------------------------------------------

export type ConversationKind = 'group' | 'c2c';

/**
 * 一次对话的寻址信息。
 *
 * - `platform`：接入平台标识（等于产生该事件的 connector.platform），
 *   编排层按它把回复路由回正确的连接器；
 * - `id`：平台侧的会话 id（官方是 openid，OneBot 是群号/QQ 号字符串），
 *   适配器发送消息时使用；
 * - `key`：编排层的会话命名空间键，同时用作工作区目录、对话记录、
 *   会话映射、串行锁与 runtime 池的键。不同平台的 key 必须不会碰撞。
 */
export interface ConversationTarget {
  platform: string;
  kind: ConversationKind;
  id: string;
  key: string;
}

// ---------------------------------------------------------------------------
// 归一化事件（适配器对外只吐这一种形状）
// ---------------------------------------------------------------------------

/**
 * 一条用户消息里的内容片段（平台无关）。
 *
 * 为什么需要这一层：官方开放平台与 OneBot 对"图片 / 语音 / 引用 / 卡片"的表达
 * 完全不同（官方是 attachments + msg_elements，OneBot 是消息段数组），但编排层
 * 需要的是同一种东西——"这条消息有哪些可读内容、要送几张图给模型"。适配器负责
 * 把平台专有结构翻译成这里的片段，编排层（TurnRunner）再把它翻译成 DSH 的
 * prompt content blocks。
 *
 * 关键设计：
 *   - 片段里**只放引用信息**（url / 文本），不放字节。下载字节是 IO，放在 turn 期
 *     做（见 dsh/media.ts），这样被闸拦掉的消息不会白白下载图片；
 *   - `quote` 是递归结构：引用消息自己也可能带图片（官方 msg_elements 支持嵌套）。
 */
export interface MessageTextPart {
  type: 'text';
  text: string;
}

/** 图片：url 指向平台侧可下载地址，真正取字节由 BotConnector.fetchMedia 完成 */
export interface MessageImagePart {
  type: 'image';
  /**
   * 平台侧可下载地址（http/https）。可能缺失：NapCat 有头形态的图片段经常只给
   * 文件标识（`file` 字段是本地路径或内部 id），此时只能靠 fetchMedia 经
   * 平台动作（get_file/get_image）取字节。
   */
  url?: string;
  /**
   * 平台侧文件标识（OneBot image 段的 `file` 原值）。url 缺失或过期时，
   * 适配器用它回查文件（NapCat 图片 URL 约 2 小时过期，需要刷新）。
   */
  fileId?: string;
  /** 平台声明的 MIME（可能不准，实际以响应头与字节嗅探为准） */
  mimeType?: string;
  filename?: string;
  /**
   * 平台声明的像素尺寸（官方 attachments 会给；OneBot 通常没有）。
   *
   * 只用来在下载**之前**挡掉明显超过 runtime 准入上限的图（长截图很常见），
   * 省一次下载；真实像素仍以 runtime 准入为准，被拒时走纯文本回退。
   */
  width?: number;
  height?: number;
}

/** 语音：官方会直接给 ASR 文本（asr_refer_text），有文本就不必再下载音频 */
export interface MessageVoicePart {
  type: 'voice';
  url?: string;
  /** 平台侧语音识别结果，存在时直接作为可读内容 */
  text?: string;
  filename?: string;
}

/** 其他附件：视频 / 文件等。模型不吃这些，渲染成一行文字说明。 */
export interface MessageMediaPart {
  type: 'media';
  mediaKind: 'video' | 'file' | 'unknown';
  url?: string;
  filename?: string;
  sizeBytes?: number;
}

/**
 * 引用（回复）消息。
 *
 * 官方 `message_type=103` 时把被引用的内容放在 `msg_elements` 里；OneBot 的
 * `reply` 段只有消息 id，需要额外回查（见 adapters/onebot/connector.ts）。
 */
export interface MessageQuotePart {
  type: 'quote';
  /** 被引用消息的发送者显示名（平台给出时才有） */
  author?: string;
  parts: MessagePart[];
}

export type MessagePart =
  | MessageTextPart
  | MessageImagePart
  | MessageVoicePart
  | MessageMediaPart
  | MessageQuotePart;

/** 需要平台侧取字节的远端媒体（fetchMedia 的入参） */
export interface RemoteMedia {
  /** http/https 下载地址；可能缺失（见 MessageImagePart.url） */
  url?: string;
  /** 平台侧文件标识；url 缺失或过期时适配器用它回查 */
  fileId?: string;
  mimeType?: string;
  filename?: string;
}

export interface MediaFetchOptions {
  /** 允许的最大字节数；超过时实现应放弃并返回 undefined */
  maxBytes: number;
  timeoutMs: number;
}

export interface MediaBytes {
  data: Uint8Array;
  /** 响应头给出的 MIME（可信度高于平台事件里的声明） */
  mimeType?: string;
}

/**
 * 归一化后的用户消息。
 *
 * 各平台的群聊/单聊消息都归一化成这个形状，编排层只有一条代码路径。
 * 平台专有的字段（消息段、附件等）放在 raw 里，编排层不解读。
 */
export interface NormalizedMessage {
  kind: 'group-at-message' | 'c2c-message';
  target: ConversationTarget;
  /**
   * 事件级去重 id。适配器必须保证它在平台内唯一且已带平台命名空间
   * （例如 OneBot 用 `ob11:<self_id>:<message_id>`），因为去重表是全局共用的。
   */
  eventId: string;
  /** 消息 id。需要「被动回复锚点」的平台（官方 QQ）在回复时回传它。 */
  msgId: string;
  /** 发送者 id：官方是 member/user openid，OneBot 是 QQ 号字符串 */
  senderId: string;
  username?: string;
  /**
   * 可读的纯文本形态（由 parts 扁平化而来，见 core/content.ts）。
   *
   * 它同时是：对话记录 / 冷启动回放的正文、管理员命令的匹配对象、日志内容。
   * 注意"只有图片、没有文字"的消息 content 也不为空（至少是 `[图片]`），
   * 否则记录与回放会丢掉这条消息发生过的事实。
   */
  content: string;
  /**
   * 结构化内容片段。缺省表示"适配器只归一化出了文本"（兼容既有部署与测试），
   * 此时编排层按 `content` 处理。
   */
  parts?: MessagePart[];
  /** 毫秒时间戳 */
  ts: number;
  /** 原始事件，便于排障与将来扩展 */
  raw: Record<string, unknown>;
}

export interface NormalizedSystemEvent {
  kind:
    | 'ready'
    | 'resumed'
    | 'connected'
    | 'disconnected'
    | 'group-add-robot'
    | 'c2c-friend-add';
  at: number;
  reason?: string;
  /** 需要主动回一条问候语时的目标（进群 / 加好友事件） */
  target?: ConversationTarget;
  /** 事件信封 id（官方 QQ 的进群/加好友事件用它做 event_id 回复） */
  eventId?: string;
  raw?: Record<string, unknown>;
}

export type NormalizedEvent = NormalizedMessage | NormalizedSystemEvent;

/** 是否为用户消息（群聊或单聊），用于把消息事件与系统事件分开。 */
export function isUserMessage(event: NormalizedEvent): event is NormalizedMessage {
  return event.kind === 'group-at-message' || event.kind === 'c2c-message';
}

// ---------------------------------------------------------------------------
// 连接器契约
// ---------------------------------------------------------------------------

/** 连接器的健康状态。`detail` 放平台专有信息（如 token 状态、已接入的 self_id）。 */
export interface ConnectorHealth {
  connected: boolean;
  /** 平台自定义的状态词（如官方网关的 ready/resuming，OneBot 的 listening） */
  state: string;
  lastEventAt?: number;
  reconnectAttempts?: number;
  /** 适配器自己判断的告警（如「尚未取得 access_token」），health 聚合并原样展示 */
  warnings?: string[];
  detail?: Record<string, unknown>;
}

/**
 * 一个接入平台的连接实例。
 *
 * 生命周期由 main.ts 统一管理：start() 建立事件通道，stop() 必须能让
 * start() 的在途 promise 落定（官方网关的 stopSignal 竞态教训见 gateway.ts）。
 */
export interface BotConnector {
  /** 平台标识，全进程唯一；同时是 ConversationTarget.platform 与回复路由键 */
  readonly platform: string;
  /**
   * 是否响应单聊（c2c）消息。
   * 订阅层往往无法只收群聊（官方是 intent 粒度，OneBot 是框架推送粒度），
   * 所以"只服务群聊"在业务层用这个开关拦。
   */
  readonly acceptsC2C: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 订阅归一化事件；返回退订函数 */
  on(handler: (event: NormalizedEvent) => void): () => void;
  health(): ConnectorHealth;
  /** 该平台某类会话的回复策略（配额、分段、进度、单轮超时） */
  policy(kind: ConversationKind): ReplyPolicy;
  /** 发送一条回复。平台专有的请求体构造在适配器内部完成。 */
  reply(ctx: ReplyContext, out: OutgoingMessage): Promise<void>;
  /**
   * 取平台侧附件的字节（图片/语音等）。
   *
   * 存在的理由是"鉴权差异"：官方 QQ 的多媒体 CDN 需要 `Authorization: QQBot <token>`，
   * 而 OneBot 的图片地址通常是框架自带的 HTTP 服务、无需鉴权。把这件事留在适配器里，
   * 编排层就不必知道任何平台的取字节方式。
   *
   * 缺省（未实现）时编排层直接用 url 发一次普通 GET。实现必须遵守 maxBytes 与
   * timeoutMs，失败时返回 undefined（由调用方降级成文字说明），不要抛错打断整轮。
   */
  fetchMedia?(media: RemoteMedia, options: MediaFetchOptions): Promise<MediaBytes | undefined>;
}

// ---------------------------------------------------------------------------
// 回复
// ---------------------------------------------------------------------------

export type OutgoingKind = 'progress' | 'final' | 'error';

/**
 * 一个待发送的附件（agent 在会话工作区里的产物）。
 *
 * 编排层只说"发什么"，怎么发（官方两步上传、OneBot 消息段）是适配器的事。
 * 安全不变量由编排层保证（见 pipeline/egress/outbox.ts）：
 * `absPath` 必须 realpath 后仍落在该会话工作区的 outbox 目录内。
 */
export interface OutgoingAttachment {
  /** audio/video 预留，本期只做这两种 */
  kind: 'image' | 'file';
  /** 已通过工作区包含性校验的绝对路径 */
  absPath: string;
  /** 发送时展示的文件名（不含目录） */
  fileName: string;
  sizeBytes: number;
}

/**
 * 编排层给出的回复内容。text 是 agent 原始输出（可能是 Markdown）。
 *
 * attachments 与 text 的关系由发送方（Responder）决定：一次 reply() 调用
 * 要么只有 text、要么只带一个附件——因为官方平台"一次 reply = 一个 msg_seq"
 * 的账本语义装不下混合消息（见 pipeline/egress/responder.ts）。
 */
export interface OutgoingMessage {
  text: string;
  attachments?: OutgoingAttachment[];
}

/**
 * 一次回复的上下文。
 *
 * - `msgId` / `eventId`：需要被动回复锚点的平台使用（官方 QQ：两者互斥，
 *   回复提问用 msgId，回复进群/加好友用 eventId）；无此概念的平台直接忽略。
 * - `seq`：针对同一条用户消息的第几条回复，从 1 单调递增（由编排层的
 *   配额账本统一分配）。官方 QQ 把它映射为 msg_seq 做平台去重；
 *   无 seq 概念的平台直接忽略。
 */
export interface ReplyContext {
  target: ConversationTarget;
  msgId?: string;
  eventId?: string;
  seq: number;
  kind: OutgoingKind;
}

/**
 * 一个平台（按会话类型）的回复策略。
 *
 * 这是「自由度差异」的显式表达：
 *   - 官方 QQ：被动窗口 5 分钟、每条消息最多回 5（群）/4（单聊）条，
 *     所以 turnTimeoutMs 必须压在窗口内，配额必须当稀缺资源分配；
 *   - OneBot：无窗口、无平台级配额，maxRepliesPerMsg 只是防失控的安全阀，
 *     turnTimeoutMs 可以放宽到任务真正需要的时长。
 */
export interface ReplyPolicy {
  /** 单条消息最大字符数（分段依据） */
  maxChars: number;
  /** 针对一条用户消息的最大回复条数（含进度回执） */
  maxRepliesPerMsg: number;
  /** 进度回执条数上限，必须 < maxRepliesPerMsg */
  progressMax: number;
  /** turn 开始多久后发第一条进度回执 */
  progressAfterMs: number;
  /** 进度回执间隔 */
  progressIntervalMs: number;
  /** 该平台允许的单轮超时（毫秒） */
  turnTimeoutMs: number;
  /**
   * 被动回复窗口（毫秒）：一条用户消息到达后，多久之内还能用它的 msg_id 作锚点
   * 主动补发消息（算被动回复，不消耗稀缺的主动消息额度）。
   *
   * 后台任务完成时若仍在窗口内、且该 msg_id 的回复配额未用尽，就能把结果
   * "即时投递"出去，而不必干等用户下一条消息（见 pipeline/egress/background.ts）。
   *   - 官方群聊 5 分钟、单聊 60 分钟（平台硬约束）；
   *   - OneBot 无窗口，用 Number.POSITIVE_INFINITY 表示"永远可主动发"。
   */
  passiveWindowMs: number;
}
