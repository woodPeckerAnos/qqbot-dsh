/**
 * Task 架构装配与资源生命周期：独立状态存储、双 runtime 池、控制桥和出口回调。
 * 恢复先登记一次中断产物，再结算旧执行，最后释放孤立预算与到期工作区。
 * close 先取消执行并等待 runtime 收尾，再解绑出口，保留持久化待发消息。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import type { BotConnector, NormalizedMessage } from '../core/connector.js';
import { RuntimePool, type RuntimePoolOptions } from '../dsh/pool.js';
import type { DocumentExtractor } from '../dsh/files.js';
import type { Logger } from '../logger.js';
import type { PipelineStats } from '../pipeline/stats.js';
import type { TopicJudge } from '../pipeline/topic-judge.js';
import type { ConversationStore } from '../store/conversations.js';
import type { ObservationWindowStore } from '../store/window.js';
import type { StorePaths } from '../store/paths.js';
import { TaskStore } from '../store/tasks.js';
import { Responder } from '../pipeline/egress/responder.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import { TaskLifeCycleManager } from './lifecycle.js';
import { TaskBudget, type BudgetRecord } from './budget.js';
import { MessageQueue, type QueuedMessage } from './message-queue.js';
import { PromptPreparer } from './prompt-preparer.js';
import { SessionOutputCoordinator } from './output-coordinator.js';
import { LaneScheduler } from './lane-scheduler.js';
import { TaskControlBridge } from './control-bridge.js';
import { DshLaneRunner, type LaneRunner } from './dsh-lane-runner.js';
import { SessionActor, type SessionContextState } from './session-actor.js';
import { ProactiveTaskAdapter } from './proactive-adapter.js';
import type { TaskClock } from './clock.js';
import type { Lane, TaskSnapshot } from './types.js';

export class TaskSystem {
  readonly manager: TaskLifeCycleManager;
  readonly budget: TaskBudget;
  readonly queue: MessageQueue;
  readonly pools: Record<Lane, RuntimePool>;
  readonly actor: SessionActor;
  readonly output: SessionOutputCoordinator;
  readonly proactive: ProactiveTaskAdapter;
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
      modelPatches?: string[];
      pools?: Record<Lane, RuntimePool>;
      runner?: LaneRunner;
      clock?: TaskClock;
      runtimeFactory?: RuntimePoolOptions['runtimeFactory'];
    }
  ) {
    const { config, logger, paths } = options;
    this.manager = new TaskLifeCycleManager({
      store: new TaskStore<TaskSnapshot>(join(paths.stateDir, 'tasks.json')),
      now: options.clock ? () => options.clock!.now() : undefined,
      maxPerSession: config.tasks.maxPerSession,
      maxGlobal: config.tasks.maxGlobal,
      retentionMs: config.tasks.retentionMs,
      logger,
    });
    this.budget = new TaskBudget(
      new TaskStore<BudgetRecord>(join(paths.stateDir, 'task-budgets.json'))
    );
    this.queue = new MessageQueue({
      connectors: options.connectors,
      store: new TaskStore<QueuedMessage>(join(paths.stateDir, 'messages.json')),
      logger,
      clock: options.clock,
    });
    const preparer = (this.preparer = new PromptPreparer(options));
    this.pools =
      options.pools ??
      (Object.fromEntries(
        (['fast', 'slow'] as const).map((lane) => [
          lane,
          new RuntimePool({
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
    let actor!: SessionActor;
    const control = new TaskControlBridge(this.manager, (id) => actor.cancelExecution(id));
    this.output = new SessionOutputCoordinator({
      manager: this.manager,
      budget: this.budget,
      queue: this.queue,
      clock: options.clock,
      reminderMs: config.tasks.reminderMs,
      filesDir: join(paths.stateDir, 'message-files'),
      maxChars: (task) =>
        options.connectors
          .get(task.input.message.target.platform)!
          .policy(task.input.message.target.kind).maxChars,
      onDelivered: (candidate, ts) => {
        const reference = candidate.reference;
        const text = candidate.text || `[附件：${candidate.attachment?.fileName ?? ''}]`;
        options.conversations.append(candidate.message.target.key, {
          role: 'assistant',
          speaker: 'bot',
          text,
          ts,
          replyToMsgId: candidate.message.msgId || undefined,
          reference,
          taskId: candidate.taskId,
          lane: candidate.lane,
        });
        options.windows.recordBotReply(candidate.message.target.key, {
          text,
          ts,
          reference,
          taskId: candidate.taskId,
          lane: candidate.lane,
        });
        options.stats.repliesSent++;
        this.proactive?.delivered(candidate, ts);
      },
      onBudgetSettled: (id, result) => this.proactive?.settled(id, result),
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
      });
    actor = this.actor = new SessionActor({
      manager: this.manager,
      budget: this.budget,
      output: this.output,
      preparer,
      runner,
      schedulers: {
        fast: new LaneScheduler(config.tasks.fastRuntimes),
        slow: new LaneScheduler(config.tasks.slowRuntimes),
      },
      clock: options.clock,
      sessions: new TaskStore<SessionContextState>(join(paths.stateDir, 'task-sessions.json')),
    });
    this.proactive = new ProactiveTaskAdapter({
      actor,
      connectors: options.connectors,
      logger,
      context: (message, connector) => ({
        message,
        connector,
        isAdmin: false,
        policy: connector.policy(message.target.kind),
        logger,
        responder: new Responder({ message, queue: this.queue }),
      }),
    });
    // 必须先登记中断产物再改变执行状态，避免预留预算在失败消息入队前被释放。
    for (const task of this.manager
      .list()
      .filter((t) => t.status === 'pending' || t.status === 'running')) {
      this.queue.enqueue(
        {
          taskId: task.taskId,
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
    this.manager.list().forEach((t) => this.output.reconcile(t.taskId));
    void this.prune();
    this.maintenance = setInterval(() => {
      this.queue.wake();
      void this.prune();
    }, 30_000);
    this.maintenance.unref();
  }
  /** Task 工作区与协调器缓存一起到期；待发附件副本不受此清理影响。 */
  async prune(): Promise<void> {
    for (const task of this.manager.prune()) {
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
  context(message: NormalizedMessage, isAdmin = false): MessageContext {
    const connector = this.options.connectors.get(message.target.platform)!;
    return {
      message,
      connector,
      isAdmin,
      policy: connector.policy(message.target.kind),
      logger: this.options.logger,
      responder: new Responder({ message, queue: this.queue }),
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
    this.queue.close();
  }
}
