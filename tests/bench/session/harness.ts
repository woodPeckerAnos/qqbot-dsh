import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  Config,
  Lane,
  TaskSnapshotV2 as TaskSnapshot,
  DeepReadonly,
  StateWriter,
  TopicJudge,
  TaskHandleV2 as TaskHandle,
  QueuedMessage,
  BudgetRecord,
  SessionContextState,
  DshRuntime,
  DshRuntimeOptions,
  TaskSystemV2 as TaskSystem,
  NormalizedMessage,
  LaneRunnerV2 as LaneRunner,
  SessionActorV2 as SessionActor,
} from '@qqbot/contracts';
import { loadConfig, loadConfigFile, writeModelApiPatch } from '../../../src/config/index.js';
import { createRuntimePool, createDshRuntime } from '../../../src/runtime/index.js';
import {
  createTaskLifeCycleManagerV2,
  createTaskBudget,
  createPromptPreparerV2,
  createTaskControlBridgeV2,
  createDshLaneRunnerV2,
  createSessionActorV2,
  createLaneSchedulerV2,
  createTaskSystemV2,
  createTaskCooperation,
  isTaskTerminal,
} from '../../../src/task/index.js';
import {
  createMessageQueue,
  createSessionOutputCoordinatorV2,
  createResponder,
} from '../../../src/delivery/index.js';
import {
  createConversationStore,
  createObservationWindowStore,
  createSeenStore,
  createStateWriter,
  resolveStorePaths,
  ensureStoreDirs,
} from '../../../src/store/index.js';
import {
  createOrchestrator,
  createDedupeStage,
  createRecordStage,
  createSessionCommandRouter,
  createTopicJudgeResult,
} from '../../../src/ingress/index.js';
import { createLogger, createPipelineStats } from '../../../src/observability/index.js';
import { createDocumentExtractor } from '../../../src/media/index.js';
import { BenchmarkClock, RealtimeClock } from './clock.js';
import { RuntimeEvidence } from './runtime-evidence.js';
import { sanitize } from './report.js';
import { BenchmarkRuntime } from './mock-runtime.js';
import { MemoryConnector } from './connector.js';
import type { AssertionResult, InputStep } from './types.js';

export async function until(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('benchmark-observation-timeout');
    await delay(2);
  }
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export class FaultWriter<T> implements StateWriter<T> {
  fail: (records: readonly T[]) => boolean = () => false;
  saves = 0;
  constructor(private readonly inner: StateWriter<T>) {}
  load() {
    return this.inner.load();
  }
  save(records: readonly T[]) {
    this.saves++;
    if (this.fail(records)) throw new Error('benchmark-injected-persistence-failure');
    this.inner.save(records);
  }
}
export interface HarnessSettings {
  mode?: 'offline' | 'live';
  config?: Config;
  seed?: number;
}

export class Harness {
  readonly connector = new MemoryConnector();
  readonly clock = new BenchmarkClock();
  readonly realtimeClock = new RealtimeClock();
  readonly evidence = new RuntimeEvidence();
  readonly runtimes: BenchmarkRuntime[] = [];
  get reasoning() {
    return this.evidence.reasoning;
  }
  get timers() {
    return this.mode === 'offline' ? this.clock.pending : this.realtimeClock.pending;
  }
  readonly assertions: AssertionResult[] = [];
  readonly terminalCounts = new Map<string, number>();
  readonly inputs: InputStep[] = [];
  readonly handles: TaskHandle[] = [];
  readonly archived: DeepReadonly<TaskSnapshot>[] = [];
  readonly metadata: Record<string, unknown> = {};
  runtimeSetup: (r: BenchmarkRuntime) => void = () => {};
  topicJudge: TopicJudge = async () => ({ related: true, mentionsChatRecord: false });
  system!: Pick<
    TaskSystem,
    'manager' | 'budget' | 'queue' | 'output' | 'actor' | 'pools' | 'close' | 'context'
  >;
  preparer!: ReturnType<typeof createPromptPreparerV2>;
  control!: ReturnType<typeof createTaskControlBridgeV2>;
  stores!: {
    tasks: FaultWriter<TaskSnapshot>;
    messages: FaultWriter<QueuedMessage>;
    budgets: FaultWriter<BudgetRecord>;
    sessions: FaultWriter<SessionContextState>;
  };
  private actor: SessionActor | undefined;
  private dependencies!: Parameters<typeof createTaskSystemV2>[0];
  private serial = 0;
  private inputWork = Promise.resolve();
  private cleanupGates: (() => void)[] = [];
  private constructor(
    readonly root: string,
    readonly config: Config,
    readonly mode: 'offline' | 'live',
    readonly seed: number
  ) {}
  static async create(settings: HarnessSettings = {}) {
    const mode = settings.mode ?? 'offline';
    const root = await mkdtemp(join(tmpdir(), 'session-benchmark-'));
    try {
      const config = settings.config ? structuredClone(settings.config) : offlineConfig();
      const h = new Harness(root, config, mode, settings.seed ?? 42);
      config.paths.dshHome = join(root, 'dsh');
      h.connector.now = mode === 'offline' ? h.clock.now : () => Date.now();
      await h.initialize();
      return h;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
  private async initialize() {
    const paths = resolveStorePaths({
      stateDir: join(this.root, 'state'),
      workspacesRoot: join(this.root, 'workspaces'),
    });
    ensureStoreDirs(paths);
    const logger = createLogger({ autoTick: false, sink: () => {} });
    const stats = createPipelineStats();
    const windows = createObservationWindowStore({
      allowlist: [],
      maxMessages: 100,
      maxAgeMs: 86400000,
    });
    const conversations = createConversationStore(paths, logger);
    const connectors = new Map([['onebot', this.connector]]);
    const common = {
      config: this.config,
      paths,
      logger,
      stats,
      windows,
      conversations,
      connectors,
      extractDocument: createDocumentExtractor({ logger }),
    };
    this.dependencies = common;
    this.metadata.configurationHash = hash(
      JSON.stringify(sanitize(this.config)).split(this.root).join('<isolated>')
    );
    const modelPatch =
      this.mode === 'live' ? writeModelApiPatch(this.config.modelApi, paths.stateDir) : undefined;
    if (this.mode === 'live') {
      this.system = createTaskSystemV2({
        ...common,
        clock: this.realtimeClock,
        modelPatches: modelPatch ? [modelPatch] : [],
        runtimeFactory: (o) => this.liveRuntime(o),
        topicJudgeResult: this.config.topic.enabled
          ? createTopicJudgeResult({ ...this.config.topic, perTurnMaxChars: 500, logger })
          : undefined,
      });
    } else {
      this.preparer = createPromptPreparerV2({
        ...common,
        clock: this.clock,
        topicJudge: (i) => this.topicJudge(i),
      });
      const store = <T>(domain: 'tasks' | 'messages' | 'task-budgets' | 'task-sessions') =>
        new FaultWriter(
          createStateWriter<T, typeof domain>(domain, join(paths.stateDir, `${domain}.json`))
        );
      this.stores = {
        tasks: store<TaskSnapshot>('tasks'),
        messages: store<QueuedMessage>('messages'),
        budgets: store<BudgetRecord>('task-budgets'),
        sessions: store<SessionContextState>('task-sessions'),
      };
      this.assembleOffline(common);
    }
    const orchestrator = createOrchestrator({
      logger,
      stats,
      connectors,
      admins: ['onebot:admin'],
      stages: [
        createDedupeStage({ seen: createSeenStore({ paths, logger }), stats }),
        createSessionCommandRouter({ actor: this.system.actor, stats }).stage(),
        createRecordStage({ conversations }),
      ],
      terminal: async (ctx) => {
        this.handles.push(await this.system.actor.submit(ctx));
      },
      createResponder: (m, _c, _p, _l, trace) => this.system.context(m, false, trace).responder,
      status: () => ({
        inFlight: this.system.actor.snapshot().unfinished,
        queued: this.system.actor.snapshot().slow.queued,
        offpeak: {} as never,
      }),
    });
    this.ingress = (m) => orchestrator.handleEvent(m);
    this.connector.on((event) => {
      if ('content' in event) this.inputWork = this.ingress(event);
    });
    this.system.manager.onChange((t) => {
      if (isTaskTerminal(t))
        this.terminalCounts.set(t.taskId, (this.terminalCounts.get(t.taskId) ?? 0) + 1);
    });
    this.connector.identify = (ctx, out) => {
      const row = this.system.queue
        .messages()
        .find(
          (m) =>
            m.status === 'sending' &&
            m.candidate.message.target.key === ctx.target.key &&
            m.candidate.text === out.text &&
            m.candidate.attachment?.fileName === out.attachments?.[0]?.fileName
        );
      return { taskId: row?.candidate.taskId, lane: row?.candidate.lane, messageId: row?.id };
    };
    await this.connector.start();
  }
  private assembleOffline(common: Parameters<typeof createTaskSystemV2>[0]) {
    const { config, logger, paths, conversations, windows, stats, connectors } = common;
    const manager = createTaskLifeCycleManagerV2({
      store: this.stores.tasks,
      now: this.clock.now,
      maxPerSession: config.tasks.maxPerSession,
      maxGlobal: config.tasks.maxGlobal,
      retentionMs: config.tasks.retentionMs,
      logger,
    });
    const budget = createTaskBudget(this.stores.budgets);
    const queue = createMessageQueue({
      connectors,
      store: this.stores.messages,
      logger,
      clock: this.clock,
    });
    const pools = Object.fromEntries(
      (['fast', 'slow'] as const).map((lane) => [
        lane,
        createRuntimePool({
          maxRuntimes: config.tasks[lane === 'fast' ? 'fastRuntimes' : 'slowRuntimes'],
          runtimeIdleMs: 0,
          now: this.clock.now,
          logger,
          base: {
            bin: 'mock',
            profilePatch: config.dsh.profilePatch,
            dshHome: config.paths.dshHome,
            provider: config.tasks[lane === 'fast' ? 'fastProvider' : 'slowProvider'],
            model: config.tasks[lane === 'fast' ? 'fastModel' : 'slowModel'],
            startTimeoutMs: 10000,
            shutdownTimeoutMs: 1000,
            ...(lane === 'fast' ? { reasoningEffort: 'off' } : {}),
          },
          runtimeFactory: (options) => {
            const r = new BenchmarkRuntime(options);
            this.runtimeSetup(r);
            this.runtimes.push(r);
            return this.evidence.attach(r.asRuntime(), options, this.clock.now);
          },
        }),
      ])
    ) as TaskSystem['pools'];
    this.control = createTaskControlBridgeV2(manager, (id) => {
      this.actor?.cancelExecution(id);
    });
    const output = createSessionOutputCoordinatorV2({
      manager,
      budget,
      queue,
      clock: this.clock,
      reminderMs: config.tasks.reminderMs,
      filesDir: join(paths.stateDir, 'message-files'),
      maxChars: () => this.connector.maxChars,
      onDelivered: (c, ts) => {
        conversations.appendResult(c.message.target.key, {
          role: 'assistant',
          speaker: 'bot',
          text: c.text,
          ts,
          taskId: c.taskId,
          lane: c.lane,
          reference: c.reference,
        });
        windows.recordBotReply(c.message.target.key, {
          text: c.text,
          ts,
          taskId: c.taskId,
          lane: c.lane,
        });
        stats.record('repliesSent');
      },
    });
    const cooperation = createTaskCooperation(manager, queue);
    const runner: LaneRunner = createDshLaneRunnerV2({
      pools,
      manager,
      preparer: this.preparer,
      control: this.control,
      config,
      logger,
      clock: this.clock,
      cooperation,
    });
    const actor = createSessionActorV2({
      manager,
      budget,
      output,
      preparer: this.preparer,
      runner,
      clock: this.clock,
      sessions: this.stores.sessions,
      taskIdFactory: () => `b${this.seed}_${++this.serial}`,
      schedulers: {
        fast: createLaneSchedulerV2(config.tasks.fastRuntimes),
        slow: createLaneSchedulerV2(config.tasks.slowRuntimes),
      },
    });
    this.actor = actor;
    this.system = {
      manager,
      budget,
      queue,
      output,
      actor,
      pools,
      context: (message, isAdmin = false) => ({
        message,
        isAdmin,
        logger,
        connector: this.connector,
        policy: this.connector.policy(message.target.kind),
        responder: createResponder({ message, queue }),
      }),
      close: async () => {
        actor.close();
        await Promise.all(Object.values(pools).map((p) => p.disposeAll()));
        await Promise.all(manager.list().map((t) => manager.handle(t.taskId).done));
        output.close();
        cooperation.close();
        queue.close();
      },
    };
    for (const t of manager.list().filter((t) => !isTaskTerminal(t)))
      queue.enqueue(
        {
          taskId: t.taskId,
          lane: 'slow',
          message: t.input.message,
          reference: t.input.reference,
          text: '任务因服务重启而中断，请重新提交。',
          kind: 'error',
        },
        `${t.taskId}:restart-interrupted`
      );
    manager.recover();
  }
  private liveRuntime(options: DshRuntimeOptions): DshRuntime {
    return this.evidence.attach(createDshRuntime(options), options, this.realtimeClock.now);
  }
  /** Recreate the actual production TaskSystem from a crash-time disk snapshot. */
  async restart(crashSnapshot?: TaskSnapshot[]) {
    await this.system.close();
    if (crashSnapshot) this.stores.tasks.save(crashSnapshot);
    this.system = createTaskSystemV2({
      ...this.dependencies,
      clock: this.clock,
      runtimeFactory: (options) => {
        const r = new BenchmarkRuntime(options);
        this.runtimes.push(r);
        return this.evidence.attach(r.asRuntime(), options, this.clock.now);
      },
    });
  }
  ingress: (m: NormalizedMessage) => Promise<void> = async () => {};
  message(step: InputStep, id = `input-${++this.serial}`): NormalizedMessage {
    return {
      kind: step.session?.startsWith('private') ? 'c2c-message' : 'group-at-message',
      target: {
        platform: 'onebot',
        key: step.session ?? 'group-A',
        id: step.session ?? 'group-A',
        kind: step.session?.startsWith('private') ? 'c2c' : 'group',
      },
      senderId: step.sender ?? 'alice',
      username: step.sender ?? 'alice',
      msgId: id,
      eventId: id,
      content: step.text,
      ts: this.connector.now(),
      raw: {},
    };
  }
  async input(step: InputStep, id?: string) {
    const m = this.message(step, id);
    this.inputs.push({ ...step, messageId: m.msgId, at: m.ts });
    if (step.media) m.parts = mediaParts(step.media, step.mediaUrl);
    this.system.queue.observe(m);
    const before = this.handles.length;
    this.connector.receive(m);
    await this.inputWork;
    return this.handles[before];
  }
  async submit(step: InputStep, proactive = false): Promise<TaskHandle> {
    const m = this.message(step);
    this.inputs.push({ ...step, messageId: m.msgId, at: m.ts });
    this.system.queue.observe(m);
    const handle = await this.system.actor.submit(
      this.system.context(m, step.sender === 'admin'),
      proactive
        ? { scene: 'benchmark', directive: step.text, budgetScope: 'mixed-load' }
        : undefined,
      128
    );
    this.handles.push(handle);
    return handle;
  }
  async runtime(taskId: string, lane: Lane) {
    await until(() =>
      this.runtimes.some(
        (r) => r.options.cwd.includes(`/${taskId}/${lane}`) && r.prompts.length > 0
      )
    );
    return this.runtimes.find(
      (r) => r.options.cwd.includes(`/${taskId}/${lane}`) && r.prompts.length > 0
    )!;
  }
  async finish(handle: TaskHandle, fast = '直接答案', slow = 'NO_REPLY', reverse = false) {
    const a = await this.runtime(handle.taskId, 'fast');
    const b = await this.runtime(handle.taskId, 'slow');
    if (reverse) {
      b.finish(slow);
      a.finish(fast);
    } else {
      a.finish(fast);
      b.finish(slow);
    }
    await handle.done;
    await this.idle();
  }
  async idle() {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await until(
      () =>
        this.system.queue.snapshot().sending === 0 &&
        this.system.queue
          .messages()
          .every((m) => m.status !== 'pending' || !this.system.queue.canSend(m.candidate))
    );
  }
  check(
    name: string,
    pass: boolean,
    evidence: unknown = null,
    category: AssertionResult['category'] = 'runtime'
  ) {
    this.assertions.push({ name, status: pass ? 'pass' : 'fail', evidence, category });
  }
  task(id: string) {
    return this.system.manager.get(id)!;
  }
  received(id?: string) {
    return this.connector.actions
      .filter((a) => a.status === 'received' && (!id || a.taskId === id))
      .sort((a, b) => a.receivedOrder! - b.receivedOrder!);
  }
  async artifact(handle: TaskHandle, text = 'verified artifact', name = 'answer.txt') {
    const r = await this.runtime(handle.taskId, 'slow');
    const path = join(r.options.cwd, this.config.media.outboxDir);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, name), text);
  }
  async close() {
    this.cleanupGates.forEach((resolve) => {
      resolve();
    });
    this.cleanupGates = [];
    if (this.stores)
      Object.values(this.stores).forEach((s) => {
        s.fail = () => false;
      });
    this.system.actor.flushSettlements();
    await this.system.close();
    await this.connector.stop();
  }
  async remove() {
    await rm(this.root, { recursive: true, force: true });
  }
  defer() {
    const gate = deferred();
    this.cleanupGates.push(gate.resolve);
    return gate;
  }
}
function offlineConfig() {
  const config = loadConfig({
    BOT_CONNECTORS: 'onebot',
    ONEBOT_ACCESS_TOKEN: 'offline',
    DEEPSEEK_API_KEY: 'offline',
  });
  config.tasks.fastRuntimes = 2;
  config.tasks.slowRuntimes = 2;
  return config;
}
export function liveConfig() {
  const loaded = loadConfigFile(process.env);
  const config = loadConfig(
    { ...process.env, BOT_CONNECTORS: 'onebot', ONEBOT_ACCESS_TOKEN: 'benchmark-memory' },
    loaded.config
  );
  for (const provider of [config.tasks.fastProvider, config.tasks.slowProvider]) {
    const key =
      provider === 'deepseek-official'
        ? (config.modelApi.deepseek?.apiKeyEnv ?? 'DEEPSEEK_API_KEY')
        : config.modelApi.providers[provider]?.apiKeyEnv;
    if (!key || !process.env[key]?.trim()) throw new Error(`missing-model-credential:${provider}`);
  }
  return config;
}
export function hash(text: string) {
  return createHash('sha256').update(text).digest('hex');
}
function mediaParts(
  kind: NonNullable<InputStep['media']>,
  url = 'memory://input'
): NonNullable<NormalizedMessage['parts']> {
  if (kind === 'image')
    return [{ type: 'image', url: 'memory://unreadable.png', filename: 'unreadable.png' }];
  if (kind === 'quote')
    return [
      {
        type: 'quote',
        author: '资料员',
        parts: [{ type: 'text', text: '订单甲12元，订单乙8元。' }],
      },
    ];
  if (kind === 'forward')
    return [
      {
        type: 'forward',
        parts: [
          {
            type: 'quote',
            author: '资料员',
            parts: [{ type: 'text', text: '订单甲12元，订单乙8元。' }],
          },
        ],
      },
    ];
  return [
    {
      type: 'media',
      mediaKind: 'file',
      filename: kind === 'csv' ? 'input.csv' : 'input.txt',
      url,
    },
  ];
}
export async function fileHash(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
