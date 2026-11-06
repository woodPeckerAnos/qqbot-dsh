import { EventEmitter } from 'node:events';
import type { DshRuntime, DshRuntimeOptions, PromptContentBlock } from '@qqbot/contracts';

/** Only the protocol boundary is replaced; the production runner consumes these events. */
export class BenchmarkRuntime extends EventEmitter {
  ready = false;
  disposed = 0;
  seq = 0;
  prompts: { sessionId: string; blocks: PromptContentBlock[] }[] = [];
  startGate: Promise<void> | undefined;
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
    await this.startGate;
    this.ready = true;
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'benchmark-mock-v1' } };
  }
  async prompt(sessionId: string, blocks: PromptContentBlock[]) {
    this.prompts.push({ sessionId, blocks });
    this.emit('session.status', { sessionId, status: 'running' });
    return { messageId: 'benchmark-prompt' };
  }
  event(
    type: string,
    data: Record<string, unknown>,
    sessionId = this.prompts[0]!.sessionId,
    seq = this.seq++
  ) {
    this.emit('session.event', { sessionId, event: { type, seq, data } });
  }
  finish(text: string, reason = 'completed') {
    this.event('assistant/message', { message: { content: [{ type: 'text', text }] } });
    this.event('turn/end', { reason: { kind: reason } });
    this.emit('session.status', { sessionId: this.prompts[0]!.sessionId, status: 'idle' });
  }
  child(started: boolean, id: string, status = 'ok') {
    this.emit(started ? 'subagent.started' : 'subagent.finished', {
      parentSessionId: this.prompts[0]!.sessionId,
      childSessionId: id,
      status,
    });
  }
  async dispose() {
    if (!this.ready) return;
    this.ready = false;
    this.disposed++;
    this.emit('exit', 0, null);
  }
  asRuntime(): DshRuntime {
    return this as unknown as DshRuntime;
  }
}
