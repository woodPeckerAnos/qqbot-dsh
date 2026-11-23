import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  TaskSystemV3,
  TaskRunnerV3,
  TaskSnapshotV3,
  TaskJobV3,
  DeepReadonly,
  JobExecutionV3,
} from '@qqbot/contracts';
import { createTaskSystemV3, createTaskControlBridgeV3 } from '../../../src/task/index.js';
import { loadConfigV3 as loadConfig } from '../../../src/config/index.js';
import { createLogger, createPipelineStats } from '../../../src/observability/index.js';
import {
  createConversationStore,
  createObservationWindowStore,
  resolveStorePaths,
  ensureStoreDirs,
} from '../../../src/store/index.js';
import { MemoryConnector } from '../session/connector.js';
import { BenchmarkClock } from '../session/clock.js';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function bindExecution(
  system: TaskSystemV3,
  task: DeepReadonly<TaskSnapshotV3>,
  job: DeepReadonly<TaskJobV3>
): JobExecutionV3 {
  const execution = {
    jobId: job.jobId,
    executionId: `${job.jobId}:execution`,
    runtimeGeneration: 'offline',
    sessionId: job.jobId,
  };
  const result = system.manager.bindExecution(task.taskId, job.jobId, execution);
  if (!result.ok) throw new Error('绑定离线执行失败', { cause: result.error });
  return execution;
}

export async function createHarness(hooks: Partial<TaskRunnerV3> = {}, root?: string) {
  const directory = root ?? (await mkdtemp(join(tmpdir(), 'tasks-v3-')));
  const config = loadConfig({
    BOT_CONNECTORS: 'onebot',
    ONEBOT_ACCESS_TOKEN: 'offline',
    DEEPSEEK_API_KEY: 'offline',
  });
  const paths = resolveStorePaths({
    stateDir: join(directory, 'state'),
    workspacesRoot: join(directory, 'workspaces'),
  });
  ensureStoreDirs(paths);
  config.paths.dshHome = join(directory, 'dsh');
  const logger = createLogger({ autoTick: false, sink: () => {} });
  const connector = new MemoryConnector();
  const clock = new BenchmarkClock();
  connector.now = clock.now;
  const counts = { frontend: 0, worker: 0, summary: 0 };
  const runner: TaskRunnerV3 = {
    async runFrontend(task, job, context, signal) {
      counts.frontend++;
      const execution = bindExecution(system, task, job);
      if (hooks.runFrontend) return hooks.runFrontend(task, job, context, signal);
      const controls = createTaskControlBridgeV3(
        system.manager,
        (id) => {
          system.actor.cancelExecution(id);
        },
        system.queue
      ).bind(task, job, execution);
      if (task.input.message.content.includes('长任务')) {
        const result = controls.startWorker({
          instruction: '完成业务',
          deliverables: ['业务结果'],
          acknowledgement: '已接下这项工作，完成后回复。',
        });
        return result.ok ? { ok: true, value: { kind: 'dispatched' } } : result;
      }
      const oldResult = task.input.progressOnly ? controls.query(task.input.followUpOf) : undefined;
      let text = `答复：${task.input.message.content}`;
      if (task.input.progressOnly) {
        text =
          oldResult?.ok && oldResult.value[0]?.worker?.result?.status === 'completed'
            ? `业务执行已完成，保存结果：${oldResult.value[0].worker.result.text}`
            : '任务仍在执行，送达状态将在结果准备后更新。';
      }
      return {
        ok: true,
        value: { kind: 'reply', reply: { replyId: `${task.taskId}:reply`, text } },
      };
    },
    async runWorker(task, job, context, signal) {
      counts.worker++;
      bindExecution(system, task, job);
      if (hooks.runWorker) return hooks.runWorker(task, job, context, signal);
      return {
        ok: true,
        value: {
          status: 'completed',
          text: '完整业务结果：20',
          evidence: ['12+8=20'],
          attachments: [],
          unfinished: [],
        },
      };
    },
    async runSummary(task, job, context, signal) {
      counts.summary++;
      bindExecution(system, task, job);
      if (hooks.runSummary) return hooks.runSummary(task, job, context, signal);
      return {
        ok: true,
        value: {
          replyId: `${task.taskId}:reply`,
          text: '整理后的结果：20',
          attachments: [...(task.worker?.result?.attachments ?? [])],
        },
      };
    },
  };
  const system = createTaskSystemV3({
    config,
    logger,
    paths,
    clock,
    runner,
    connectors: new Map([['onebot', connector]]),
    stats: createPipelineStats(),
    conversations: createConversationStore(paths, logger),
    windows: createObservationWindowStore({ allowlist: [], maxMessages: 100, maxAgeMs: 86400000 }),
  });
  let serial = 0;
  return {
    system,
    root: directory,
    connector,
    clock,
    counts,
    paths,
    async submit(content: string, session = 'group', senderId = 'member') {
      const id = `m${++serial}`;
      return system.actor.submit(
        system.context({
          kind: 'group-message',
          target: {
            platform: 'onebot',
            kind: 'group',
            id: session,
            key: `onebot:group:${session}`,
          },
          senderId,
          content,
          msgId: id,
          eventId: id,
          ts: clock.now(),
          raw: {},
        })
      );
    },
    observe(
      predicate: (task: DeepReadonly<TaskSnapshotV3>) => boolean
    ): Promise<DeepReadonly<TaskSnapshotV3>> {
      const existing = system.manager.list().find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const off = system.manager.onChange((task) => {
          if (predicate(task)) {
            off();
            resolve(task);
          }
        });
      });
    },
    delivery(taskId: string): Promise<void> {
      if (system.queue.taskDelivery(taskId).success && !system.queue.taskDelivery(taskId).pending)
        return Promise.resolve();
      return new Promise((resolve) => {
        const off = system.queue.onDelivery((result) => {
          if (result.taskId === taskId && !system.queue.taskDelivery(taskId).pending) {
            off();
            resolve();
          }
        });
      });
    },
    async close() {
      await system.close();
      await connector.stop();
    },
    async remove() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
