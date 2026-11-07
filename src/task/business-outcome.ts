import type { SessionEventEnvelope } from '@qqbot/contracts';

/** Control tools are excluded; only correlated successful business results permit silence. */
export class BusinessOutcome {
  private calls = 0;
  private readonly pending = new Set<string>();
  private failed = false;
  get cannotBeSilent(): boolean {
    return this.failed || this.pending.size > 0;
  }
  observe(event: SessionEventEnvelope): void {
    if (event.type === 'tool/call') this.call(event.data);
    if (event.type === 'tool/result') this.result(event.data);
  }
  private call(value: unknown): void {
    const data = value as { name?: string; callId?: string; call?: { name?: string } };
    if (['query_tasks', 'cancel_task'].includes(data.name ?? data.call?.name ?? '')) return;
    this.pending.add(data.callId ?? `unidentified-${++this.calls}`);
  }
  private result(value: unknown): void {
    const data = value as {
      error?: unknown;
      message?: { content?: { toolCallId?: string; isError?: boolean }[] };
    };
    for (const block of data.message?.content ?? []) {
      if (block.toolCallId && this.pending.delete(block.toolCallId))
        this.failed ||= !!block.isError || !!data.error;
    }
  }
}
