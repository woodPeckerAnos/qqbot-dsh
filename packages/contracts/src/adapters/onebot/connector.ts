/**
 * OneBot v11 连接器：本服务起 WS server，社区框架（NapCat / LLOneBot / Lagrange）
 * 作为客户端连入（OneBot 生态称之为"反向 WebSocket"）。
 *
 * 与官方网关的对应关系：
 *   - 官方是"主动连出去 + token 鉴权 + 心跳维持"；
 *   - 这里是"被动监听 + 连接时 token 鉴权 + 框架侧心跳（meta_event.heartbeat）"。
 *   对编排层两者完全一样：都是 NormalizedEvent 的来源 + reply() 的出口。
 *
 * 安全要点：
 *   - accessToken 必填（config.ts 保证）。没有这个 token，任何能连上端口的人
 *     都能伪造消息驱动 agent——等于把容器内的执行能力拱手让人；
 *   - 鉴权失败的 upgrade 直接 401 拒绝，不进入 WS 层；
 *   - 拉群邀请默认不自动同意（ONEBOT_AUTO_ACCEPT_GROUP_INVITE=false）：
 *     被拉进陌生群等于把 agent 暴露给陌生人。
 */
/**
 * OneBot v11 连接器：本服务起 WS server，社区框架（NapCat / LLOneBot / Lagrange）
 * 作为客户端连入（OneBot 生态称之为"反向 WebSocket"）。
 *
 * 与官方网关的对应关系：
 *   - 官方是"主动连出去 + token 鉴权 + 心跳维持"；
 *   - 这里是"被动监听 + 连接时 token 鉴权 + 框架侧心跳（meta_event.heartbeat）"。
 *   对编排层两者完全一样：都是 NormalizedEvent 的来源 + reply() 的出口。
 *
 * 安全要点：
 *   - accessToken 必填（config.ts 保证）。没有这个 token，任何能连上端口的人
 *     都能伪造消息驱动 agent——等于把容器内的执行能力拱手让人；
 *   - 鉴权失败的 upgrade 直接 401 拒绝，不进入 WS 层；
 *   - 拉群邀请默认不自动同意（ONEBOT_AUTO_ACCEPT_GROUP_INVITE=false）：
 *     被拉进陌生群等于把 agent 暴露给陌生人。
 */
import type { WebSocket } from 'ws';
import type {
  ConnectorHealth,
  ConversationKind,
  ConversationTarget,
  MediaBytes,
  MediaFetchOptions,
  MessageForwardPart,
  NormalizedEvent,
  OutgoingMessage,
  ProactiveResult,
  RemoteMedia,
  ReplyContext,
  ReplyPolicy,
} from '../../core/connector.js';
import type { ForwardConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { ONEBOT_PLATFORM } from './normalize.js';
export { ONEBOT_PLATFORM };
export interface OnebotConnectorOptions {
  host: string;
  port: number;
  accessToken: string;
  acceptsC2C: boolean;
  autoAcceptFriend: boolean;
  autoAcceptGroupInvite: boolean;
  /** 回复策略（群聊与单聊相同——OneBot 没有官方那种按会话类型的配额差） */
  replyPolicy: ReplyPolicy;
  /**
   * 附件字节怎么传给框架（ONEBOT_FILE_TRANSPORT / onebot.fileTransport）：
   *   - `base64`（默认）：文件内容编码进 WS 帧，跨容器部署也能用；
   *   - `path`：只传绝对路径，要求 bot 与框架同机同文件系统（省 33% 体积）。
   */
  fileTransport?: 'base64' | 'path';
  /**
   * 转发消息块（合并转发 / 聊天记录）的展开配额（config.attachments.forward）。
   * 缺省或 `enabled: false` 时不做任何回查，行为退回 `[聊天记录]` 占位。
   */
  forward?: ForwardConfig;
  /**
   * 转发块回查结果上报（用于 /metrics 计数）。
   *
   * 用回调而不是 import PipelineStats：接入层不认识编排层的统计对象，
   * 这条边界与"编排层不 import adapters/*"是对称的。
   */
  onForward?: (info: { ok: boolean; nodes: number }) => void;
  logger: Logger;
  /** 动作响应等待超时（毫秒） */
  actionTimeoutMs?: number;
  now?: () => number;
  /** Inject the authenticated socket channel for deterministic contract tests. */
  transport?: {
    start(onConnection: (socket: WebSocket) => void): Promise<void>;
    stop(): Promise<void>;
  };
}
export interface OnebotConnector {
  readonly platform: 'onebot';
  get acceptsC2C(): boolean;
  on(handler: (event: NormalizedEvent) => void): () => void;
  policy(_kind: ConversationKind): ReplyPolicy;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): ConnectorHealth;
  reply(ctx: ReplyContext, out: OutgoingMessage): Promise<void>;
  canReply(target: ConversationTarget): boolean;
  /**
   * 【主动发言能力】OneBot 没有"被动窗口/主动额度"概念：任何时刻都能往群里发。
   * 所以这里只需把"没有 msg_id 可锚定"这件事表达成一次普通发送——
   * 复用 sendText，只是自造一个主动语义的 ReplyContext（seq 用 0）。
   *
   * 外层（pipeline/proactive）对两个平台走的是同一条逻辑，分支只在这里。
   */
  proactive(target: ConversationTarget, out: OutgoingMessage): Promise<ProactiveResult>;
  /**
   * 取消息附件（当前主要是图片）的字节。
   *
   * 为什么需要平台侧实现而不是普通 GET：NapCat 的图片 URL 约 2 小时过期
   * （`url expired`），且有头形态的图片段经常只带文件标识（file 字段是本地
   * 路径或内部 id）不带 URL。所以顺序是：
   *   1. 有 http(s) URL 先普通 GET（无需鉴权）；
   *   2. 失败或无 URL 时用文件标识回查：`get_file`（NapCat 扩展，可直接返回
   *      base64 或刷新后的 url），失败再试 `get_image`（OneBot 标准）；
   *   3. 回查只给到**宿主本地路径**时放弃——容器够不到宿主的文件系统。
   *
   * 任何一步失败都返回 undefined（由编排层降级成文字说明），绝不抛错打断整轮。
   */
  fetchMedia(media: RemoteMedia, options: MediaFetchOptions): Promise<MediaBytes | undefined>;
  /**
   * 【按需展开】取一条聊天记录（合并转发）的内容。
   *
   * 与 `fetchMedia` 同一类能力，差别在"什么时候需要"：@ 消息里的转发在归一化后
   * 立刻由连接器展开（`enrichEvent`），而**旁听**消息里的转发**不进 content**
   * （一条转发动辄几十条发言，当普通上下文灌进去会烧掉大量 token），只把 id 留在
   * 观察窗口里；被 @ 且这次的问题明确提到它时，才由编排层回调到这里（见
   * `core/connector.ts` 的 `fetchForward` 说明）。
   *
   * 复用既有回查通路：同一套上限（`newForwardBudget`）、同一个 LRU 缓存、同一条
   * 每会话串行队列。任何失败都返回 undefined，**绝不抛错**。
   */
  fetchForward(target: ConversationTarget, refId: string): Promise<MessageForwardPart | undefined>;
}
export type createOnebotConnectorFactory = (options: OnebotConnectorOptions) => OnebotConnector;
