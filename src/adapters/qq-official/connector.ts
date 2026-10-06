/**
 * 官方开放平台连接器：把 TokenManager + QqApi + QqGateway 包装成 BotConnector。
 *
 * 所有官方平台专有的行为都收在这个适配器里：
 *   - 回复时把编排层的 seq 映射为 msg_seq、按互斥规则选 msg_id / event_id；
 *   - 按 QQ_MSG_TYPE 渲染纯文本或 markdown 请求体；
 *   - 回复策略声明被动窗口约束（群 5 次/5 分钟、单聊 4 次/60 分钟）。
 *
 * 编排层只看到 BotConnector 接口，不感知以上任何细节。
 */

import { readFile } from 'node:fs/promises';

import type {
  BotConnector,
  ConnectorHealth,
  ConversationKind,
  MediaBytes,
  MediaFetchOptions,
  ConversationTarget,
  NormalizedEvent,
  OutgoingAttachment,
  OutgoingMessage,
  ProactiveResult,
  RemoteMedia,
  ReplyContext,
  ReplyPolicy,
} from '../../core/connector.js';
import type { ForwardConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { QqApi } from './api.js';
import {
  QqGateway,
  QQ_OFFICIAL_PLATFORM,
  type EventSourceHealth,
  type WebSocketFactory,
} from './gateway.js';
import { renderMediaMessage, renderMessage } from './render.js';
import { TokenManager } from './token.js';
import { MediaFileType, type UploadFileRequest } from './types.js';

/** access_token 状态快照（health 展示用） */
export interface TokenSnapshot {
  hasToken: boolean;
  expiresInMs: number;
}

/** 官方连接器的配置（由 config.ts 的 config.qq 映射而来） */
export interface QqOfficialConnectorOptions {
  appId: string;
  appSecret: string;
  apiBase: string;
  intents: number;
  msgType: 0 | 2;
  /** 是否响应单聊消息（intent 层无法只订群聊，所以在业务层拦） */
  acceptsC2C: boolean;
  /** 回复策略：群聊与单聊分开（官方单聊上限低于群聊） */
  groupPolicy: ReplyPolicy;
  c2cPolicy: ReplyPolicy;
  /**
   * 转发块（聊天记录形态的 msg_elements）展开配额（config.attachments.forward）。
   * 官方接收侧只定义了 0/3/103 三种 message_type，转发能力按"尽力而为 + 实测"
   * 定位，见 docs/FORWARD-FILE-INGRESS-PLAN.md §3.2。
   */
  forward?: ForwardConfig;
  /** 转发块展开结果上报（/metrics 计数） */
  onForward?: (info: { ok: boolean; nodes: number }) => void;
  logger: Logger;
  /** 测试注入 */
  webSocketFactory?: WebSocketFactory;
  fetchImpl?: typeof fetch;
}

export class QqOfficialConnector implements BotConnector {
  readonly platform = QQ_OFFICIAL_PLATFORM;

  readonly tokenManager: TokenManager;
  readonly api: QqApi;
  readonly gateway: QqGateway;

  constructor(private readonly options: QqOfficialConnectorOptions) {
    this.tokenManager = new TokenManager({
      appId: options.appId,
      appSecret: options.appSecret,
      apiBase: options.apiBase,
      logger: options.logger.child({ component: 'token' }),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.api = new QqApi({
      apiBase: options.apiBase,
      tokenManager: this.tokenManager,
      logger: options.logger.child({ component: 'api' }),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.gateway = new QqGateway({
      api: this.api,
      tokenManager: this.tokenManager,
      intents: options.intents,
      logger: options.logger.child({ component: 'gateway' }),
      ...(options.webSocketFactory !== undefined
        ? { webSocketFactory: options.webSocketFactory }
        : {}),
      ...(options.forward !== undefined ? { forward: options.forward } : {}),
      ...(options.onForward !== undefined ? { onForward: options.onForward } : {}),
    });
  }

  on(handler: (event: NormalizedEvent) => void): () => void {
    return this.gateway.on(handler);
  }

  get acceptsC2C(): boolean {
    return this.options.acceptsC2C;
  }

  /**
   * 启动：先验证一次鉴权，把配置错误挡在"连着但没权限"之前，再启动网关。
   * 鉴权失败时抛错，由 main.ts 决定是降级运行还是整体退出。
   */
  async start(): Promise<void> {
    await this.tokenManager.get();
    await this.gateway.start();
  }

  async stop(): Promise<void> {
    await this.gateway.stop();
  }

  policy(kind: ConversationKind): ReplyPolicy {
    return kind === 'c2c' ? this.options.c2cPolicy : this.options.groupPolicy;
  }

  async reply(ctx: ReplyContext, out: OutgoingMessage): Promise<void> {
    const attachments = out.attachments ?? [];
    if (attachments.length > 0) {
      // 一次 reply = 一个 msg_seq，装不下"文本 + 附件"混合消息；
      // Responder 保证二者分次调用。这里防御性地只发第一个附件，
      // 多余的（不该出现）记 warn 丢弃，避免同 seq 重发被平台去重（40054005）。
      if (out.text !== '') {
        this.options.logger.warn('同一 reply 调用同时携带文本与附件，文本部分被丢弃', {
          conversation: ctx.target.key,
          seq: ctx.seq,
        });
      }
      if (attachments.length > 1) {
        this.options.logger.warn('同一 reply 调用携带多个附件，只发第一个', {
          conversation: ctx.target.key,
          seq: ctx.seq,
          dropped: attachments.slice(1).map((item) => item.fileName),
        });
      }
      const first = attachments[0];
      if (first !== undefined) await this.sendAttachment(ctx, first);
      return;
    }

    const body = renderMessage(out.text, {
      msgType: this.options.msgType,
      msgSeq: ctx.seq,
      ...(ctx.msgId !== undefined && ctx.msgId !== '' ? { msgId: ctx.msgId } : {}),
      ...(ctx.eventId !== undefined && ctx.eventId !== '' ? { eventId: ctx.eventId } : {}),
    });
    if (ctx.target.kind === 'c2c') {
      await this.api.sendUserMessage(ctx.target.id, body);
      return;
    }
    await this.api.sendGroupMessage(ctx.target.id, body);
  }

  /**
   * 【主动发言能力】官方通道的主动推送**不是我们能选的**：
   *   - 官方文档载明「主动推送能力于 2025-04-21 起不再提供」；
   *   - 群聊主动消息每月 4 条，单聊同；子频道另有每天 20 条/每秒 5 条；
   *   - 用户还可以在客户端关闭「接收主动消息」，关闭后主动消息一律发送失败。
   *
   * 因此这个方法的实现就是**什么都不做**（do nothing），用返回值如实告诉外层
   * 「这个平台没有主动发言能力」。这不是占位符，而是**定稿的保守行为**：
   * 一旦官方开放能力，只需要在这里补一次 api.sendGroupMessage/sendUserMessage
   * 调用（不带 msg_id / event_id），外层逻辑一行都不用改。
   *
   * 刻意不抛错、不 warn 刷日志：外层已经按 unsupported 记降级计数，
   * 这里再打日志只会让"官方通道每次介入都刷一条告警"。
   */
  async proactive(target: ConversationTarget, _out: OutgoingMessage): Promise<ProactiveResult> {
    return {
      ok: false,
      reason: 'unsupported',
      detail:
        '官方通道不提供主动推送（2025-04-21 起停用；群聊主动消息每月 4 条且用户可关闭接收）',
      retryable: false,
    };
  }

  /**
   * 发一个附件：先 /files 上传拿 file_info（srv_send_msg=false），
   * 再走 /messages 发 msg_type=7——两步都保持 msg_id/msg_seq 被动回复语义。
   */
  private async sendAttachment(ctx: ReplyContext, attachment: OutgoingAttachment): Promise<void> {
    const data = await readFile(attachment.absPath);
    const upload: UploadFileRequest = {
      file_type: attachment.kind === 'image' ? MediaFileType.IMAGE : MediaFileType.FILE,
      srv_send_msg: false,
      file_data: data.toString('base64'),
    };
    const uploaded =
      ctx.target.kind === 'c2c'
        ? await this.api.uploadUserFile(ctx.target.id, upload)
        : await this.api.uploadGroupFile(ctx.target.id, upload);
    if (uploaded.file_info === undefined || uploaded.file_info === '') {
      throw new Error('上传富媒体文件失败：响应里没有 file_info');
    }

    const body = renderMediaMessage(uploaded.file_info, {
      msgSeq: ctx.seq,
      ...(ctx.msgId !== undefined && ctx.msgId !== '' ? { msgId: ctx.msgId } : {}),
      ...(ctx.eventId !== undefined && ctx.eventId !== '' ? { eventId: ctx.eventId } : {}),
    });
    if (ctx.target.kind === 'c2c') {
      await this.api.sendUserMessage(ctx.target.id, body);
    } else {
      await this.api.sendGroupMessage(ctx.target.id, body);
    }
    this.options.logger.debug('官方富媒体消息已发送', {
      conversation: ctx.target.key,
      fileName: attachment.fileName,
      kind: attachment.kind,
      sizeBytes: attachment.sizeBytes,
      seq: ctx.seq,
    });
  }

  /**
   * 取官方多媒体 CDN 的字节（图片内联进多模态 prompt 用）。
   *
   * 鉴权策略：先带 `Authorization: QQBot <access_token>` 请求；只有在收到
   * 401/403 时才裸请求一次兜底。这样"需要鉴权"的形态能过，"公开 CDN"的形态
   * 也不会因为多带一个头而被拒。网络错误不重试，避免把一次超时变成两次。
   */
  async fetchMedia(media: RemoteMedia, options: MediaFetchOptions): Promise<MediaBytes | undefined> {
    // 官方适配器只产出带 url 的媒体（content.ts 保证），没有 url 说明数据异常
    if (media.url === undefined) return undefined;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const first = await this.tryFetchMedia(fetchImpl, media.url, options, true);
    if (first.bytes !== undefined) return first.bytes;
    if (!first.unauthorized) return undefined;
    const second = await this.tryFetchMedia(fetchImpl, media.url, options, false);
    return second.bytes;
  }

  private async tryFetchMedia(
    fetchImpl: typeof fetch,
    url: string,
    options: MediaFetchOptions,
    withAuth: boolean,
  ): Promise<{ bytes?: MediaBytes; unauthorized: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    timer.unref?.();
    try {
      const headers: Record<string, string> = {};
      if (withAuth) {
        try {
          headers['Authorization'] = `QQBot ${await this.tokenManager.get()}`;
        } catch (error) {
          this.options.logger.warn('取 access_token 失败，放弃下载附件', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { unauthorized: false };
        }
      }
      const response = await fetchImpl(url, { headers, signal: controller.signal });
      if (!response.ok) {
        return { unauthorized: response.status === 401 || response.status === 403 };
      }
      const declaredLength = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
        this.options.logger.warn('附件超过大小上限，跳过', { url, declaredLength });
        return { unauthorized: false };
      }
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength > options.maxBytes) {
        this.options.logger.warn('附件超过大小上限，跳过', { url, size: data.byteLength });
        return { unauthorized: false };
      }
      const contentType = response.headers.get('content-type');
      return {
        bytes: {
          data,
          ...(contentType !== null ? { mimeType: contentType.split(';')[0]?.trim() } : {}),
        },
        unauthorized: false,
      };
    } catch (error) {
      this.options.logger.debug('下载附件失败', {
        url,
        withAuth,
        error: error instanceof Error ? error.message : String(error),
      });
      return { unauthorized: false };
    } finally {
      clearTimeout(timer);
    }
  }

  health(): ConnectorHealth {
    const gateway: EventSourceHealth = this.gateway.health();
    const token: TokenSnapshot = this.tokenManager.snapshot();
    const warnings: string[] = [];
    if (!token.hasToken) warnings.push('尚未取得 access_token');
    return {
      connected: gateway.connected,
      state: gateway.state,
      ...(gateway.lastEventAt !== undefined ? { lastEventAt: gateway.lastEventAt } : {}),
      reconnectAttempts: gateway.reconnectAttempts,
      ...(warnings.length > 0 ? { warnings } : {}),
      detail: {
        ...(gateway.sessionId !== undefined ? { sessionId: gateway.sessionId } : {}),
        ...(gateway.lastSeq !== undefined ? { lastSeq: gateway.lastSeq } : {}),
        token,
      },
    };
  }
}
