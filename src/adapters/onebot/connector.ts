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

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, WebSocket } from 'ws';

import type {
  BotConnector,
  ConnectorHealth,
  ConversationKind,
  MediaBytes,
  MediaFetchOptions,
  MessageQuotePart,
  NormalizedEvent,
  NormalizedMessage,
  OutgoingAttachment,
  OutgoingMessage,
  RemoteMedia,
  ReplyContext,
  ReplyPolicy,
} from '../../core/connector.js';
import { flattenParts } from '../../core/content.js';
import type { Logger } from '../../logger.js';
import { normalizeWhitespace, stripControlChars, toPlainText } from '../../pipeline/markdown.js';
import {
  normalizeOneBotEvent,
  ONEBOT_PLATFORM,
  quotedAuthorFromGetMsg,
  quotedPartsFromGetMsg,
  type NormalizeResult,
} from './normalize.js';
import type { OneBotActionResponse, OneBotEvent } from './types.js';

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
  logger: Logger;
  /** 动作响应等待超时（毫秒） */
  actionTimeoutMs?: number;
  now?: () => number;
}

/** 一条已鉴权的框架连接 */
interface Session {
  socket: WebSocket;
  /** 从事件的 self_id 学到（框架连接后第一条事件起携带） */
  selfId?: number;
  connectedAt: number;
  lastEventAt?: number;
}

class OnebotActionError extends Error {
  constructor(
    message: string,
    readonly retcode?: number,
  ) {
    super(message);
    this.name = 'OnebotActionError';
  }
}

export class OnebotConnector implements BotConnector {
  readonly platform = ONEBOT_PLATFORM;

  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private readonly sessions = new Set<Session>();
  /** 会话键 → 最近投递过该会话事件的连接（回复路由用） */
  private readonly conversationSessions = new Map<string, Session>();
  private readonly pending = new Map<
    string,
    { session: Session; resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly emitterHandlers = new Set<(event: NormalizedEvent) => void>();
  /**
   * 每条连接上的异步补全队列（当前只有"回查引用消息"）。
   * 保证补全后的事件顺序与到达顺序一致——否则一条被引用消息可能插到后一条消息之后。
   */
  private readonly sessionQueues = new WeakMap<Session, Promise<void>>();
  private startedAt = 0;
  private stopping = false;

  constructor(private readonly options: OnebotConnectorOptions) {}

  get acceptsC2C(): boolean {
    return this.options.acceptsC2C;
  }

  on(handler: (event: NormalizedEvent) => void): () => void {
    this.emitterHandlers.add(handler);
    return () => this.emitterHandlers.delete(handler);
  }

  policy(_kind: ConversationKind): ReplyPolicy {
    return this.options.replyPolicy;
  }

  async start(): Promise<void> {
    if (this.server !== undefined) return;
    this.stopping = false;
    this.startedAt = this.now();

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (socket: WebSocket) => this.onConnection(socket));

    this.server = createServer((req, res) => {
      // 本端口只服务 WS upgrade；普通 HTTP 请求给个明确答复，便于排障
      res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OneBot reverse WebSocket endpoint. 请在框架侧配置 ws://<host>:<port>/ 并升级连接。\n');
      void req;
    });

    this.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!this.checkAuth(req)) {
        this.options.logger.warn('OneBot 连接鉴权失败，已拒绝', {
          remote: req.socket.remoteAddress,
          url: req.url,
        });
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss?.handleUpgrade(req, socket, head, (ws) => {
        this.wss?.emit('connection', ws, req);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.options.port, this.options.host, () => resolve());
    });
    this.options.logger.info('OneBot 反向 WS 已监听', {
      host: this.options.host,
      port: this.options.port,
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const session of this.sessions) {
      try {
        session.socket.close(1001, 'server shutdown');
      } catch {
        /* 已断开 */
      }
    }
    this.sessions.clear();
    this.conversationSessions.clear();
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new OnebotActionError('连接器正在关闭'));
    }
    this.pending.clear();

    const wss = this.wss;
    this.wss = undefined;
    if (wss !== undefined) {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  health(): ConnectorHealth {
    const clients = [...this.sessions];
    const anyClient = clients.some((s) => s.selfId !== undefined);
    const lastEventAt = clients.reduce<number | undefined>(
      (acc, s) => (s.lastEventAt !== undefined && (acc === undefined || s.lastEventAt > acc) ? s.lastEventAt : acc),
      undefined,
    );
    const warnings: string[] = [];
    if (!anyClient) {
      warnings.push('尚无框架客户端连入（检查 NapCat/LLOneBot 的反向 WS 配置与 token）');
    }
    // 服务端连接器的"通道已建立"= 监听中。客户端连不连得上是框架侧的事，
    // 重启本服务帮不上忙（也不该因此触发容器重启循环），所以没有客户端只告警。
    const listening = this.server !== undefined;
    return {
      connected: listening,
      state: listening ? (anyClient ? 'connected' : 'listening') : 'stopped',
      ...(lastEventAt !== undefined ? { lastEventAt } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      detail: {
        listen: `${this.options.host}:${this.options.port}`,
        uptimeMs: this.now() - this.startedAt,
        clients: clients.map((s) => ({
          selfId: s.selfId,
          connectedAt: s.connectedAt,
          lastEventAt: s.lastEventAt,
        })),
      },
    };
  }

  async reply(ctx: ReplyContext, out: OutgoingMessage): Promise<void> {
    const session = this.pickSession(ctx.target.key);
    const attachments = out.attachments ?? [];

    // 附件与文本分条发送（Responder 保证一次 reply 要么纯文本、要么一个附件；
    // 这里的文本分支兜底"两者都有"的防御场景）。
    // OneBot 其实支持 text+image 混合消息段，合并能省消息条数，但编排层的
    // 账本语义是"一次 reply = 一条消息"，且附件需要逐个隔离失败——
    // OneBot 配额足够宽（默认 10），分条没有实际代价。
    const text = normalizeWhitespace(stripControlChars(toPlainText(out.text)));
    // 无附件时保持旧行为（哪怕空文本也发，交给平台判定）；有附件时空文本不再发。
    if (text !== '' || attachments.length === 0) {
      await this.sendText(session, ctx, text);
    }
    for (const attachment of attachments) {
      await this.sendAttachment(session, ctx, attachment);
    }
  }

  private async sendText(
    session: Session,
    ctx: ReplyContext,
    text: string,
  ): Promise<void> {
    const message = [{ type: 'text', data: { text } }];
    const data =
      ctx.target.kind === 'c2c'
        ? await this.callAction(session, 'send_private_msg', {
            user_id: Number(ctx.target.id),
            message,
          })
        : await this.callAction(session, 'send_group_msg', {
            group_id: Number(ctx.target.id),
            message,
          });
    this.options.logger.debug('OneBot 消息已发送', {
      conversation: ctx.target.key,
      kind: ctx.kind,
      seq: ctx.seq,
      length: text.length,
      messageId: (data as { message_id?: number } | null)?.message_id,
    });
  }

  /**
   * 发一个附件：图片走消息段（客户端内联展示），其余走群/私聊文件上传动作。
   *
   * file 参数的两种形态见 options.fileTransport 的注释。注意 ws 库的 maxPayload
   * 默认 100MiB，与全局 media.maxFileMB 上限联动（base64 后 +33%）。
   */
  private async sendAttachment(
    session: Session,
    ctx: ReplyContext,
    attachment: OutgoingAttachment,
  ): Promise<void> {
    const file = await this.encodeAttachment(attachment);
    if (attachment.kind === 'image') {
      const message = [{ type: 'image', data: { file } }];
      const data =
        ctx.target.kind === 'c2c'
          ? await this.callAction(session, 'send_private_msg', {
              user_id: Number(ctx.target.id),
              message,
            })
          : await this.callAction(session, 'send_group_msg', {
              group_id: Number(ctx.target.id),
              message,
            });
      this.options.logger.debug('OneBot 图片已发送', {
        conversation: ctx.target.key,
        fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes,
        messageId: (data as { message_id?: number } | null)?.message_id,
      });
      return;
    }
    const params =
      ctx.target.kind === 'c2c'
        ? { user_id: Number(ctx.target.id), file, name: attachment.fileName }
        : { group_id: Number(ctx.target.id), file, name: attachment.fileName };
    await this.callAction(
      session,
      ctx.target.kind === 'c2c' ? 'upload_private_file' : 'upload_group_file',
      params,
    );
    this.options.logger.debug('OneBot 文件已上传', {
      conversation: ctx.target.key,
      fileName: attachment.fileName,
      sizeBytes: attachment.sizeBytes,
    });
  }

  /** 按 fileTransport 编码附件：base64:// URI 或绝对路径。 */
  private async encodeAttachment(attachment: OutgoingAttachment): Promise<string> {
    if ((this.options.fileTransport ?? 'base64') === 'path') return attachment.absPath;
    const data = await readFile(attachment.absPath);
    return `base64://${data.toString('base64')}`;
  }

  // -------------------------------------------------------------------------
  // 连接生命周期
  // -------------------------------------------------------------------------

  private checkAuth(req: IncomingMessage): boolean {
    const header = req.headers['authorization'];
    if (typeof header === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (match !== null && match[1] === this.options.accessToken) return true;
    }
    // 部分框架只支持 query 形式
    const url = req.url ?? '';
    const token = /[?&]access_token=([^&]+)/.exec(url)?.[1];
    return token !== undefined && decodeURIComponent(token) === this.options.accessToken;
  }

  private onConnection(socket: WebSocket): void {
    const session: Session = { socket, connectedAt: this.now() };
    this.sessions.add(session);
    this.options.logger.info('OneBot 客户端已连入', { total: this.sessions.size });

    socket.on('message', (data: WebSocket.RawData) => this.onFrame(session, data));
    socket.on('close', () => {
      this.sessions.delete(session);
      for (const [key, value] of this.conversationSessions) {
        if (value === session) this.conversationSessions.delete(key);
      }
      // 断连时把该连接上在途的动作全部失败掉，避免调用方永远挂起
      for (const [echo, entry] of this.pending) {
        if (entry.session === session) {
          clearTimeout(entry.timer);
          this.pending.delete(echo);
          entry.reject(new OnebotActionError('连接已断开'));
        }
      }
      this.emit({ kind: 'disconnected', at: this.now(), reason: 'onebot client closed' });
      this.options.logger.warn('OneBot 客户端断开', { total: this.sessions.size, selfId: session.selfId });
    });
    socket.on('error', (error) => {
      this.options.logger.warn('OneBot 连接错误', { error: error.message });
    });
  }

  private onFrame(session: Session, data: WebSocket.RawData): void {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.options.logger.warn('OneBot 帧不是合法 JSON', { preview: text.slice(0, 200) });
      return;
    }

    // 动作响应：带 echo 且没有 post_type
    if (typeof payload['echo'] === 'string' && payload['post_type'] === undefined) {
      this.onActionResponse(payload as unknown as OneBotActionResponse);
      return;
    }

    session.lastEventAt = this.now();
    const result = normalizeOneBotEvent(payload as unknown as OneBotEvent, () => this.now());
    this.handleNormalized(session, result);
  }

  private handleNormalized(session: Session, result: NormalizeResult): void {
    switch (result.type) {
      case 'event': {
        // 从事件的 raw 里学 self_id（每条 OneBot 事件都带）
        const rawSelfId = (result.event.raw as { self_id?: number } | undefined)?.self_id;
        if (typeof rawSelfId === 'number') session.selfId = rawSelfId;
        const target = result.event.target;
        if (target !== undefined) this.conversationSessions.set(target.key, session);

        // 引用消息（reply 段）只带消息 id，内容要回查 get_msg 才能拿到。
        // 回查是异步的，而 emit 的顺序会影响"同一会话里哪条消息先进入 turn"，
        // 所以按会话排队，保证补全前后的事件顺序与到达顺序一致。
        if (result.quotedMessageId !== undefined && isMessage(result.event)) {
          const event = result.event;
          const quotedMessageId = result.quotedMessageId;
          this.enqueue(session, async () => {
            this.emit(await this.withQuotedContent(session, event, quotedMessageId));
          });
          return;
        }
        this.emit(result.event);
        return;
      }
      case 'lifecycle': {
        session.selfId = result.selfId;
        this.options.logger.info('OneBot 框架已就绪', { selfId: result.selfId });
        this.emit({ kind: 'connected', at: this.now() });
        return;
      }
      case 'heartbeat': {
        if (result.selfId !== 0) session.selfId = result.selfId;
        return;
      }
      case 'friend-request': {
        if (!this.options.autoAcceptFriend) {
          this.options.logger.info('收到加好友请求，未自动同意（ONEBOT_AUTO_ACCEPT_FRIEND=false）', {
            userId: result.userId,
          });
          return;
        }
        this.options.logger.info('自动同意加好友请求', { userId: result.userId });
        void this.callAction(session, 'set_friend_add_request', {
          flag: result.flag,
          approve: true,
        }).catch((error: unknown) => {
          this.options.logger.warn('同意加好友请求失败', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }
      case 'group-invite': {
        if (!this.options.autoAcceptGroupInvite) {
          this.options.logger.warn('收到拉群邀请，未自动同意（ONEBOT_AUTO_ACCEPT_GROUP_INVITE=false）', {
            groupId: result.groupId,
            inviter: result.userId,
          });
          return;
        }
        this.options.logger.warn('自动同意拉群邀请', { groupId: result.groupId, inviter: result.userId });
        void this.callAction(session, 'set_group_add_request', {
          flag: result.flag,
          sub_type: 'invite',
          approve: true,
        }).catch((error: unknown) => {
          this.options.logger.warn('同意拉群邀请失败', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }
      case 'ignored':
        this.options.logger.debug('忽略 OneBot 事件', { reason: result.reason });
        return;
    }
  }

  // -------------------------------------------------------------------------
  // 引用消息补全（reply 段 → get_msg 回查）
  // -------------------------------------------------------------------------

  /** 按会话串行执行异步补全，保持事件顺序。 */
  private enqueue(session: Session, task: () => Promise<void>): void {
    const previous = this.sessionQueues.get(session) ?? Promise.resolve();
    const next = previous.then(task, task).catch((error: unknown) => {
      this.options.logger.warn('OneBot 事件补全失败（该条消息按原文继续处理）', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.sessionQueues.set(session, next);
  }

  /**
   * 用 get_msg 回查被引用的消息，把内容并成 `quote` 片段。
   *
   * 失败一律降级：拿不到引用内容就按原消息处理（并记 warn），
   * 绝不因为"引用查不到"把用户这条消息丢掉。
   */
  private async withQuotedContent(
    session: Session,
    event: NormalizedMessage,
    quotedMessageId: string,
  ): Promise<NormalizedMessage> {
    const numericId = Number(quotedMessageId);
    try {
      const data = await this.callAction(session, 'get_msg', {
        message_id: Number.isFinite(numericId) ? numericId : quotedMessageId,
      });
      const parts = quotedPartsFromGetMsg(data, session.selfId ?? 0);
      if (parts.length === 0) return event;
      const author = quotedAuthorFromGetMsg(data);
      const quote: MessageQuotePart = {
        type: 'quote',
        ...(author !== undefined ? { author } : {}),
        parts,
      };
      const merged = [quote, ...(event.parts ?? [])];
      return { ...event, parts: merged, content: flattenParts(merged) };
    } catch (error) {
      this.options.logger.warn('回查引用消息失败（按未引用处理）', {
        quotedMessageId,
        conversation: event.target.key,
        error: error instanceof Error ? error.message : String(error),
      });
      return event;
    }
  }

  // -------------------------------------------------------------------------
  // 动作调用
  // -------------------------------------------------------------------------

  private pickSession(conversationKey: string): Session {
    const routed = this.conversationSessions.get(conversationKey);
    if (routed !== undefined && this.sessions.has(routed)) return routed;
    // 兜底：任意一条已学到 self_id 的连接；再没有就任意连接
    for (const session of this.sessions) {
      if (session.selfId !== undefined) return session;
    }
    const any = [...this.sessions][0];
    if (any === undefined) {
      throw new OnebotActionError('没有已连入的 OneBot 客户端，无法发送消息');
    }
    return any;
  }

  private callAction(
    session: Session,
    action: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (session.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new OnebotActionError('连接不可用（非 OPEN 状态）'));
    }
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new OnebotActionError(`动作 ${action} 等待响应超时`));
      }, this.options.actionTimeoutMs ?? 15_000);
      timer.unref?.();
      this.pending.set(echo, { session, resolve, reject, timer });
      session.socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (error !== undefined && error !== null) {
          clearTimeout(timer);
          this.pending.delete(echo);
          reject(new OnebotActionError(`发送动作 ${action} 失败：${error.message}`));
        }
      });
    });
  }

  private onActionResponse(response: OneBotActionResponse): void {
    const echo = response.echo;
    if (echo === undefined) return;
    const entry = this.pending.get(echo);
    if (entry === undefined) return;
    this.pending.delete(echo);
    clearTimeout(entry.timer);
    const retcode = response.retcode ?? (response.status === 'ok' || response.status === 'async' ? 0 : -1);
    if (retcode === 0) {
      entry.resolve(response.data);
      return;
    }
    entry.reject(
      new OnebotActionError(
        `动作失败（retcode=${retcode}）：${response.wording ?? response.message ?? '未知错误'}`,
        retcode,
      ),
    );
  }

  private emit(event: NormalizedEvent): void {
    for (const handler of this.emitterHandlers) handler(event);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  // -------------------------------------------------------------------------
  // 媒体取字节（BotConnector.fetchMedia）
  // -------------------------------------------------------------------------

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
  async fetchMedia(media: RemoteMedia, options: MediaFetchOptions): Promise<MediaBytes | undefined> {
    if (media.url !== undefined) {
      const direct = await this.httpGet(media.url, options);
      if (direct !== undefined) return direct;
    }
    if (media.fileId === undefined) return undefined;

    // get_file：NapCat 扩展动作（file_id 或 file 二选一），可能直接给 base64。
    const viaGetFile = await this.fetchViaFileAction('get_file', media.fileId, options);
    if (viaGetFile !== undefined) return viaGetFile;
    // get_image：OneBot 标准动作，NapCat 返回刷新后的 url 或本地路径。
    return this.fetchViaFileAction('get_image', media.fileId, options);
  }

  /** 经 get_file / get_image 回查取字节；动作不支持或返回不可用时返回 undefined。 */
  private async fetchViaFileAction(
    action: 'get_file' | 'get_image',
    fileId: string,
    options: MediaFetchOptions,
  ): Promise<MediaBytes | undefined> {
    let session: Session;
    try {
      session = this.pickAnySession();
    } catch {
      return undefined;
    }
    let data: Record<string, unknown>;
    try {
      const result = await this.callAction(session, action, { file: fileId });
      if (typeof result !== 'object' || result === null) return undefined;
      data = result as Record<string, unknown>;
    } catch (error) {
      this.options.logger.debug(`${action} 回查失败`, {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    // base64 直出：先按编码长度预判体积（base64 膨胀 4/3），超限直接不解码
    const base64 = typeof data['base64'] === 'string' ? data['base64'] : undefined;
    if (base64 !== undefined && base64 !== '') {
      if (Math.ceil(base64.length * 0.75) > options.maxBytes) return undefined;
      return { data: Buffer.from(base64, 'base64') };
    }
    // 刷新后的 URL（NapCat 文档建议的过期 URL 刷新路径）
    const url = typeof data['url'] === 'string' ? data['url'] : undefined;
    if (url !== undefined && /^https?:\/\//i.test(url)) {
      return this.httpGet(url, options);
    }
    // 只剩宿主本地路径（data.file）：容器内读不到，放弃
    return undefined;
  }

  /** 普通 GET：带超时与体积上限（content-length 预判 + 实际校验双保险）。 */
  private async httpGet(url: string, options: MediaFetchOptions): Promise<MediaBytes | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return undefined;
      const declaredLength = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) return undefined;
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > options.maxBytes) return undefined;
      const contentType = response.headers.get('content-type');
      return {
        data: buffer,
        ...(contentType !== null ? { mimeType: contentType.split(';')[0]?.trim() } : {}),
      };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 取媒体用的连接：优先已学到 self_id 的，否则任意连接（没有则抛错）。 */
  private pickAnySession(): Session {
    for (const session of this.sessions) {
      if (session.selfId !== undefined) return session;
    }
    const any = [...this.sessions][0];
    if (any === undefined) throw new OnebotActionError('没有已连入的 OneBot 客户端');
    return any;
  }
}

/** 只有用户消息带 parts/引用；系统事件（进群/加好友）走另一条路径。 */
function isMessage(event: NormalizedEvent): event is NormalizedMessage {
  return event.kind === 'group-at-message' || event.kind === 'c2c-message';
}
