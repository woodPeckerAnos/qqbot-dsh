import type { LogTransport } from '@qqbot/contracts';
import type { LogCategory } from '@qqbot/contracts';

export type { LogTransport } from '@qqbot/contracts';
interface PendingLine {
  line: string;
  bytes: number;
  diagnostic: boolean;
  category: LogCategory;
  failed?: boolean;
}
export class LogBuffer {
  private readonly queue: PendingLine[] = [];
  private active?: PendingLine;
  private blocked = false;
  private pumping = false;
  private readonly failures = new WeakSet<Error>();
  queuedBytes = 0;
  sinkFailures = 0;
  emitted = 0;
  constructor(
    private readonly sink: LogTransport,
    private readonly dropped: (category: LogCategory) => void
  ) {
    sink.on?.('drain', () => {
      this.blocked = false;
      this.pump();
    });
    sink.on?.('error', (error) => {
      this.failActive(error);
    });
  }
  enqueue(line: string, diagnostic: boolean, category: LogCategory, limit: number): void {
    const pending = { line: `${line}\n`, bytes: Buffer.byteLength(line) + 1, diagnostic, category };
    if (!diagnostic) this.makeRoom(pending.bytes, limit);
    if (this.queuedBytes + pending.bytes > limit) {
      this.dropped(category);
      return;
    }
    this.queue.push(pending);
    this.queuedBytes += pending.bytes;
    this.pump();
  }
  trim(limit: number): void {
    this.makeRoom(0, limit);
  }
  private makeRoom(bytes: number, limit: number): void {
    while (this.queuedBytes + bytes > limit) {
      const index = this.queue.findLastIndex((p) => p.diagnostic);
      if (index < 0) return;
      const [removed] = this.queue.splice(index, 1);
      if (removed) {
        this.queuedBytes -= removed.bytes;
        this.dropped(removed.category);
      }
    }
  }
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    while (!this.active && !this.blocked && this.queue.length) this.writeNext();
    this.pumping = false;
  }
  private writeNext(): void {
    const pending = this.queue.shift();
    if (!pending) return;
    this.active = pending;
    try {
      const ready = this.sink.write(pending.line, (error) => {
        this.complete(pending, error);
      });
      this.blocked = !ready && !pending.failed;
    } catch {
      this.complete(pending, new Error('log-write-failed'));
    }
  }
  private complete(pending: PendingLine, error?: Error | null): void {
    if (this.active !== pending) return;
    this.active = undefined;
    this.queuedBytes -= pending.bytes;
    if (error) {
      pending.failed = true;
      this.blocked = false;
      this.countFailure(error);
      this.dropped(pending.category);
    } else this.emitted++;
    this.pump();
  }
  private countFailure(error: Error): void {
    if (this.failures.has(error)) return;
    this.failures.add(error);
    this.sinkFailures++;
  }
  private failActive(error = new Error('log-sink-failed')): void {
    if (this.failures.has(error)) return;
    this.blocked = false;
    if (this.active) this.complete(this.active, error);
    else {
      this.countFailure(error);
      this.pump();
    }
  }
}
export function stderrTransport(): LogTransport {
  return {
    write: (line, done) => process.stderr.write(line, done),
    on: (event, listener) => process.stderr.on(event, listener),
  };
}
