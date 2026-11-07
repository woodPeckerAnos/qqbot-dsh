import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type {
  BotConnector,
  ConversationKind,
  NormalizedEvent,
  ReplyContext,
  OutgoingMessage,
  RemoteMedia,
  MessageForwardPart,
} from '@qqbot/contracts';
import type { PlatformAction, AttachmentEvidence } from './types.js';

export class MemoryConnector implements BotConnector {
  readonly platform = 'onebot';
  readonly acceptsC2C = true;
  connected = true;
  official = false;
  maxChars = 2000;
  recordCapable = false;
  actions: PlatformAction[] = [];
  fetches = 0;
  private receivedCount = 0;
  handlers = new Set<(event: NormalizedEvent) => void>();
  send: (ctx: ReplyContext, out: OutgoingMessage) => Promise<void> = async () => {};
  fetch: (media: RemoteMedia) => Promise<Buffer | undefined> = async () =>
    Buffer.from('name,value\nA,12\nB,8\n');
  now = () => Date.now();
  identify: (
    ctx: ReplyContext,
    out: OutgoingMessage
  ) => { taskId?: string; lane?: string; messageId?: string } = () => ({});
  async start() {
    this.connected = true;
  }
  async stop() {
    this.connected = false;
    this.handlers.clear();
  }
  on(handler: (event: NormalizedEvent) => void) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  receive(event: NormalizedEvent) {
    this.handlers.forEach((handler) => {
      handler(event);
    });
  }
  health() {
    return { connected: this.connected, state: 'memory' };
  }
  canReply() {
    return this.connected;
  }
  policy(kind: ConversationKind) {
    const quota = kind === 'group' ? 5 : 4;
    const window = kind === 'group' ? 300000 : 3600000;
    return {
      ...(this.recordCapable && !this.official
        ? { record: { maxPayloadBytes: 100 * 1024 * 1024, videoExtensions: ['mp4'] } }
        : {}),
      maxChars: this.maxChars,
      maxRepliesPerMsg: this.official ? quota : 10000,
      passiveWindowMs: this.official ? window : Infinity,
      progressMax: 0,
      progressAfterMs: 0,
      progressIntervalMs: 0,
      turnTimeoutMs: 30000,
    };
  }
  async reply(ctx: ReplyContext, out: OutgoingMessage) {
    const action: PlatformAction = {
      order: this.actions.length,
      at: this.now(),
      session: ctx.target.key,
      anchor: ctx.msgId,
      seq: ctx.seq,
      kind: ctx.kind,
      text: out.text,
      reference: out.reference ? structuredClone(out.reference) : undefined,
      attachments: [],
      status: 'attempted',
      ...this.identify(ctx, out),
    };
    this.actions.push(action);
    try {
      action.attachments = await Promise.all(
        (out.attachments ?? []).map(async (a): Promise<AttachmentEvidence> => {
          const bytes = await readFile(a.absPath);
          const text = /\.(txt|csv|md|json|ts|py)$/i.test(a.fileName)
            ? bytes.toString('utf8')
            : undefined;
          return {
            fileName: a.fileName,
            sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            text,
          };
        })
      );
      await this.send(ctx, out);
      if (ctx.signal?.aborted) throw new Error('send-aborted');
      action.status = 'received';
      action.receivedAt = this.now();
      action.receivedOrder = this.receivedCount++;
    } catch (error) {
      action.status = 'failed';
      throw error;
    }
  }
  async fetchMedia(media: RemoteMedia) {
    this.fetches++;
    const bytes = await this.fetch(media);
    return bytes ? { data: bytes, mimeType: 'application/octet-stream' } : undefined;
  }
  async fetchForward(_target: unknown, refId: string): Promise<MessageForwardPart | undefined> {
    return {
      type: 'forward',
      refId,
      parts: [
        {
          type: 'quote',
          author: '资料员',
          parts: [{ type: 'text', text: '订单甲12元，订单乙8元。' }],
        },
      ],
    };
  }
}
