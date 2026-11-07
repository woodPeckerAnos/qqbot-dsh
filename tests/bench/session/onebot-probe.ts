import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { createOnebotConnector } from '../../../src/connectors/index.js';
import { createLogger } from '../../../src/observability/index.js';
import type { OutgoingMessage, ReplyContext } from '@qqbot/contracts';
import type { MemoryConnector } from './connector.js';

export const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export interface ProbeNode {
  type: string;
  text?: string;
  sha256?: string;
  sizeBytes?: number;
  id?: string;
  mention?: string;
}
export interface ProbeAction {
  action: string;
  messageId?: string;
  at: number;
  receivedAt?: number;
  payloadBytes: number;
  senderIds?: string[];
  nodes: ProbeNode[][];
  zipEntries?: { name: string; sha256: string; sizeBytes: number }[];
}
interface Segment {
  type: string;
  data: {
    text?: string;
    file?: string;
    id?: string;
    qq?: string;
    user_id?: string;
    content?: Segment[];
  };
}
interface Frame {
  action: string;
  echo: string;
  params: { message?: Segment[]; messages?: Segment[]; file?: string; name?: string };
}

/** Actual adapter actions over an injected authenticated socket; no network. */
export class OnebotProbe extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  actions: ProbeAction[] = [];
  private connector!: ReturnType<typeof createOnebotConnector>;
  private readonly identity = new AsyncLocalStorage<string>();
  block: (action: string) => Promise<void> = async () => {};
  constructor(
    private readonly memory: MemoryConnector,
    private readonly options: { fileTransport?: 'base64' | 'path'; maxPayloadBytes?: number } = {}
  ) {
    super();
  }
  async start() {
    this.connector = createOnebotConnector({
      host: 'offline',
      port: 0,
      accessToken: 'offline',
      acceptsC2C: true,
      autoAcceptFriend: false,
      autoAcceptGroupInvite: false,
      replyPolicy: {
        ...this.memory.policy('group'),
        ...(this.options.maxPayloadBytes
          ? { record: { maxPayloadBytes: this.options.maxPayloadBytes, videoExtensions: ['mp4'] } }
          : {}),
      },
      fileTransport: this.options.fileTransport,
      logger: createLogger({ autoTick: false, sink: () => {} }),
      transport: {
        start: async (connect) => {
          connect(this as unknown as WebSocket);
        },
        stop: async () => {},
      },
    });
    await this.connector.start();
    this.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          post_type: 'meta_event',
          meta_event_type: 'lifecycle',
          sub_type: 'connect',
          self_id: 10000,
          time: 0,
        })
      )
    );
    this.memory.send = (ctx, out) => this.reply(ctx, out);
  }
  async reply(ctx: ReplyContext, out: OutgoingMessage) {
    const id = this.memory.identify(ctx, out).messageId ?? 'unidentified';
    await this.identity.run(id, () =>
      this.connector.reply({ ...ctx, target: { ...ctx.target, id: '12345' } }, out)
    );
  }
  send(raw: string, callback: (error?: Error) => void) {
    const frame = JSON.parse(raw) as Frame;
    const evidence: ProbeAction = {
      action: frame.action,
      messageId: this.identity.getStore(),
      at: this.memory.now(),
      nodes: [],
      payloadBytes: Buffer.byteLength(raw),
      senderIds: frame.params.messages?.map((n) => n.data.user_id ?? ''),
    };
    this.actions.push(evidence);
    callback();
    void this.capture(frame, evidence).then(
      () => {
        evidence.receivedAt = this.memory.now();
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              status: 'ok',
              retcode: 0,
              echo: frame.echo,
              data: { message_id: this.actions.length },
            })
          )
        );
      },
      () => {
        this.emit(
          'message',
          Buffer.from(JSON.stringify({ status: 'failed', retcode: 1, echo: frame.echo }))
        );
      }
    );
  }
  private async capture(frame: Frame, evidence: ProbeAction) {
    const nodes = frame.params.messages?.map((n) => n.data.content ?? []) ?? [
      frame.params.message ?? [],
    ];
    for (const node of nodes) {
      const parts: ProbeNode[] = [];
      for (const segment of node) {
        if (segment.type === 'text') parts.push({ type: 'text', text: segment.data.text });
        else if (segment.data.file) {
          const bytes = await fileBytes(segment.data.file);
          parts.push({ type: segment.type, sha256: digest(bytes), sizeBytes: bytes.length });
        } else parts.push({ type: segment.type, id: segment.data.id, mention: segment.data.qq });
      }
      evidence.nodes.push(parts);
    }
    if (frame.params.file) {
      const bytes = await fileBytes(frame.params.file);
      evidence.nodes = [[{ type: 'file', sha256: digest(bytes), sizeBytes: bytes.length }]];
      if (frame.params.name?.endsWith('.zip')) evidence.zipEntries = zipEntries(bytes);
    }
    await this.block(frame.action);
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  async stop() {
    await this.connector.stop();
    this.removeAllListeners();
  }
}
async function fileBytes(file: string) {
  return file.startsWith('base64://') ? Buffer.from(file.slice(9), 'base64') : readFile(file);
}
function zipEntries(bytes: Buffer) {
  const entries: { name: string; sha256: string; sizeBytes: number }[] = [];
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26),
      extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const data = bytes.subarray(start, start + size);
    entries.push({ name, sha256: digest(data), sizeBytes: data.length });
    offset = start + size;
  }
  return entries;
}
