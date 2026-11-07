import type {
  RuntimePool,
  MessageQueue,
  SessionOutputCoordinatorV2 as SessionOutputCoordinator,
} from '@qqbot/contracts';
/**
 * Task 架构装配与资源生命周期：独立状态存储、双 runtime 池、控制桥和出口回调。
 * 恢复先登记一次中断产物，再结算旧执行，最后释放孤立预算与到期工作区。
 * close 先取消执行并等待 runtime 收尾，再解绑出口，保留持久化待发消息。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '@qqbot/contracts';
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
import { createResponder } from '../delivery/index.js';
import type { MessageContext } from '@qqbot/contracts';
import { TaskLifeCycleManager } from './lifecycle.js';
import { TaskBudget } from './budget.js';
import type { BudgetRecord } from '@qqbot/contracts';
import { createMessageQueue } from '../delivery/index.js';
import type { QueuedMessage } from '@qqbot/contracts';
import { PromptPreparer } from './prompt-preparer.js';
import { createSessionOutputCoordinatorV2 } from '../delivery/index.js';
import { LaneScheduler } from './lane-scheduler.js';
import { TaskControlBridge } from './control-bridge.js';
import { DshLaneRunner } from './dsh-lane-runner.js';
import type { LaneRunnerV2 as LaneRunner } from '@qqbot/contracts';
import { SessionActor } from './session-actor.js';
import { TaskCooperation } from './cooperation.js';
import type { SessionContextState } from '@qqbot/contracts';
import { ProactiveTaskAdapter } from './proactive-adapter.js';
import type { TaskClock } from '@qqbot/contracts';
import type { Lane, TaskSnapshotV2 as TaskSnapshot } from '@qqbot/contracts';

export class TaskSystem {
  readonly manager: TaskLifeCycleManager;
  readonly budget: TaskBudget;
  readonly queue: MessageQueue;
  readonly pools: Record<Lane, RuntimePool>;
  readonly actor: SessionActor;
  readonly output: SessionOutputCoordinator;
  readonly proactive: ProactiveTaskAdapter;
  readonly cooperation: TaskCooperation;
  private readonly maintenance: ReturnType<typeof setInterval>;
  private readonly preparer: PromptPreparer;
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
      pools?: Record<Lane, RuntimePool>;
      runner?: LaneRunner;
      clock?: TaskClock;
      runtimeFactory?: RuntimePoolOptions['runtimeFactory'];
    }
  ) {
    const { config, logger, paths } = options;
    const clock = options.clock;
    this.manager = new TaskLifeCycleManager({
      store: createStateWriter<TaskSnapshot, 'tasks'>('tasks', join(paths.stateDir, 'tasks.json')),
      now: clock === undefined ? undefined : () => clock.now(),
      maxPerSession: config.tasks.maxPerSession,
      maxGlobal: config.tasks.maxGlobal,
      retentionMs: config.tasks.retentionMs,
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
    this.cooperation = new TaskCooperation(this.manager, this.queue);
    const preparer = (this.preparer = new PromptPreparer(options));
    this.pools =
      options.pools ??
      (Object.fromEntries(
        (['fast', 'slow'] as const).map((lane) => [
          lane,
          createRuntimePool({
            maxRuntimes: config.tasks[lane === 'fast' ? 'fastRuntimes' : 'slowRuntimes'],
            runtimeIdleMs: config.pool.runtimeIdleMs,
            base: {
              bin: config.dsh.bin,
              profilePatch: config.dsh.profilePatch,
              patches: [
                ...(options.modelPatches ?? []),
                fileURLToPath(new URL('../../dsh-profile/lanes.patch.yml', import.meta.url)),
              ],
              dshHome: config.paths.dshHome,
              provider: config.tasks[lane === 'fast' ? 'fastProvider' : 'slowProvider'],
              model: config.tasks[lane === 'fast' ? 'fastModel' : 'slowModel'],
              ...(lane === 'fast' ? { reasoningEffort: 'off' } : {}),
              startTimeoutMs: config.dsh.runtimeStartTimeoutMs,
              shutdownTimeoutMs: config.dsh.runtimeShutdownTimeoutMs,
            },
            logger: logger.child({ lane }),
            runtimeFactory: options.runtimeFactory,
          }),
        ])
      ) as Record<Lane, RuntimePool>);
    const control = new TaskControlBridge(this.manager, (id) => {
      this.actor.cancelExecution(id);
    });
    this.output = createSessionOutputCoordinatorV2({
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
        const reference = candidate.reference;
        const text = candidate.text || `[附件：${candidate.attachment?.fileName ?? ''}]`;
        const stored = options.conversations.appendResult(candidate.message.target.key, {
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
          logger.warn('已发送回复的历史保存降级', {
            code: stored.error.code,
            errorId: logger.cause(stored.error.cause, 'persistence'),
          });
        options.windows.recordBotReply(candidate.message.target.key, {
          text,
          ts,
          reference,
          taskId: candidate.taskId,
          lane: candidate.lane,
        });
        options.stats.record('repliesSent');
        this.proactive?.delivered(candidate, ts);
      },
      onBudgetSettled: (id, result) => {
        this.proactive?.settled(id, result);
      },
    });
    const runner =
      options.runner ??
      new DshLaneRunner({
        pools: this.pools,
        manager: this.manager,
        preparer,
        control,
        config,
        logger,
        clock: options.clock,
        cooperation: this.cooperation,
      });
    const actor = new SessionActor({
      manager: this.manager,
      budget: this.budget,
      output: this.output,
      preparer,
      runner,
      schedulers: {
        fast: new LaneScheduler(config.tasks.fastRuntimes, (error, taskId) => {
          logger.cause(error, 'persistence', { taskId });
        }),
        slow: new LaneScheduler(config.tasks.slowRuntimes, (error, taskId) => {
          logger.cause(error, 'persistence', { taskId });
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
    // 必须先登记中断产物再改变执行状态，避免预留预算在失败消息入队前被释放。
    for (const task of this.manager
      .list()
      .filter((t) => t.status === 'pending' || t.status === 'running')) {
      this.queue.enqueue(
        {
          taskId: task.taskId,
          trace: task.input.trace,
          lane: 'slow',
          message: task.input.message,
          reference: task.input.reference,
          text: '任务因服务重启而中断，请重新提交。',
          kind: 'error',
        },
        `${task.taskId}:restart-interrupted`
      );
    }
    this.manager.recover();
    // 预留后、Task 落盘前可能崩溃；孤立预算需收尾。即使终态 Task 已清理，
    // 持久化待发消息仍有权按原预算范围结算。
    for (const record of this.budget.list())
      if (!this.manager.get(record.taskId)) {
        this.budget.finish(record.taskId);
        this.output.reconcile(record.taskId);
      }
    this.manager.list().forEach((t) => {
      this.output.reconcile(t.taskId);
    });
    void this.prune();
    this.maintenance = setInterval(() => {
      actor.flushSettlements();
      this.queue.wake();
      for (const record of this.budget.list()) {
        if (record.status !== 'reserved') continue;
        try {
          this.output.reconcile(record.taskId);
        } catch (error) {
          options.logger.cause(error, 'budget-settlement-persistence-failed');
        }
      }
      void this.prune();
    }, 30_000);
    this.maintenance.unref();
  }
  /** Task 工作区与协调器缓存一起到期；待发附件副本不受此清理影响。 */
  async prune(): Promise<void> {
    for (const task of this.manager.prune()) {
      this.output.forget(task.taskId);
      this.cooperation.forget(task.taskId);
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
    this.actor.close();
    await Promise.allSettled(Object.values(this.pools).map((pool) => pool.disposeAll()));
    await Promise.allSettled(
      this.manager.list().map((task) => this.manager.handle(task.taskId).done)
    );
    this.output.close();
    this.cooperation.close();
    this.queue.close();
  }
}
