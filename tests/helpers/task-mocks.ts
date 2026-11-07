import { CooperationDriver } from './cooperation-driver.js';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { DshRuntimeV2 as DshRuntime, DshRuntimeOptions } from '@qqbot/contracts';
import type { PromptContentBlock } from '../../src/dsh/protocol.js';
import type { TaskClock } from '../../src/task/clock.js';

export class ManualClock implements TaskClock {
  time = Date.now();
  private next = 0;
  private readonly timers = new Map<number, { due: number; fn: () => void }>();
  now = () => this.time;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.next;
    this.timers.set(id, { fn, due: this.time + ms });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as unknown as number);
  };
  advance(ms: number): void {
    const end = this.time + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      this.time = due[1].due;
      this.timers.delete(due[0]);
      due[1].fn();
    }
    this.time = end;
  }
}
export class MockDshRuntime extends EventEmitter {
  ready = false;
  disposed = 0;
  prompts: {
    sessionId: string;
    blocks: PromptContentBlock[];
    binding?: import('@qqbot/contracts').ExecutionBinding;
    messageId: string;
  }[] = [];
  seq = 0;
  cooperation?: CooperationDriver;
  binding?: import('@qqbot/contracts').ExecutionBinding;
  handlers?: import('@qqbot/contracts').ExecutionHandlers;
  readonly bindings: import('@qqbot/contracts').ExecutionBinding[] = [];
  turn = 0;
  idle = true;
  convergenceGate?: Promise<void>;
  async bindExecution(
    binding: import('@qqbot/contracts').ExecutionBinding,
    handlers: import('@qqbot/contracts').ExecutionHandlers
  ) {
    this.binding = { ...binding };
    this.handlers = handlers;
    this.bindings.push(binding);
    if (handlers.cooperation) this.cooperation = new CooperationDriver(binding, handlers);
    return { binding, idle: true };
  }
  async unbindExecution(binding: import('@qqbot/contracts').ExecutionBinding) {
    this.cooperation?.close();
    this.binding = undefined;
    this.handlers = undefined;
    return { binding, idle: true };
  }
  async quiesceExecution(binding: import('@qqbot/contracts').ExecutionBinding) {
    await this.convergenceGate;
    return { binding, idle: this.idle };
  }
  async cancelExecution(binding: import('@qqbot/contracts').ExecutionBinding) {
    this.cooperation?.close();
    await this.convergenceGate;
    this.idle = true;
    return { binding, idle: true };
  }
  constructor(readonly options: DshRuntimeOptions) {
    super();
  }
  get isReady() {
    return this.ready;
  }
  get state() {
    return this.ready ? 'ready' : 'closed';
  }
  async start() {
    this.ready = true;
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'mock' } };
  }
  async prompt(sessionId: string, blocks: PromptContentBlock[]) {
    const messageId = `mock-prompt-${this.prompts.length + 1}`;
    this.prompts.push({ sessionId, blocks, binding: this.binding, messageId });
    this.idle = false;
    this.emit('session.status', { sessionId, status: 'running' });
    this.turn++;
    this.event('turn/start', { turn: this.turn }, sessionId);
    this.event('user/message', { id: messageId }, sessionId);
    this.cooperation?.begin(messageId);
    return { messageId };
  }
  event(
    type: string,
    data: Record<string, unknown>,
    sessionId = this.prompts.at(-1)!.sessionId,
    seq = this.seq++
  ) {
    if (type === 'turn/end' && data.turn === undefined) data = { ...data, turn: this.turn };
    this.emit('session.event', { sessionId, event: { type, seq, data } });
  }
  finish(text: string, reason = 'completed') {
    const sessionId = this.prompts.at(-1)!.sessionId;
    const turn = this.turn;
    this.event('assistant/message', { message: { content: [{ type: 'text', text }] } });
    const end = (answer: string) => {
      if (answer !== text)
        this.event('assistant/message', { message: { content: [{ type: 'text', text: answer }] } });
      this.event('turn/end', { turn, reason: { kind: reason } });
      this.idle = true;
      this.emit('session.status', { sessionId, status: 'idle' });
    };
    if (this.cooperation && reason === 'completed')
      void this.cooperation.stop(text).then(end, () => {});
    else end(text);
  }
  notifyTaskCooperation(update: import('@qqbot/contracts').TaskCooperationUpdate) {
    this.cooperation?.receive(update);
  }
  onTaskChannelClose(listener: () => void) {
    this.on('task.channel.closed', listener);
    return () => {
      this.off('task.channel.closed', listener);
    };
  }
  async dispose() {
    this.cooperation?.close();
    if (!this.ready) return;
    this.disposed++;
    this.ready = false;
    this.emit('exit', 0, null);
  }
  asRuntime(): DshRuntime {
    return this as unknown as DshRuntime;
  }
}
class MockOnebotSocket extends EventEmitter {
  readyState = 1;
  constructor(private readonly service: UnifiedOnebotMock) {
    super();
  }
  send(text: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(text) as {
      action: string;
      params: Record<string, unknown>;
      echo: string;
    };
    this.service.actions.push(frame);
    callback?.();
    if (this.service.hold(frame.action)) return;
    queueMicrotask(() =>
      this.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            echo: frame.echo,
            status: this.service.fail(frame.action) ? 'failed' : 'ok',
            retcode: this.service.fail(frame.action) ? 100 : 0,
            data: this.service.result(frame.action, frame.params),
          })
        )
      )
    );
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
}
/** One service for injected socket contracts and the separate real WS suite. */
export class UnifiedOnebotMock {
  readonly actions: { action: string; params: Record<string, unknown>; echo: string }[] = [];
  private socket = new MockOnebotSocket(this);
  fail: (action: string) => boolean = () => false;
  hold: (action: string) => boolean = () => false;
  result: (action: string, params: Record<string, unknown>) => unknown = () => ({
    message_id: 100,
  });
  async start(onConnection: (socket: WebSocket) => void) {
    if (this.socket.readyState !== 1) this.socket = new MockOnebotSocket(this);
    onConnection(this.socket as unknown as WebSocket);
  }
  async stop() {
    this.socket.close();
  }
  input(id: number, text: string, senderId = 123, addressed = true) {
    this.socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          post_type: 'message',
          message_type: 'group',
          self_id: 99,
          message_id: id,
          group_id: 8888,
          user_id: senderId,
          time: Math.floor(Date.now() / 1000),
          sender: { nickname: `用户${senderId}` },
          message: [
            ...(addressed ? [{ type: 'at', data: { qq: '99' } }] : []),
            { type: 'text', data: { text } },
          ],
        })
      )
    );
  }
  get sentTexts(): string[] {
    return this.actions
      .filter((a) => a.action === 'send_group_msg' || a.action === 'send_private_msg')
      .flatMap((a) =>
        ((a.params.message as { type: string; data: { text?: string } }[]) ?? [])
          .filter((s) => s.type === 'text')
          .map((s) => s.data.text!)
      );
  }
}
