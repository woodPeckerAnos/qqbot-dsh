import { readonlySnapshot } from '@qqbot/contracts';
import type { DeepReadonly } from '@qqbot/contracts';
/**
 * 单个 lane 的执行额度与 Session FIFO。快慢 lane 各自创建实例，互不等待。
 * 调度器拥有 AbortController 和运行名额，Task 状态通过 settle 交回管理器。
 * run 包含所属执行的产物收尾；finally 后才允许同 Session 的下一项开始。
 */
import type { LaneResultV3 as LaneResult, TaskSnapshotV3 as TaskSnapshot } from '@qqbot/contracts';

interface Job {
  task: DeepReadonly<TaskSnapshot>;
  run: (signal: AbortSignal) => Promise<LaneResult>;
  settle: (result: LaneResult) => void;
}
export class LaneScheduler {
  private readonly queues = new Map<string, Job[]>();
  private readonly running = new Map<string, { taskId: string; controller: AbortController }>();
  private readonly settlements = new Map<string, { job: Job; result: LaneResult }>();
  private closed = false;
  private readonly idleWaiters = new Set<() => void>();
  constructor(
    private readonly capacity = 4,
    private readonly onSettlementError?: (error: unknown, taskId: string) => void
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('lane 额度必须 >= 1');
  }
  enqueue(job: Job): void {
    if (this.closed) throw new Error('lane 已关闭');
    const key = job.task.input.message.target.key;
    const queue = this.queues.get(key) ?? [];
    queue.push(job);
    this.queues.set(key, queue);
    // 延后启动，让 Actor 能在同一同步事务中完整提交两个 lane。
    queueMicrotask(() => {
      this.pump();
    });
  }
  /** 排队项直接结算取消；运行项发出信号，并等待 runner 释放具体 runtime。 */
  cancel(taskId: string): void {
    for (const [key, queue] of this.queues) {
      const removed = queue.filter((j) => j.task.taskId === taskId);
      this.queues.set(
        key,
        queue.filter((j) => j.task.taskId !== taskId)
      );
      removed.forEach((j) => {
        this.settle(j, { kind: 'cancelled' });
      });
    }
    for (const active of this.running.values())
      if (active.taskId === taskId) active.controller.abort();
    this.pump();
  }
  snapshot(): DeepReadonly<{ running: number; queued: number }> {
    return readonlySnapshot({
      running: this.running.size,
      queued: [...this.queues.values()].reduce((n, q) => n + q.length, 0),
    });
  }
  close(): void {
    this.closed = true;
    for (const queue of this.queues.values())
      queue.forEach((j) => {
        this.settle(j, { kind: 'cancelled' });
      });
    this.queues.clear();
    this.running.forEach((r) => {
      r.controller.abort();
    });
    this.notifyIdle();
  }
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }
  private isIdle(): boolean {
    return (
      this.running.size === 0 && [...this.queues.values()].every((queue) => queue.length === 0)
    );
  }
  private notifyIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
  private pump(): void {
    this.flushSettlements();
    if (this.closed) return;
    for (const [key, queue] of this.queues) {
      if (this.running.size >= this.capacity) break;
      if (this.running.has(key)) continue;
      const job = queue.shift();
      if (!job) {
        this.queues.delete(key);
        continue;
      }
      const controller = new AbortController();
      this.running.set(key, { taskId: job.task.taskId, controller });
      void Promise.resolve()
        .then(() => job.run(controller.signal))
        .catch((error: unknown): LaneResult => ({
          kind: controller.signal.aborted ? 'cancelled' : 'failed',
          text: '任务执行失败。',
          error: String(error),
        }))
        .then((result) => {
          this.settle(job, result);
        })
        .finally(() => {
          this.running.delete(key);
          // 完成的 Session 轮转到末尾，保留其 FIFO 并让其他 Session 获得名额。
          const remaining = this.queues.get(key);
          if (remaining !== undefined) {
            this.queues.delete(key);
            this.queues.set(key, remaining);
          }
          this.pump();
          this.notifyIdle();
        });
    }
  }
  /** 只重试保存已完成结果，绝不重新执行 run；可由维护循环在存储恢复后唤醒。 */
  flushSettlements(): void {
    for (const { job, result } of this.settlements.values()) this.settle(job, result);
  }
  private settle(job: Job, result: LaneResult): void {
    try {
      job.settle(structuredClone(result));
      this.settlements.delete(job.task.taskId);
    } catch (error) {
      this.settlements.set(job.task.taskId, { job, result: structuredClone(result) });
      this.reportSettlementError(error, job.task.taskId);
    }
  }
  private reportSettlementError(error: unknown, taskId: string): void {
    try {
      this.onSettlementError?.(error, taskId);
    } catch {
      // 错误观察者不能移除待保存的结果，存储恢复后仍能完成同一结算。
    }
  }
}
