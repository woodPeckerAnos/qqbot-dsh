import type { RuntimeLeaseV2, SessionEventNotification } from '@qqbot/contracts';

/** A prompt receipt identifies its committed user message inside one native turn. */
export class PromptCorrelation {
  private readonly pending: SessionEventNotification[] = [];
  private messageId?: string;
  private lastSeq: number;
  private currentTurn?: number;
  constructor(
    private readonly lease: RuntimeLeaseV2,
    private readonly bind: (messageId: string, turn: number) => void
  ) {
    this.lastSeq = lease.seq;
  }
  get turn(): number | undefined {
    return this.currentTurn;
  }
  receipt(messageId: string): SessionEventNotification[] {
    this.messageId = messageId;
    return this.correlate();
  }
  observe(notification: SessionEventNotification): SessionEventNotification[] {
    if (notification.sessionId !== this.lease.sessionId || notification.event.seq <= this.lease.seq)
      return [];
    if (this.currentTurn !== undefined) return this.select([notification]);
    if (this.pending.length >= 512) throw new Error('prompt-correlation-overflow');
    this.pending.push(notification);
    return this.correlate();
  }
  private correlate(): SessionEventNotification[] {
    if (!this.messageId || this.currentTurn !== undefined) return [];
    const match = this.findTurn(this.messageId);
    if (!match) return [];
    this.currentTurn = match.turn;
    this.bind(this.messageId, match.turn);
    const events = this.select(this.pending.filter((n) => n.event.seq >= match.start));
    this.pending.length = 0;
    return events;
  }
  private findTurn(messageId: string): { turn: number; start: number } | undefined {
    let candidate: { turn: number; start: number } | undefined;
    for (const n of this.pending) {
      const data = n.event.data as { turn?: number; id?: string };
      if (
        n.event.type === 'turn/start' &&
        typeof data.turn === 'number' &&
        data.turn > this.lease.turn
      )
        candidate = { turn: data.turn, start: n.event.seq };
      if (n.event.type === 'user/message' && data.id === messageId) return candidate;
    }
    return undefined;
  }
  private select(events: readonly SessionEventNotification[]): SessionEventNotification[] {
    return events.filter((n) => {
      const data = n.event.data as { turn?: number };
      if (
        n.event.seq <= this.lastSeq ||
        (data.turn !== undefined && data.turn !== this.currentTurn)
      )
        return false;
      if (n.event.type === 'turn/end' && data.turn !== this.currentTurn) return false;
      this.lastSeq = n.event.seq;
      return true;
    });
  }
}
