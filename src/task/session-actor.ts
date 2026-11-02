/**
 * Session 输入协调者，拥有上下文 generation 和逐 Session 的输入事务顺序。
 * 只等待输入判定与准入；提交两条 lane 后立即返回 handle，执行与投递独立推进。
 * 取消请求先记入管理器，再交给调度器；已入队产物由消息队列继续处理。
 */
import { randomUUID } from 'node:crypto';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { TaskLifeCycleManager } from './lifecycle.js';
import type { PromptPreparer } from './prompt-preparer.js';
import type { LaneScheduler } from './lane-scheduler.js';
import type { LaneRunner } from './dsh-lane-runner.js';
import type { SessionOutputCoordinator } from './output-coordinator.js';
import type { TaskBudget } from './budget.js';
import type { TaskClock } from './clock.js';
import type { TaskStore } from '../store/tasks.js';
import {
  LANES,
  isTaskTerminal,
  type Lane,
  type LaneResult,
  type TaskHandle,
  type TaskInput,
} from './types.js';

export class SessionActor {
  private readonly generations = new Map<string, { generation: number; sinceTs: number }>();
  /** 串行的是输入判定与提交，不能把 Task.done 或发送 Promise 放进这个门闩。 */
  private readonly inputs = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    private readonly options: {
      manager: TaskLifeCycleManager;
      preparer: PromptPreparer;
      schedulers: Record<Lane, LaneScheduler>;
      runner: LaneRunner;
      output: SessionOutputCoordinator;
      budget: TaskBudget;
      clock?: TaskClock;
      sessions?: TaskStore<SessionContextState>;
    }
  ) {
    for (const state of options.sessions?.load() ?? [])
      this.generations.set(state.sessionKey, state);
  }
  /** 主动请求在等待输入门闩之前固定触发上下文，避免换成后来话题。 */
  async submit(
    context: MessageContext,
    proactive?: TaskInput['proactive'],
    budgetLimit?: number
  ): Promise<TaskHandle> {
    context = { ...context, message: structuredClone(context.message) };
    const key = context.message.target.key;
    const triggerGeneration = this.generations.get(key) ?? { generation: 1, sinceTs: 0 };
    const frozenProactive = proactive
      ? {
          generation: triggerGeneration.generation,
          context: this.options.preparer.capture(context.message, triggerGeneration.sinceTs),
        }
      : undefined;
    const previous = this.inputs.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.inputs.set(key, gate);
    await previous;
    try {
      if (this.closed) throw new Error('SessionActor 已关闭');
      this.options.manager.assertAdmission(key);
      const generation = this.generations.get(key) ?? { generation: 1, sinceTs: 0 };
      const captured = this.options.preparer.capture(context.message, generation.sinceTs);
      const verdict = proactive
        ? { related: true, mentionsChatRecord: false }
        : await this.options.preparer.judge(context.message, captured);
      // 判定期间 /new 可以推进 generation，不能用判定前的旧值覆盖它。
      let current = this.generations.get(key) ?? generation;
      if (!verdict.related && current === generation) {
        current = { generation: generation.generation + 1, sinceTs: context.message.ts };
      }
      if (!proactive) {
        this.generations.set(key, current);
        this.persistSessions();
      }
      const input: TaskInput = {
        message: context.message,
        isAdmin: context.isAdmin,
        source: proactive ? 'proactive' : 'user',
        generation: frozenProactive?.generation ?? current.generation,
        reference: {
          messageId: context.message.msgId || undefined,
          excerpt: context.message.content.slice(0, 500),
          senderId: context.message.senderId,
          senderName: context.message.username,
          ts: context.message.ts,
        },
        context:
          frozenProactive?.context ??
          (current !== generation
            ? this.options.preparer.capture(context.message, current.sinceTs)
            : captured),
        proactive,
      };
      input.context.mentionsChatRecord = verdict.mentionsChatRecord;
      const id = randomUUID();
      if (proactive && !this.options.budget.reserve(id, proactive.budgetScope, budgetLimit ?? 1))
        throw new Error('主动 Task 预算已耗尽');
      let handle: TaskHandle;
      try {
        handle = this.options.manager.create(input, id);
      } catch (error) {
        this.options.budget.settle(id, false, true);
        throw error;
      }
      const task = this.options.manager.get(id)!;
      // 中间不 await；调度在微任务中开始，确保两个 lane 都入队后才执行。
      for (const lane of LANES)
        this.options.schedulers[lane].enqueue({
          task,
          run: async (signal) => {
            let result: LaneResult;
            try {
              result = await this.options.runner.run(task, lane, context, signal);
            } catch (error) {
              result = signal.aborted
                ? { kind: 'cancelled' }
                : { kind: 'failed', text: '任务执行失败。', error: String(error) };
            }
            // 先整理并入队产物，再提交执行终态，防止主动预算提前释放。
            try {
              await this.options.output.accept(task, lane, result);
            } catch (error) {
              const failure: LaneResult = {
                kind: 'failed',
                text: '任务产物整理失败。',
                error: String(error),
              };
              await this.options.output.accept(task, lane, failure);
              return failure;
            }
            return result;
          },
          settle: (result) => this.options.manager.finish(id, lane, result),
        });
      void handle.done.then(() => this.options.preparer.release(id));
      return handle;
    } finally {
      release();
      if (this.inputs.get(key) === gate) this.inputs.delete(key);
    }
  }
  cancel(taskId: string): boolean {
    const { accepted } = this.options.manager.cancel(taskId);
    if (accepted) this.cancelExecution(taskId);
    return accepted;
  }
  /** 控制桥已完成权限检查和取消状态写入时，调用此方法终止剩余调度。 */
  cancelExecution(taskId: string): void {
    for (const lane of LANES) this.options.schedulers[lane].cancel(taskId);
  }
  /** /stop 仅选择命令到达时有模型执行的 Task，保留其他排队 Task。 */
  stop(sessionKey: string): number {
    const tasks = this.options.manager
      .list(sessionKey)
      .filter(
        (t) =>
          !isTaskTerminal(t) &&
          LANES.some(
            (l) => t.lanes[l].status === 'running' && t.lanes[l].executionEndedAt === undefined
          )
      );
    tasks.forEach((t) => this.cancel(t.taskId));
    return tasks.length;
  }
  /** /new 清空未完成执行并持久化新回放边界；已完成 Task 的消息继续投递。 */
  reset(sessionKey: string): number {
    const previous = this.generations.get(sessionKey);
    this.generations.set(sessionKey, {
      generation: (previous?.generation ?? 1) + 1,
      sinceTs: this.options.clock?.now() ?? Date.now(),
    });
    this.persistSessions();
    const tasks = this.options.manager.list(sessionKey).filter((t) => !isTaskTerminal(t));
    tasks.forEach((t) => this.cancel(t.taskId));
    return tasks.length;
  }
  snapshot() {
    return {
      fast: this.options.schedulers.fast.snapshot(),
      slow: this.options.schedulers.slow.snapshot(),
      unfinished: this.options.manager.list().filter((t) => !isTaskTerminal(t)).length,
    };
  }
  close(): void {
    this.closed = true;
    this.options.manager
      .list()
      .filter((t) => !isTaskTerminal(t))
      .forEach((t) => this.cancel(t.taskId));
    LANES.forEach((l) => this.options.schedulers[l].close());
  }
  private persistSessions(): void {
    this.options.sessions?.save(
      [...this.generations].map(([sessionKey, state]) => ({ sessionKey, ...state }))
    );
  }
}
export interface SessionContextState {
  sessionKey: string;
  generation: number;
  sinceTs: number;
}
