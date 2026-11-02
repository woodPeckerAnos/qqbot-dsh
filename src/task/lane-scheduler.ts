/**
 * 单个 lane 的执行额度与 Session FIFO。快慢 lane 各自创建实例，互不等待。
 * 调度器拥有 AbortController 和运行名额，Task 状态通过 settle 交回管理器。
 * run 包含所属执行的产物收尾；finally 后才允许同 Session 的下一项开始。
 */
import type { LaneResult, TaskSnapshot } from './types.js';

interface Job {
  task: Readonly<TaskSnapshot>;
  run: (signal: AbortSignal) => Promise<LaneResult>;
  settle: (result: LaneResult) => void;
}
export class LaneScheduler {
  private readonly queues = new Map<string, Job[]>();
  private readonly running = new Map<string, { taskId: string; controller: AbortController }>();
  private closed = false;
  constructor(private readonly capacity = 4) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('lane 额度必须 >= 1');
  }
  enqueue(job: Job): void {
    if (this.closed) throw new Error('lane 已关闭');
    const key = job.task.input.message.target.key;
    const queue = this.queues.get(key) ?? [];
    queue.push(job);
    this.queues.set(key, queue);
    // 延后启动，让 Actor 能在同一同步事务中完整提交两个 lane。
    queueMicrotask(() => this.pump());
  }
  /** 排队项直接结算取消；运行项发出信号，并等待 runner 释放具体 runtime。 */
  cancel(taskId: string): void {
    for (const [key, queue] of this.queues) {
      const removed = queue.filter((j) => j.task.taskId === taskId);
      this.queues.set(
        key,
        queue.filter((j) => j.task.taskId !== taskId)
      );
      removed.forEach((j) => j.settle({ kind: 'cancelled' }));
    }
    for (const active of this.running.values())
      if (active.taskId === taskId) active.controller.abort();
    this.pump();
  }
  snapshot(): { running: number; queued: number } {
    return {
      running: this.running.size,
      queued: [...this.queues.values()].reduce((n, q) => n + q.length, 0),
    };
  }
  close(): void {
    this.closed = true;
    for (const queue of this.queues.values()) queue.forEach((j) => j.settle({ kind: 'cancelled' }));
    this.queues.clear();
    this.running.forEach((r) => r.controller.abort());
  }
  private pump(): void {
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
        .catch(
          (error: unknown): LaneResult =>
            ({
              kind: controller.signal.aborted ? 'cancelled' : 'failed',
              text: '任务执行失败。',
              error: String(error),
            }) as LaneResult
        )
        .then((result) => job.settle(result))
        .finally(() => {
          this.running.delete(key);
          // 完成的 Session 轮转到末尾，保留其 FIFO 并让其他 Session 获得名额。
          if (this.queues.has(key)) {
            const remaining = this.queues.get(key)!;
            this.queues.delete(key);
            this.queues.set(key, remaining);
          }
          this.pump();
        });
    }
  }
}
