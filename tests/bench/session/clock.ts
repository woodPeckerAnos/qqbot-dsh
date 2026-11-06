import type { TaskClock } from '@qqbot/contracts';

export class BenchmarkClock implements TaskClock {
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
  get pending() {
    return this.timers.size;
  }
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
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

export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Real wall clock with observable timer ownership, for explicit model runs. */
export class RealtimeClock implements TaskClock {
  private timers = new Set<ReturnType<typeof setTimeout>>();
  now = () => Date.now();
  setTimeout = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  };
  clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer);
    clearTimeout(timer);
  };
  get pending() {
    return this.timers.size;
  }
}
