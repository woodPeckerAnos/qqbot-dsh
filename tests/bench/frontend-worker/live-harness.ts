import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  DshRuntime,
  DshRuntimeOptions,
  PromptContentBlock,
  WorkerBudgetUpdate,
  TaskCooperationUpdate,
  DeepReadonly,
  TaskSnapshotV3,
} from '@qqbot/contracts';
import { loadConfigFile, loadConfigV3, writeModelApiPatch } from '../../../src/config/index.js';
import { createTaskSystemV3, createSearchService } from '../../../src/task/index.js';
import { createDshRuntime, createSearchProvider } from '../../../src/runtime/index.js';
import { createLogger, createPipelineStats } from '../../../src/observability/index.js';
import {
  createConversationStore,
  createObservationWindowStore,
  ensureStoreDirs,
  resolveStorePaths,
} from '../../../src/store/index.js';
import { MemoryConnector } from '../session/connector.js';
import { OnebotProbe } from '../session/onebot-probe.js';

export interface LiveRuntimeEvidence {
  role: string;
  prompts: { sessionId: string; blocks: PromptContentBlock[] }[];
  toolNames: string[];
  modelStepStarts: number;
  requestHeaderEvents: number;
  control: { action: string; response: unknown }[];
  services: { action: string; response: unknown }[];
}
/** Observes public calls and events while preserving the production runtime and its capabilities. */
class ObservedLiveRuntime extends EventEmitter implements DshRuntime {
  constructor(
    private readonly runtime: DshRuntime,
    readonly evidence: LiveRuntimeEvidence
  ) {
    super();
    for (const event of [
      'session.event',
      'session.status',
      'subagent.started',
      'subagent.finished',
      'violation',
      'invalid',
      'unknown',
      'exit',
    ])
      runtime.on(event, (...args: unknown[]) => this.emit(event, ...args));
    runtime.on('session.event', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const event = (raw as Record<string, unknown>).event;
      if (!event || typeof event !== 'object') return;
      if ((event as Record<string, unknown>).type === 'step/start') evidence.modelStepStarts++;
      if ((event as Record<string, unknown>).type === 'request/header')
        evidence.requestHeaderEvents++;
      const data = (event as Record<string, unknown>).data;
      if (!data || typeof data !== 'object') return;
      const fields = data as Record<string, unknown>;
      const name = fields.name ?? fields.toolName;
      if ((event as Record<string, unknown>).type === 'tool/call' && typeof name === 'string')
        evidence.toolNames.push(name);
    });
  }
  get lastErrorId() {
    return this.runtime.lastErrorId;
  }
  get state() {
    return this.runtime.state;
  }
  get serverInfo() {
    return this.runtime.serverInfo;
  }
  get pid() {
    return this.runtime.pid;
  }
  get recentStderr() {
    return this.runtime.recentStderr;
  }
  get isReady() {
    return this.runtime.isReady;
  }
  start(signal?: AbortSignal) {
    return this.runtime.start(signal);
  }
  prompt(sessionId: string, blocks: PromptContentBlock[]) {
    this.evidence.prompts.push({ sessionId, blocks: structuredClone(blocks) });
    return this.runtime.prompt(sessionId, blocks);
  }
  notifyTaskCooperation(update: TaskCooperationUpdate) {
    this.runtime.notifyTaskCooperation?.(update);
  }
  notifyWorkerBudget(update: WorkerBudgetUpdate) {
    this.runtime.notifyWorkerBudget?.(update);
  }
  onTaskChannelClose(listener: () => void) {
    return this.runtime.onTaskChannelClose?.(listener) ?? (() => {});
  }
  async dispose() {
    await this.runtime.dispose();
    this.removeAllListeners();
  }
}

export async function createLiveHarness() {
  const root = await mkdtemp(join(tmpdir(), 'tasks-v3-live-'));
  const loaded = loadConfigFile(process.env);
  const config = loadConfigV3(
    { ...process.env, BOT_CONNECTORS: 'onebot', ONEBOT_ACCESS_TOKEN: 'benchmark-injected' },
    loaded.config
  );
  const paths = resolveStorePaths({
    stateDir: join(root, 'state'),
    workspacesRoot: join(root, 'workspaces'),
  });
  ensureStoreDirs(paths);
  config.paths.dshHome = join(root, 'dsh');
  const logger = createLogger({ autoTick: false, sink: () => {} });
  const connector = new MemoryConnector();
  connector.recordCapable = true;
  const probe = new OnebotProbe(connector);
  await probe.start();
  const runtimeEvidence: LiveRuntimeEvidence[] = [];
  const runtimes: DshRuntime[] = [];
  const requests: { bodySha256: string; bytes: number }[] = [];
  const provider = createSearchProvider({
    config: config.search,
    apiKey: 'injected-search-key',
    logger,
    fetchImpl: async (_url, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      requests.push({
        bodySha256: createHash('sha256').update(body).digest('hex'),
        bytes: Buffer.byteLength(body),
      });
      return new Response(
        JSON.stringify({
          error: { code: 'monthly_quota_exhausted', message: 'Monthly search quota exhausted' },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    },
  });
  const search = createSearchService(provider);
  const patch = writeModelApiPatch(config.modelApi, paths.stateDir);
  const modelPatches = patch ? [patch] : [];
  const system = createTaskSystemV3({
    config,
    paths,
    logger,
    connectors: new Map([['onebot', connector]]),
    conversations: createConversationStore(paths, logger),
    windows: createObservationWindowStore({ allowlist: [], maxMessages: 100, maxAgeMs: 86400000 }),
    stats: createPipelineStats(),
    search,
    modelPatches,
    runtimeFactory: (options: DshRuntimeOptions) => {
      const evidence: LiveRuntimeEvidence = {
        role: options.env?.QQBOT_ROLE ?? 'unknown',
        prompts: [],
        toolNames: [],
        modelStepStarts: 0,
        requestHeaderEvents: 0,
        control: [],
        services: [],
      };
      runtimeEvidence.push(evidence);
      const runtime = new ObservedLiveRuntime(
        createDshRuntime({
          ...options,
          taskControl: options.taskControl
            ? (request) => {
                const response = options.taskControl!(request);
                evidence.control.push({
                  action: request.action,
                  response: structuredClone(response),
                });
                return response;
              }
            : undefined,
          workerServices: options.workerServices
            ? async (request, signal) => {
                const response = await options.workerServices!(request, signal);
                evidence.services.push({
                  action: request.action,
                  response: structuredClone(response),
                });
                return response;
              }
            : undefined,
        }),
        evidence
      );
      runtimes.push(runtime);
      return runtime;
    },
  });
  connector.identify = (ctx, out) => {
    const attachments = (out.attachments ?? []).map((file) => [file.absPath, file.fileName]);
    const row = system.queue
      .messages()
      .find(
        (row) =>
          row.status === 'sending' &&
          row.candidate.message.target.key === ctx.target.key &&
          row.candidate.text === out.text &&
          JSON.stringify(
            (row.candidate.attachment
              ? [row.candidate.attachment]
              : (row.candidate.inlineAttachments ?? [])
            ).map((file) => [file.absPath, file.fileName])
          ) === JSON.stringify(attachments)
      );
    return { taskId: row?.candidate.taskId, messageId: row?.id, lane: row?.candidate.lane };
  };
  let sequence = 0;
  return {
    root,
    config,
    system,
    connector,
    probe,
    runtimeEvidence,
    runtimes,
    requests,
    submit(content: string) {
      const id = `live-${++sequence}`;
      return system.actor.submit(
        system.context({
          kind: 'group-message',
          target: { platform: 'onebot', kind: 'group', id: 'group', key: 'onebot:group:group' },
          senderId: 'member',
          content,
          msgId: id,
          eventId: id,
          ts: Date.now(),
          raw: {},
        })
      );
    },
    sent(taskId: string): Promise<void> {
      const delivered = () => {
        const delivery = system.queue.taskDelivery(taskId);
        return !delivery.pending;
      };
      if (delivered()) return Promise.resolve();
      return new Promise((resolve) => {
        const off = system.queue.onDelivery(() => {
          if (delivered()) {
            off();
            resolve();
          }
        });
      });
    },
    observe(predicate: (task: DeepReadonly<TaskSnapshotV3>) => boolean) {
      const task = system.manager.list().find(predicate);
      if (task) return Promise.resolve(task);
      return new Promise<DeepReadonly<TaskSnapshotV3>>((resolve) => {
        const off = system.manager.onChange((task) => {
          if (predicate(task)) {
            off();
            resolve(task);
          }
        });
      });
    },
    async close() {
      await system.close();
      await probe.stop();
      await connector.stop();
      search.close();
    },
    async remove() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
