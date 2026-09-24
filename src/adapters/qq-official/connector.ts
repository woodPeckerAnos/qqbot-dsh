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

import type {
  BotConnector,
  ConnectorHealth,
  ConversationKind,
  NormalizedEvent,
  OutgoingMessage,
  ReplyContext,
  ReplyPolicy,
} from '../../core/connector.js';
import type { Logger } from '../../logger.js';
import { QqApi } from './api.js';
import {
  QqGateway,
  QQ_OFFICIAL_PLATFORM,
  type EventSourceHealth,
  type WebSocketFactory,
} from './gateway.js';
import { renderMessage } from './render.js';
import { TokenManager } from './token.js';

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
