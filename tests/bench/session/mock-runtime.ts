import { CooperationDriver } from '../../helpers/cooperation-driver.js';
import { EventEmitter } from 'node:events';
import type { DshRuntime, DshRuntimeOptions, PromptContentBlock } from '@qqbot/contracts';

/** Only the protocol boundary is replaced; the production runner consumes these events. */
export class BenchmarkRuntime extends EventEmitter {
  ready = false;
  disposed = 0;
  seq = 0;
  cooperation?: CooperationDriver;
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
    if (this.options.taskCooperation)
      this.cooperation = new CooperationDriver(this.options, sessionId);
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
    const end = (answer: string) => {
      if (answer !== text)
        this.event('assistant/message', { message: { content: [{ type: 'text', text: answer }] } });
      this.event('turn/end', { turn: 1, reason: { kind: reason } });
      this.emit('session.status', { sessionId: this.prompts[0]!.sessionId, status: 'idle' });
    };
    if (this.cooperation && reason === 'completed')
      void this.cooperation.stop(text).then(end, () => {});
    else end(text);
  }
  child(started: boolean, id: string, status = 'ok') {
    this.emit(started ? 'subagent.started' : 'subagent.finished', {
      parentSessionId: this.prompts[0]!.sessionId,
      childSessionId: id,
      status,
    });
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
    this.ready = false;
    this.disposed++;
    this.emit('exit', 0, null);
  }
  asRuntime(): DshRuntime {
    return this as unknown as DshRuntime;
  }
}
