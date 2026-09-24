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
  content: string;
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
}

// ---------------------------------------------------------------------------
// 回复
// ---------------------------------------------------------------------------

export type OutgoingKind = 'progress' | 'final' | 'error';

/** 编排层给出的回复内容。text 是 agent 原始输出（可能是 Markdown）。 */
export interface OutgoingMessage {
  text: string;
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
}
