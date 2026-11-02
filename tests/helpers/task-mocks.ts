import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { DshRuntime, DshRuntimeOptions } from '../../src/dsh/process.js';
import type { PromptContentBlock } from '../../src/dsh/protocol.js';
import type { TaskClock } from '../../src/task/clock.js';

export class ManualClock implements TaskClock {
  time = Date.now();
  private next = 0;
  private readonly timers = new Map<number, { due: number; fn: () => void }>();
  now = () => this.time;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.next; this.timers.set(id, { fn, due: this.time + ms });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (timer: ReturnType<typeof setTimeout>) => { this.timers.delete(timer as unknown as number); };
  advance(ms: number): void {
    const end = this.time + ms;
    while (true) {
      const due = [...this.timers.entries()].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      this.time = due[1].due; this.timers.delete(due[0]); due[1].fn();
    }
    this.time = end;
  }
}
export class MockDshRuntime extends EventEmitter {
  ready = false;
  disposed = 0;
  prompts: { sessionId: string; blocks: PromptContentBlock[] }[] = [];
  seq = 0;
  constructor(readonly options: DshRuntimeOptions) { super(); }
  get isReady() { return this.ready; }
  get state() { return this.ready ? 'ready' : 'closed'; }
  async start() { this.ready = true; return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'mock' } }; }
  async prompt(sessionId: string, blocks: PromptContentBlock[]) {
    this.prompts.push({ sessionId, blocks });
    this.emit('session.status', { sessionId, status: 'running' });
    return { messageId: 'mock-prompt' };
  }
  event(type: string, data: Record<string, unknown>, sessionId = this.prompts[0]!.sessionId) {
    this.emit('session.event', { sessionId, event: { type, seq: this.seq++, data } });
  }
  finish(text: string, reason = 'completed') {
    this.event('assistant/message', { message: { content: [{ type: 'text', text }] } });
    this.event('turn/end', { reason: { kind: reason } });
    this.emit('session.status', { sessionId: this.prompts[0]!.sessionId, status: 'idle' });
  }
  async dispose() { if (!this.ready) return; this.disposed++; this.ready = false; this.emit('exit', 0, null); }
  asRuntime(): DshRuntime { return this as unknown as DshRuntime; }
}
class MockOnebotSocket extends EventEmitter {
  readyState = 1;
  constructor(private readonly service: UnifiedOnebotMock) { super(); }
  send(text: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(text) as { action: string; params: Record<string, unknown>; echo: string };
    this.service.actions.push(frame);
    callback?.();
    if (this.service.hold(frame.action)) return;
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ echo: frame.echo, status: this.service.fail(frame.action) ? 'failed' : 'ok', retcode: this.service.fail(frame.action) ? 100 : 0, data: this.service.result(frame.action, frame.params) }))));
  }
  close() { this.readyState = 3; this.emit('close'); }
}
/** One service for injected socket contracts and the separate real WS suite. */
export class UnifiedOnebotMock {
  readonly actions: { action: string; params: Record<string, unknown>; echo: string }[] = [];
  private socket = new MockOnebotSocket(this);
  fail: (action: string) => boolean = () => false;
  hold: (action: string) => boolean = () => false;
  result: (action: string, params: Record<string, unknown>) => unknown = () => ({ message_id: 100 });
  async start(onConnection: (socket: WebSocket) => void) { if (this.socket.readyState !== 1) this.socket = new MockOnebotSocket(this); onConnection(this.socket as unknown as WebSocket); }
  async stop() { this.socket.close(); }
  input(id: number, text: string, senderId = 123, addressed = true) {
    this.socket.emit('message', Buffer.from(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: 99, message_id: id, group_id: 8888, user_id: senderId, time: Math.floor(Date.now() / 1000), sender: { nickname: `用户${senderId}` }, message: [...(addressed ? [{ type: 'at', data: { qq: '99' } }] : []), { type: 'text', data: { text } }] })));
  }
  get sentTexts(): string[] {
    return this.actions.filter(a => a.action === 'send_group_msg' || a.action === 'send_private_msg').flatMap(a => (a.params.message as { type: string; data: { text?: string } }[] ?? []).filter(s => s.type === 'text').map(s => s.data.text!));
  }
}
