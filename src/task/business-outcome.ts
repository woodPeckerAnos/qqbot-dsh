import type { SessionEventEnvelope } from '@qqbot/contracts';

/** Control tools are excluded; only correlated successful business results permit silence. */
export class BusinessOutcome {
  private calls = 0;
  private readonly pending = new Set<string>();
  private failed = false;
  private queryFailed = false;
  private readonly queries = new Set<string>();
  get cannotBeSilent(): boolean {
    return this.failed || this.pending.size > 0;
  }
  get failureReason(): 'query-failed' | 'tool-failed' | 'tool-unsettled' | undefined {
    if (this.pending.size) return 'tool-unsettled';
    if (this.queryFailed) return 'query-failed';
    if (this.failed) return 'tool-failed';
    return undefined;
  }
  observe(event: SessionEventEnvelope): void {
    if (event.type === 'tool/call') this.call(event.data);
    if (event.type === 'tool/result') this.result(event.data);
  }
  private call(value: unknown): void {
    const data = value as { name?: string; callId?: string; call?: { name?: string } };
    if (['query_tasks', 'cancel_task'].includes(data.name ?? data.call?.name ?? '')) return;
    const id = data.callId ?? `unidentified-${++this.calls}`;
    this.pending.add(id);
    if (/web|fetch|search|read/.test(data.name ?? data.call?.name ?? '')) this.queries.add(id);
  }
  private result(value: unknown): void {
    const data = value as {
      error?: unknown;
      message?: {
        source?: { callId?: string };
        content?: { toolCallId?: string; isError?: boolean }[];
      };
    };
    const source = data.message?.source?.callId;
    for (const block of data.message?.content ?? []) {
      this.resultBlock(block, source, !!data.error);
    }
  }
  private resultBlock(
    block: { toolCallId?: string; isError?: boolean },
    source: string | undefined,
    error: boolean
  ): void {
    const id = block.toolCallId;
    if (!id || !matchesSource(source, id)) return;
    if (!this.pending.delete(id)) return;
    const failed = !!block.isError || error;
    this.failed ||= failed;
    this.queryFailed ||= failed && this.queries.has(id);
    this.queries.delete(id);
  }
}
function matchesSource(source: string | undefined, id: string): boolean {
  return source === undefined || source === id;
}
