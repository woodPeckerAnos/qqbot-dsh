import { MockDshRuntime } from '../../helpers/task-mocks.js';
/** Injected DSH records every prompt and lease, while retaining the same lane root. */
export class BenchmarkRuntime extends MockDshRuntime {
  startGate: Promise<void> | undefined;
  override async start() {
    await this.startGate;
    return super.start();
  }
  child(started: boolean, id: string, status = 'ok') {
    this.emit(started ? 'subagent.started' : 'subagent.finished', {
      parentSessionId: this.prompts.at(-1)!.sessionId,
      childSessionId: id,
      status,
    });
  }
}
