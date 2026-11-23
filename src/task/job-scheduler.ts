import { failure, readonlySnapshot, SYSTEM_CLOCK } from '@qqbot/contracts';
import type {
  DeepReadonly,
  JobSchedulerV3 as SchedulerContract,
  Result,
  ScheduledTaskJobV3,
  TaskJobOutcomeV3,
  TaskJobV3,
  createJobSchedulerFactoryV3,
} from '@qqbot/contracts';

interface SessionJobQueue {
  frontend: ScheduledTaskJobV3[];
  summary: ScheduledTaskJobV3[];
  worker: ScheduledTaskJobV3[];
  next: 'frontend' | 'summary';
}
/** AbortController、排队截止定时器与运行名额均由此调度器独占。 */
export class JobSchedulerV3 implements SchedulerContract {
  private readonly queues = new Map<string, SessionJobQueue>();
  private readonly running = new Map<
    string,
    { job: ScheduledTaskJobV3; controller: AbortController; done: Promise<void> }
  >();
  private readonly settlements = new Map<
    string,
    { job: ScheduledTaskJobV3; result: TaskJobOutcomeV3 }
  >();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly jobs = new Set<string>();
  private readonly clock;
  private readonly capacity: number;
  private closed = false;
  constructor(
    private readonly options: NonNullable<Parameters<createJobSchedulerFactoryV3>[0]> = {}
  ) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.capacity = options.capacity ?? 4;
    if (!Number.isInteger(this.capacity) || this.capacity < 1)
      throw new Error('job 执行额度必须 >= 1');
  }
  enqueue(job: ScheduledTaskJobV3): Result<void> {
    if (this.closed) return { ok: false, error: failure('CLOSED', job.job.jobId) };
    if (this.jobs.has(job.job.jobId)) return { ok: true, value: undefined };
    this.jobs.add(job.job.jobId);
    if (job.job.deadlineAt <= this.clock.now()) {
      this.settle(job, failedOutcome(job.job.kind, 'TIMEOUT'));
      return { ok: true, value: undefined };
    }
    const key = job.job.sessionKey;
    const queue = this.queues.get(key) ?? {
      frontend: [],
      summary: [],
      worker: [],
      next: 'frontend',
    };
    queue[job.job.kind].push(job);
    this.queues.set(key, queue);
    this.timers.set(
      job.job.jobId,
      this.clock.setTimeout(() => {
        this.removeQueuedJob(job.job.jobId);
        this.settle(job, failedOutcome(job.job.kind, 'TIMEOUT'));
        this.pump();
      }, job.job.deadlineAt - this.clock.now())
    );
    queueMicrotask(() => {
      this.pump();
    });
    return { ok: true, value: undefined };
  }
  cancel(taskId: string): void {
    for (const queue of this.queues.values())
      for (const kind of ['frontend', 'summary', 'worker'] as const) {
        const cancelled = queue[kind].filter((job) => job.job.taskId === taskId);
        queue[kind] = queue[kind].filter((job) => job.job.taskId !== taskId);
        for (const job of cancelled) {
          this.clearQueueTimer(job.job.jobId);
          this.settle(job, failedOutcome(job.job.kind, 'CANCELLED'));
        }
      }
    for (const active of this.running.values())
      if (active.job.job.taskId === taskId) active.controller.abort();
    this.pump();
  }
  snapshot(): DeepReadonly<{
    running: number;
    queued: number;
    longestWaitingMs: number;
    pendingSettlements: number;
  }> {
    const queued = [...this.queues.values()].flatMap((queue) => [
      ...queue.frontend,
      ...queue.summary,
      ...queue.worker,
    ]);
    return readonlySnapshot({
      running: this.running.size,
      queued: queued.length,
      longestWaitingMs: queued.reduce(
        (longest, job) => Math.max(longest, this.clock.now() - job.job.createdAt),
        0
      ),
      pendingSettlements: this.settlements.size,
    });
  }
  flushSettlements(): void {
    for (const { job, result } of [...this.settlements.values()]) this.settle(job, result);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const queue of this.queues.values())
      for (const job of [...queue.frontend, ...queue.summary, ...queue.worker]) {
        this.clearQueueTimer(job.job.jobId);
        this.settle(job, failedOutcome(job.job.kind, 'CANCELLED'));
      }
    this.queues.clear();
    const active = [...this.running.values()];
    for (const item of active) item.controller.abort();
    await Promise.all(active.map((item) => item.done));
    this.flushSettlements();
  }
  private pump(): void {
    if (this.closed) return;
    for (const [sessionKey, queue] of this.queues) {
      if (this.running.size >= this.capacity) break;
      if (this.running.has(sessionKey)) continue;
      const job = dequeueSessionJob(queue);
      if (!job) {
        this.queues.delete(sessionKey);
        continue;
      }
      if (job.job.kind !== 'worker')
        queue.next = job.job.kind === 'frontend' ? 'summary' : 'frontend';
      this.clearQueueTimer(job.job.jobId);
      const controller = new AbortController();
      const done = Promise.resolve()
        .then(() => job.run(controller.signal))
        .catch((cause: unknown) =>
          failedOutcome(
            job.job.kind,
            controller.signal.aborted ? 'CANCELLED' : 'UPSTREAM_FAILED',
            cause
          )
        )
        .then((result) => {
          this.settle(
            job,
            controller.signal.aborted ? failedOutcome(job.job.kind, 'CANCELLED') : result
          );
        })
        .finally(() => {
          this.running.delete(sessionKey);
          const remaining = this.queues.get(sessionKey);
          if (remaining) {
            this.queues.delete(sessionKey);
            this.queues.set(sessionKey, remaining);
          }
          this.pump();
        });
      this.running.set(sessionKey, { job, controller, done });
    }
  }
  private settle(job: ScheduledTaskJobV3, result: TaskJobOutcomeV3): void {
    let saved: Result<void>;
    try {
      saved = job.settle(structuredClone(result));
    } catch (cause) {
      saved = { ok: false, error: failure('PERSISTENCE_FAILED', cause) };
    }
    if (saved.ok) {
      this.settlements.delete(job.job.jobId);
      this.jobs.delete(job.job.jobId);
      return;
    }
    this.settlements.set(job.job.jobId, { job, result: structuredClone(result) });
    try {
      this.options.onSettlementError?.(saved.error, job.job.jobId);
    } catch {
      /* 观察者异常不能丢弃已完成结果；维护仍按 jobId 补保存。 */
    }
  }
  private removeQueuedJob(jobId: string): void {
    for (const queue of this.queues.values())
      for (const kind of ['frontend', 'summary', 'worker'] as const)
        queue[kind] = queue[kind].filter((job) => job.job.jobId !== jobId);
    this.clearQueueTimer(jobId);
  }
  private clearQueueTimer(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.timers.delete(jobId);
  }
}

function dequeueSessionJob(queue: SessionJobQueue): ScheduledTaskJobV3 | undefined {
  const preferred = queue.next;
  return (
    queue[preferred].shift() ??
    queue[preferred === 'frontend' ? 'summary' : 'frontend'].shift() ??
    queue.worker.shift()
  );
}

function failedOutcome(
  kind: TaskJobV3['kind'],
  code: 'CANCELLED' | 'TIMEOUT' | 'UPSTREAM_FAILED',
  cause?: unknown
): TaskJobOutcomeV3 {
  return { kind, result: { ok: false, error: failure(code, cause) } };
}
