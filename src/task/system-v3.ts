import type {
  RuntimePool,
  MessageQueue,
  SessionOutputCoordinatorV3 as SessionOutputCoordinator,
} from '@qqbot/contracts';
/**
 * 前台与动态 worker 的装配；保存结果、固定回复和消息队列各有自己的恢复步骤。
 * close 先取消执行并等待 runtime 收尾，再解绑出口，保留持久化待发消息。
 */
import { join } from 'node:path';
import { TASK_RESTART_INTERRUPTION_TEXT } from '@qqbot/contracts';
import type { ConfigV3 as Config } from '@qqbot/contracts';
import type { BotConnector, NormalizedMessage } from '@qqbot/contracts';
import { createRuntimePool } from '../runtime/index.js';
import type { RuntimePoolOptions } from '@qqbot/contracts';
import type { DocumentExtractor } from '@qqbot/contracts';
import { createTrace } from '../observability/index.js';
import type { TraceContext, Logger } from '@qqbot/contracts';
import type { PipelineStats } from '@qqbot/contracts';
import type { TopicJudge } from '@qqbot/contracts';
import type { ConversationStore } from '@qqbot/contracts';
import type { ObservationWindowStore } from '@qqbot/contracts';
import type { StorePaths } from '@qqbot/contracts';
import { createStateWriter } from '../store/index.js';
import { createSessionContextViewV3 } from '../session/index.js';
import { createResponder } from '../delivery/index.js';
import type { MessageContext } from '@qqbot/contracts';
import { TaskLifeCycleManagerV3 } from './lifecycle-v3.js';
import { TaskBudget } from './budget.js';
import type { BudgetRecord } from '@qqbot/contracts';
import { createMessageQueue } from '../delivery/index.js';
import type { QueuedMessage } from '@qqbot/contracts';
import { PromptPreparerV3 } from './prompt-preparer-v3.js';
import { createSessionOutputCoordinatorV3 } from '../delivery/index.js';
import { JobSchedulerV3 } from './job-scheduler.js';
import { TaskControlBridgeV3 } from './control-bridge-v3.js';
import { DshTaskRunnerV3 } from './dsh-task-runner-v3.js';
import type { TaskRunnerV3 as LaneRunner } from '@qqbot/contracts';
import { SessionActorV3 } from './session-actor-v3.js';
import { buildTaskRuntimeBaseV3 } from './runtime-profile-v3.js';
import type { SessionContextState } from '@qqbot/contracts';
import { ProactiveTaskAdapter } from './proactive-adapter.js';
import type { TaskClock } from '@qqbot/contracts';

export class TaskSystemV3 {
  readonly manager: TaskLifeCycleManagerV3;
  readonly budget: TaskBudget;
  readonly queue: MessageQueue;
  readonly pools: Record<'frontend' | 'worker', RuntimePool>;
  readonly actor: SessionActorV3;
  readonly output: SessionOutputCoordinator;
  readonly proactive: ProactiveTaskAdapter;
  private readonly maintenance: ReturnType<typeof setInterval>;
  private readonly preparer: PromptPreparerV3;
  // 装配入口集中构造并注入协作者，保持完整依赖关系可直接阅读。
  // eslint-disable-next-line max-lines-per-function, max-statements
  constructor(
    private readonly options: {
      config: Config;
      logger: Logger;
      paths: StorePaths;
      connectors: ReadonlyMap<string, BotConnector>;
      conversations: ConversationStore;
      windows: ObservationWindowStore;
      stats: PipelineStats;
      extractDocument?: DocumentExtractor;
      topicJudge?: TopicJudge;
      topicJudgeResult?: import('@qqbot/contracts').TopicJudgeResult;
      modelPatches?: string[];
      pools?: Record<'frontend' | 'worker', RuntimePool>;
      runner?: LaneRunner;
      clock?: TaskClock;
      runtimeFactory?: RuntimePoolOptions['runtimeFactory'];
    }
  ) {
    const { config, logger, paths } = options;
    const clock = options.clock;
    this.manager = new TaskLifeCycleManagerV3({
      store: createStateWriter<unknown, 'tasks'>('tasks', join(paths.stateDir, 'tasks.json')),
      now: clock === undefined ? undefined : () => clock.now(),
      maxPerSession: config.tasks.maxPerSession,
      maxGlobal: config.tasks.maxGlobal,
      retentionMs: config.tasks.retentionMs,
      queueTimeoutMs: config.tasks.queueTimeoutMs,
      logger,
    });
    this.budget = new TaskBudget(
      createStateWriter<BudgetRecord, 'task-budgets'>(
        'task-budgets',
        join(paths.stateDir, 'task-budgets.json')
      )
    );
    this.queue = createMessageQueue({
      connectors: options.connectors,
      store: createStateWriter<QueuedMessage, 'messages'>(
        'messages',
        join(paths.stateDir, 'messages.json')
      ),
      logger,
      clock: options.clock,
    });
    const preparer = (this.preparer = new PromptPreparerV3(options));
    this.pools =
      options.pools ??
      (Object.fromEntries(
        (['frontend', 'worker'] as const).map((lane) => [
          lane,
          createRuntimePool({
            maxRuntimes: config.tasks[lane === 'frontend' ? 'fastRuntimes' : 'slowRuntimes'],
            runtimeIdleMs: 0,
            base: buildTaskRuntimeBaseV3(config, options.modelPatches),
            logger: logger.child({ role: lane }),
            runtimeFactory: options.runtimeFactory,
          }),
        ])
      ) as Record<'frontend' | 'worker', RuntimePool>);
    const control = new TaskControlBridgeV3(
      this.manager,
      (id) => {
        this.actor.cancelExecution(id);
      },
      this.queue
    );
    this.output = createSessionOutputCoordinatorV3({
      manager: this.manager,
      budget: this.budget,
      queue: this.queue,
      clock: options.clock,
      reminderMs: config.tasks.reminderMs,
      filesDir: join(paths.stateDir, 'message-files'),
      maxFileBytes: config.media.maxFileBytes,
      policy: (task) => {
        const connector = options.connectors.get(task.input.message.target.platform);
        if (connector === undefined) throw new Error('Task 所属平台没有连接器');
        return connector.policy(task.input.message.target.kind);
      },
      maxChars: (task) => {
        const connector = options.connectors.get(task.input.message.target.platform);
        if (connector === undefined) throw new Error('Task 所属平台没有连接器');
        return connector.policy(task.input.message.target.kind).maxChars;
      },
      onDelivered: (candidate, ts) => {
        this.recordDeliveredReply(candidate, ts);
      },
      onBudgetSettled: (id, result) => {
        this.proactive.settled(id, result);
      },
    });
    const runner =
      options.runner ??
      new DshTaskRunnerV3({
        pools: this.pools,
        manager: this.manager,
        preparer,
        control,
        config,
        logger,
        clock: options.clock,
        contextView: createSessionContextViewV3({
          settings: config.sessionContext,
          tasks: (key) => this.manager.list(key),
          messages: (id) => this.queue.messages(id),
          generation: (key) => this.actor.generation(key),
          sinceTs: (key) => this.actor.sinceTs(key),
          conversations: (key) => this.readConversations(key),
          window: (key) => options.windows.read(key),
          now: clock === undefined ? undefined : () => clock.now(),
        }),
      });
    const actor = new SessionActorV3({
      manager: this.manager,
      budget: this.budget,
      output: this.output,
      preparer,
      runner,
      sessionContext: config.sessionContext,
      context: (task) => this.context(task.input.message, task.input.isAdmin, task.input.trace),
      schedulers: {
        frontend: new JobSchedulerV3({
          capacity: config.tasks.fastRuntimes,
          clock: options.clock,
          onSettlementError: (error, jobId) => {
            logger.cause(error, 'persistence', { jobId });
          },
        }),
        worker: new JobSchedulerV3({
          capacity: config.tasks.slowRuntimes,
          clock: options.clock,
          onSettlementError: (error, jobId) => {
            logger.cause(error, 'persistence', { jobId });
          },
        }),
      },
      clock: options.clock,
      sessions: createStateWriter<SessionContextState, 'task-sessions'>(
        'task-sessions',
        join(paths.stateDir, 'task-sessions.json')
      ),
    });
    this.actor = actor;
    this.proactive = new ProactiveTaskAdapter({
      actor,
      connectors: options.connectors,
      logger,
      context: (message, connector, trace) => ({
        trace,
        message,
        connector,
        isAdmin: false,
        policy: connector.policy(message.target.kind),
        logger,
        responder: createResponder({ message, queue: this.queue, trace }),
      }),
    });
    for (const task of this.manager.pendingLegacyInterruptions()) {
      this.queue.enqueue(
        {
          taskId: task.taskId,
          trace: task.input.trace,
          lane: 'slow',
          message: task.input.message,
          reference: task.input.reference,
          text: TASK_RESTART_INTERRUPTION_TEXT,
          kind: 'error',
          notification: true,
        },
        `${task.taskId}:restart-interrupted`
      );
    }
    const recovery = actor.recover();
    if (!recovery.ok) throw new Error('恢复任务失败', { cause: recovery.error });
    this.reconcileBudgets();
    void this.prune().catch((error: unknown) => {
      logger.cause(error, 'task-prune');
    });
    this.maintenance = setInterval(() => {
      try {
        actor.flushSettlements();
      } catch (error) {
        logger.cause(error, 'task-maintenance');
      }
      this.queue.wake();
      this.reconcileBudgets();
      void this.prune().catch((error: unknown) => {
        logger.cause(error, 'task-prune');
      });
    }, 30_000);
    this.maintenance.unref();
  }
  /** 孤立预留只结算一次；待发消息仍按原预算范围结算。 */
  private reconcileBudgets(): void {
    for (const record of this.budget.list()) {
      if (!this.manager.get(record.taskId)) this.budget.finish(record.taskId);
      if (record.status !== 'reserved') continue;
      try {
        this.output.reconcile(record.taskId);
      } catch (error) {
        this.options.logger.cause(error, 'budget-settlement-persistence-failed');
      }
    }
    for (const task of this.manager.list()) this.output.reconcile(task.taskId);
  }

  private readConversations(
    sessionKey: string
  ): import('@qqbot/contracts').DeepReadonly<import('@qqbot/contracts').ConversationTurn[]> {
    const result = this.options.conversations.readResult(sessionKey);
    if (!result.ok) {
      if (result.error.code === 'NOT_FOUND') return [];
      throw new Error('conversation-read-failed', { cause: result.error });
    }
    if (result.value.corrupted) throw new Error('conversation-partial-read');
    return result.value.turns;
  }

  private recordDeliveredReply(
    candidate: import('@qqbot/contracts').DeepReadonly<import('@qqbot/contracts').ReplyCandidate>,
    ts: number
  ): void {
    const reference = candidate.reference;
    const text = candidate.text || `[附件：${candidate.attachment?.fileName ?? ''}]`;
    const stored = this.options.conversations.appendResult(candidate.message.target.key, {
      role: 'assistant',
      speaker: 'bot',
      text,
      ts,
      replyToMsgId: candidate.message.msgId || undefined,
      reference,
      taskId: candidate.taskId,
      lane: candidate.lane,
    });
    if (!stored.ok)
      this.options.logger.warn('已发送回复的历史保存降级', {
        code: stored.error.code,
        errorId: this.options.logger.cause(stored.error.cause, 'persistence'),
      });
    this.options.windows.recordBotReply(candidate.message.target.key, {
      text,
      ts,
      reference,
      taskId: candidate.taskId,
      lane: candidate.lane,
    });
    this.options.stats.record('repliesSent');
    this.proactive.delivered(candidate, ts);
  }
  /** Task 工作区与协调器缓存一起到期；待发附件副本不受此清理影响。 */
  async prune(): Promise<void> {
    const result = this.manager.prune();
    if (!result.ok) throw new Error('清理到期任务失败', { cause: result.error });
    for (const task of result.value) {
      this.output.forget(task.taskId);
      try {
        await this.preparer.removeWorkspace(task);
      } catch (error) {
        this.options.logger.warn('清理到期 Task 工作区失败', {
          taskId: task.taskId,
          error: String(error),
        });
      }
    }
  }
  context(
    message: NormalizedMessage,
    isAdmin = false,
    suppliedTrace?: TraceContext
  ): MessageContext {
    const connector = this.options.connectors.get(message.target.platform);
    if (connector === undefined) {
      throw new Error(`未找到平台连接器：${message.target.platform}`);
    }
    const trace =
      suppliedTrace ??
      createTrace({
        sessionKey: message.target.key,
        inputMessageId: message.msgId,
        inputEventId: message.eventId,
      });
    return {
      trace,
      message,
      connector,
      isAdmin,
      policy: connector.policy(message.target.kind),
      logger: this.options.logger.withTrace(trace),
      responder: createResponder({ message, queue: this.queue, trace }),
    };
  }
  async close(): Promise<void> {
    clearInterval(this.maintenance);
    await this.actor.close();
    await Promise.allSettled(Object.values(this.pools).map((pool) => pool.disposeAll()));
    this.output.close();
    this.queue.close();
  }
}
