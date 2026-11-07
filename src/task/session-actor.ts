import { readonlySnapshot } from '@qqbot/contracts';

/**
 * Session 输入协调者，拥有上下文 generation 和逐 Session 的输入事务顺序。
 * 只等待输入判定与准入；提交两条 lane 后立即返回 handle，执行与投递独立推进。
 * 取消请求先记入管理器，再交给调度器；已入队产物由消息队列继续处理。
 */
import { randomUUID } from 'node:crypto';
import { createTrace, traceSpan } from '../observability/index.js';
import type { TraceContext } from '@qqbot/contracts';
import type { MessageContext } from '@qqbot/contracts';
import type { TaskLifeCycleManagerV3 as TaskLifeCycleManager } from '@qqbot/contracts';
import type { PromptPreparerV3 as PromptPreparer } from '@qqbot/contracts';
import type { LaneSchedulerV3 as LaneScheduler } from '@qqbot/contracts';
import type { LaneRunnerV3 as LaneRunner } from '@qqbot/contracts';
import type { SessionOutputCoordinatorV3 as SessionOutputCoordinator } from '@qqbot/contracts';
import type { TaskBudget } from '@qqbot/contracts';
import type { TaskClock } from '@qqbot/contracts';
import { LANES, isTaskTerminal } from '@qqbot/contracts';
import type {
  Lane,
  LaneResultV3 as LaneResult,
  TaskHandleV3 as TaskHandle,
  TaskInputV3 as TaskInput,
} from '@qqbot/contracts';

export class SessionActor {
  private readonly generations = new Map<
    string,
    { generation: number; sinceTs: number; sessionEpoch: number; resetSinceTs: number }
  >();
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
      sessions?: import('@qqbot/contracts').SessionStateWriterV3;
      resetLanes?: (sessionKey: string, sessionEpoch: number) => void;
      taskIdFactory?: () => string;
    }
  ) {
    for (const state of structuredClone(options.sessions?.load() ?? []))
      this.generations.set(state.sessionKey, upgradeSession(state));
  }
  /** 主动请求在等待输入门闩之前固定触发上下文，避免换成后来话题。 */
  async submit(
    context: MessageContext,
    proactive?: TaskInput['proactive'],
    budgetLimit?: number
  ): Promise<TaskHandle> {
    const trace =
      context.trace ??
      createTrace({
        sessionKey: context.message.target.key,
        inputMessageId: context.message.msgId,
        inputEventId: context.message.eventId,
      });
    context = {
      ...context,
      trace,
      logger: context.logger.withTrace(trace),
      message: structuredClone(context.message),
    };
    const key = context.message.target.key;
    const triggerGeneration = this.generations.get(key) ?? {
      generation: 1,
      sinceTs: 0,
      sessionEpoch: 1,
      resetSinceTs: 0,
    };
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
      this.assertOpen();
      this.options.manager.assertAdmission(key);
      const generation = this.generations.get(key) ?? {
        generation: 1,
        sinceTs: 0,
        sessionEpoch: 1,
        resetSinceTs: 0,
      };
      const captured = this.options.preparer.capture(context.message, generation.sinceTs);
      const verdict = proactive
        ? { related: true, mentionsChatRecord: false }
        : await this.options.preparer.judge(context.message, captured);
      context.logger.withTrace(traceSpan(trace)).event('input.decision', {
        related: verdict.related,
        mentionsChatRecord: verdict.mentionsChatRecord,
      });
      this.assertOpen();
      // 判定期间 /new 可以推进 generation，不能用判定前的旧值覆盖它。
      let current = this.generations.get(key) ?? generation;
      if (!verdict.related && current === generation) {
        current = {
          ...generation,
          generation: generation.generation + 1,
          sinceTs: context.message.ts,
        };
      }
      if (!proactive) {
        this.commitGeneration(key, current);
      }
      const input: TaskInput = {
        trace,
        message: context.message,
        isAdmin: context.isAdmin,
        source: proactive ? 'proactive' : 'user',
        generation: frozenProactive?.generation ?? current.generation,
        sessionEpoch: current.sessionEpoch,
        sessionReplay: this.options.preparer.capture(context.message, current.resetSinceTs).replay,
        topicChanged: !verdict.related,
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
      const id = this.options.taskIdFactory?.() ?? randomUUID();
      if (proactive && !this.options.budget.reserve(id, proactive.budgetScope, budgetLimit ?? 1))
        throw new Error('主动 Task 预算已耗尽');
      let handle: TaskHandle;
      try {
        handle = this.options.manager.create(input, id);
      } catch (error) {
        this.options.budget.settle(id, false, true);
        throw error;
      }
      const task = this.options.manager.get(id);
      if (task === undefined) throw new Error('Task 创建后未登记');
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
          settle: (result) => {
            this.options.manager.finish(id, lane, result);
          },
        });
      void handle.done.then(() => {
        this.options.preparer.release(id);
      });
      return handle;
    } catch (error) {
      context.logger.event('input.rejected', { reason: 'admission-failed' });
      throw error;
    } finally {
      release();
      if (this.inputs.get(key) === gate) this.inputs.delete(key);
    }
  }
  cancel(taskId: string, initiator?: TraceContext): boolean {
    const { accepted } = this.options.manager.cancel(taskId, initiator);
    if (accepted) this.cancelExecution(taskId);
    return accepted;
  }
  /** 控制桥已完成权限检查和取消状态写入时，调用此方法终止剩余调度。 */
  cancelExecution(taskId: string): void {
    for (const lane of LANES) this.options.schedulers[lane].cancel(taskId);
  }
  /** /stop 仅选择命令到达时有模型执行的 Task，保留其他排队 Task。 */
  stop(sessionKey: string, initiator?: TraceContext): number {
    const tasks = this.options.manager
      .list(sessionKey)
      .filter(
        (t) =>
          !isTaskTerminal(t) &&
          LANES.some(
            (l) => t.lanes[l].status === 'running' && t.lanes[l].executionEndedAt === undefined
          )
      );
    tasks.forEach((t) => this.cancel(t.taskId, initiator));
    return tasks.length;
  }
  /** /new 清空未完成执行并持久化新回放边界；已完成 Task 的消息继续投递。 */
  reset(sessionKey: string, initiator?: TraceContext): number {
    const previous = this.generations.get(sessionKey);
    const next = resetState(previous, this.options.clock?.now() ?? Date.now());
    this.commitGeneration(sessionKey, next);
    const tasks = this.options.manager.list(sessionKey).filter((t) => !isTaskTerminal(t));
    try {
      this.cancelAll(tasks, initiator);
    } finally {
      this.options.resetLanes?.(sessionKey, next.sessionEpoch);
    }
    return tasks.length;
  }
  snapshot() {
    return readonlySnapshot({
      fast: this.options.schedulers.fast.snapshot(),
      slow: this.options.schedulers.slow.snapshot(),
      unfinished: this.options.manager.list().filter((t) => !isTaskTerminal(t)).length,
    });
  }
  flushSettlements(): void {
    this.options.schedulers.fast.flushSettlements();
    this.options.schedulers.slow.flushSettlements();
  }
  close(): void {
    this.closed = true;
    try {
      this.cancelAll(this.options.manager.list().filter((t) => !isTaskTerminal(t)));
    } finally {
      LANES.forEach((l) => {
        this.options.schedulers[l].close();
      });
    }
  }
  async whenIdle(): Promise<void> {
    await Promise.all(LANES.map((lane) => this.options.schedulers[lane].whenIdle()));
  }
  private cancelAll(tasks: readonly { taskId: string }[], initiator?: TraceContext): void {
    let failure: { cause: unknown } | undefined;
    for (const task of tasks) {
      try {
        this.cancel(task.taskId, initiator);
      } catch (error) {
        failure ??= { cause: error };
        this.cancelExecution(task.taskId);
      }
    }
    if (failure)
      throw failure.cause instanceof Error
        ? failure.cause
        : new Error('取消 Task 状态保存失败', failure);
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('SessionActor 已关闭');
  }
  private commitGeneration(
    sessionKey: string,
    state: { generation: number; sinceTs: number; sessionEpoch: number; resetSinceTs: number }
  ): void {
    const next = new Map(this.generations);
    next.set(sessionKey, state);
    this.options.sessions?.save([...next].map(([key, value]) => ({ sessionKey: key, ...value })));
    this.generations.set(sessionKey, state);
  }
}
export type { SessionContextState } from '@qqbot/contracts';

function upgradeSession(
  state: import('@qqbot/contracts').SessionContextState &
    Partial<import('@qqbot/contracts').SessionContextStateV3>
): import('@qqbot/contracts').SessionContextStateV3 {
  return {
    ...state,
    sessionEpoch: state.sessionEpoch ?? 1,
    resetSinceTs: state.resetSinceTs ?? state.sinceTs,
  };
}
function resetState(
  previous: { generation: number; sessionEpoch: number } | undefined,
  now: number
) {
  return {
    generation: (previous?.generation ?? 1) + 1,
    sinceTs: now,
    sessionEpoch: (previous?.sessionEpoch ?? 1) + 1,
    resetSinceTs: now,
  };
}
