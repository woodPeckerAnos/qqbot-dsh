import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DshRuntimeOptions,
  PromptContentBlock,
  TaskJobKindV3,
  TaskSnapshotV3,
  DeepReadonly,
  FileConfig,
} from '@qqbot/contracts';
import { createTaskSystemV3 } from '../../src/task/index.js';
import { loadConfigV3 as loadConfig } from '../../src/config/index.js';
import { createLogger, createPipelineStats } from '../../src/observability/index.js';
import {
  createConversationStore,
  createObservationWindowStore,
  resolveStorePaths,
  ensureStoreDirs,
  createStateWriter,
} from '../../src/store/index.js';
import { BenchmarkRuntime } from '../bench/session/mock-runtime.js';
import { MemoryConnector } from '../bench/session/connector.js';
import { BenchmarkClock } from '../bench/session/clock.js';
import { deferred } from '../bench/frontend-worker/harness.js';

class RuntimeFeed {
  private readonly waiting = new Map<string, ReturnType<typeof deferred<BenchmarkRuntime>>[]>();
  private readonly started = new Map<string, BenchmarkRuntime[]>();
  push(runtime: BenchmarkRuntime): void {
    const role = runtime.options.env?.QQBOT_ROLE ?? '';
    const waiter = this.waiting.get(role)?.shift();
    if (waiter) waiter.resolve(runtime);
    else this.started.set(role, [...(this.started.get(role) ?? []), runtime]);
  }
  take(role: TaskJobKindV3): Promise<BenchmarkRuntime> {
    const runtime = this.started.get(role)?.shift();
    if (runtime) return Promise.resolve(runtime);
    const waiting = deferred<BenchmarkRuntime>();
    this.waiting.set(role, [...(this.waiting.get(role) ?? []), waiting]);
    return waiting.promise;
  }
}

class ObservedRuntime extends BenchmarkRuntime {
  constructor(
    options: DshRuntimeOptions,
    private readonly feed: RuntimeFeed
  ) {
    super(options);
  }
  override async prompt(sessionId: string, blocks: PromptContentBlock[]) {
    const result = await super.prompt(sessionId, blocks);
    this.feed.push(this);
    return result;
  }
}

export async function createRuntimeHarness(
  configuration?: FileConfig,
  savedTasks?: readonly unknown[]
) {
  const root = await mkdtemp(join(tmpdir(), 'task-v3-runtime-'));
  const config = loadConfig(
    {
      BOT_CONNECTORS: 'onebot',
      ONEBOT_ACCESS_TOKEN: 'offline',
      DEEPSEEK_API_KEY: 'offline',
    },
    configuration
  );
  const paths = resolveStorePaths({
    stateDir: join(root, 'state'),
    workspacesRoot: join(root, 'workspaces'),
  });
  ensureStoreDirs(paths);
  if (savedTasks)
    createStateWriter<unknown, 'tasks'>('tasks', join(paths.stateDir, 'tasks.json')).save(
      savedTasks
    );
  config.paths.dshHome = join(root, 'dsh');
  const logger = createLogger({ autoTick: false, sink: () => {} });
  const connector = new MemoryConnector();
  const clock = new BenchmarkClock();
  const feed = new RuntimeFeed();
  const runtimes: BenchmarkRuntime[] = [];
  const system = createTaskSystemV3({
    config,
    paths,
    logger,
    clock,
    connectors: new Map([['onebot', connector]]),
    conversations: createConversationStore(paths, logger),
    windows: createObservationWindowStore({ allowlist: [], maxMessages: 100, maxAgeMs: 86400000 }),
    stats: createPipelineStats(),
    runtimeFactory: (options) => {
      const runtime = new ObservedRuntime(options, feed);
      runtimes.push(runtime);
      return runtime.asRuntime();
    },
  });
  let sequence = 0;
  return {
    root,
    config,
    paths,
    connector,
    clock,
    system,
    runtimes,
    started: (role: TaskJobKindV3) => feed.take(role),
    submit(content = '完成当前请求') {
      const id = `message-${++sequence}`;
      return system.actor.submit(
        system.context({
          kind: 'group-message',
          target: { platform: 'onebot', kind: 'group', id: 'group', key: 'onebot:group:group' },
          senderId: 'member',
          content,
          msgId: id,
          eventId: id,
          ts: clock.now(),
          raw: {},
        })
      );
    },
    observe(predicate: (task: DeepReadonly<TaskSnapshotV3>) => boolean) {
      const found = system.manager.list().find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise<DeepReadonly<TaskSnapshotV3>>((resolve) => {
        const off = system.manager.onChange((task) => {
          if (predicate(task)) {
            off();
            resolve(task);
          }
        });
      });
    },
    sent(taskId: string): Promise<void> {
      const delivered = () => {
        const delivery = system.queue.taskDelivery(taskId);
        return delivery.success && !delivery.pending;
      };
      if (delivered()) return Promise.resolve();
      return new Promise((resolve) => {
        const off = system.queue.onDelivery(() => {
          if (!delivered()) return;
          off();
          resolve();
        });
      });
    },
    async close() {
      await system.close();
      await connector.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function startWorker(runtime: BenchmarkRuntime) {
  const env = runtime.options.env!;
  return runtime.options.taskControl!({
    action: 'start-worker',
    sessionId: runtime.prompts[0]!.sessionId,
    executionId: env.QQBOT_EXECUTION_ID,
    runtimeGeneration: env.QQBOT_RUNTIME_GENERATION,
    assignment: { instruction: '制作完整报告', deliverables: ['报告和CSV文件'] },
  });
}

export function workerText() {
  return '完整业务结果：20\n依据：12+8=20。';
}
