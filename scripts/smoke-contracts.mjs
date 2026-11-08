import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { contractExamples } from '../packages/contracts/dist/examples.js';
import * as config from '../dist/config/index.js';
import * as content from '../dist/content/index.js';
import * as connectors from '../dist/connectors/index.js';
import * as store from '../dist/store/index.js';
import * as media from '../dist/media/index.js';
import * as runtime from '../dist/runtime/index.js';
import * as task from '../dist/task/index.js';
import * as session from '../dist/session/index.js';
import * as delivery from '../dist/delivery/index.js';
import * as ingress from '../dist/ingress/index.js';
import * as proactive from '../dist/proactive/index.js';
import * as offpeak from '../dist/offpeak/index.js';
import * as observability from '../dist/observability/index.js';

/** Contract doubles keep independent smoke loops offline. */
function loggerDouble() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    event() {},
    finishExecution() {},
    child() {
      return this;
    },
    withTrace() {
      return this;
    },
    cause() {
      return 'fixture-error';
    },
  };
}
function messageDouble(id = 'fixture-message', text = '输入', ts = 100) {
  return {
    kind: 'group-at-message',
    target: { platform: 'onebot', kind: 'group', id: '1', key: 'ob11:g1' },
    eventId: `fixture:${id}`,
    msgId: id,
    senderId: 'fixture-user',
    content: text,
    ts,
    raw: {},
  };
}
function connectorDouble() {
  return {
    platform: 'onebot',
    acceptsC2C: true,
    async start() {},
    async stop() {},
    on() {
      return () => {};
    },
    health() {
      return { connected: true, state: 'mock' };
    },
    policy() {
      return {
        maxChars: 1500,
        maxRepliesPerMsg: 5,
        progressMax: 0,
        progressAfterMs: 0,
        progressIntervalMs: 0,
        turnTimeoutMs: 1000,
        passiveWindowMs: Infinity,
      };
    },
    async reply() {
      throw new Error('Unexpected connector action: transport must be injected');
    },
  };
}
function clockDouble(now) {
  return { now: () => now, setTimeout: () => ({ unref() {} }), clearTimeout() {} };
}
function taskInputDouble() {
  return {
    message: messageDouble(),
    isAdmin: false,
    source: 'user',
    generation: 0,
    reference: {
      messageId: 'original-message',
      senderId: 'fixture-user',
      excerpt: '输入',
      ts: 100,
    },
    context: { window: [], replay: '' },
  };
}
function rejectedWrite(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
async function flushMicrotasks() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

const runners = {
  session(example) {
    const manager = task.createTaskLifeCycleManagerV2({ now: () => 100 });
    manager.create(taskInputDouble(), 'original');
    const followUp = session.classifyTaskFollowUp({
      message: messageDouble('follow-up', example.input.text),
      generation: 0,
      now: 100,
      tasks: example.input.target ? manager.list() : [],
    });
    if (example.kind === 'failure') return followUp;
    manager.create({ ...taskInputDouble(), ...followUp }, 'current');
    const view = session
      .createSessionContextView({
        tasks: () => (example.input.target ? manager.list() : []),
        messages: () => [],
        generation: () => 0,
        now: () => 100,
      })
      .read(manager.get('current'));
    return {
      ...followUp,
      contextTasks: view.tasks.length,
      rendered: !!session.renderSessionContextView(view),
      immutable: rejectedWrite(() => {
        view.tasks.push({});
      }),
    };
  },

  config(example) {
    try {
      return { value: config.parseConfigFileText(example.input.text) };
    } catch (error) {
      return { rejected: true, error: error.name };
    }
  },
  content(example) {
    const { text, maxChars, maxSegments } = example.input;
    return content.segmentText(text, { maxChars, maxSegments });
  },
  async connectors(example) {
    let fetchCalls = 0;
    const { input } = example;
    const tokens = connectors.createTokenManager({
      appId: 'fixture-app',
      appSecret: 'fixture-secret',
      apiBase: 'https://example.invalid',
      logger: loggerDouble(),
      now: () => 100,
      refreshAheadMs: 0,
      fetchImpl: async () => {
        fetchCalls += 1;
        await Promise.resolve();
        return new Response(
          JSON.stringify(
            input.code === undefined
              ? { access_token: input.token, expires_in: input.expiresIn }
              : { code: input.code, message: input.message }
          ),
          { status: 200 }
        );
      },
    });
    try {
      const values = input.concurrent
        ? await Promise.all([tokens.get(), tokens.get()])
        : [await tokens.get(), await tokens.get()];
      return { tokens: values, fetchCalls, ...tokens.snapshot() };
    } catch (error) {
      return { rejected: true, code: error.code, fetchCalls, hasToken: tokens.snapshot().hasToken };
    }
  },
  store(example) {
    const { input } = example;
    if (input.failWrite) {
      const root = mkdtempSync(join(tmpdir(), 'qqbot-contract-store-'));
      try {
        const sessions = store.createSessionStore({
          paths: store.resolveStorePaths({ stateDir: root, workspacesRoot: root }),
          logger: loggerDouble(),
          now: () => 100,
          sessionIdFactory: () => 'fixture-session',
          persistSession() {
            throw new Error('Injected persistence failure');
          },
        });
        try {
          sessions.ensure(input.sessionKey);
        } catch (error) {
          return { rejected: true, error: error.code, sessions: sessions.all().length };
        }
        return { rejected: false, sessions: sessions.all().length };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const windows = store.createObservationWindowStore({
      allowlist: input.allowlist,
      maxAgeMs: input.maxAgeMs,
    });
    const accepted = input.messages.map((message) =>
      windows.observe(messageDouble(message.id, message.text, message.ts))
    );
    return {
      accepted,
      texts: windows.read('ob11:g1').map((entry) => entry.text),
      buffered: windows.buffered,
    };
  },
  async media(example) {
    let spawnCalls = 0;
    const extractor = media.createDocumentExtractor({
      logger: loggerDouble(),
      spawnImpl() {
        spawnCalls += 1;
        throw new Error('Unexpected child process');
      },
    });
    const extraction = await extractor({
      data: Uint8Array.from(example.input.bytes),
      fileName: example.input.fileName,
      maxChars: example.input.maxChars,
      maxPdfPages: 1,
      timeoutMs: 1000,
    });
    return { extraction, spawnCalls };
  },
  async runtime(example) {
    if (example.kind === 'failure') return protocolFailure(example.input.frame);
    const accumulator = runtime.createTurnAccumulator(example.input.sessionId);
    accumulator.observeStatus('running');
    accumulator.observe({
      type: 'assistant/message',
      seq: 1,
      data: {
        message: { content: [{ type: 'text', text: example.input.text }] },
      },
    });
    accumulator.observe({
      type: 'turn/end',
      seq: 2,
      data: { reason: { kind: example.input.reason } },
    });
    if (example.input.idle) accumulator.observeStatus('idle');
    if (example.kind === 'edge')
      return {
        settled: accumulator.isSettled,
        sawTurnEnd: accumulator.sawTurnEnd,
        text: accumulator.finalText,
      };
    const protocol = await protocolLoop(example.input.sessionId);
    return { ...protocol, settled: accumulator.isSettled, result: accumulator.result() };
  },
  async task(example) {
    let notifications = 0;
    const manager = task.createTaskLifeCycleManagerV2({
      now: () => example.input.now,
      logger: loggerDouble(),
      ...(example.input.failWrite
        ? {
            store: {
              domain: 'tasks',
              load: () => [],
              save() {
                throw new Error('Injected task persistence failure');
              },
            },
          }
        : {}),
    });
    const unsubscribe = manager.onChange(() => {
      notifications += 1;
    });
    let handle;
    try {
      handle = manager.create(taskInputDouble(), example.input.taskId);
    } catch {
      unsubscribe();
      return { rejected: true, tasks: manager.list().length, notifications };
    }
    let done = false;
    const completion = handle.done.then(() => {
      done = true;
    });
    manager.start(handle.taskId, 'fast');
    manager.finish(handle.taskId, 'fast', { kind: 'reply', text: '快回复' });
    if (example.input.finishBoth) {
      manager.start(handle.taskId, 'slow');
      manager.finish(handle.taskId, 'slow', { kind: 'silent', reason: 'no-long-skill' });
      await completion;
    } else await Promise.resolve();
    unsubscribe();
    const snapshot = manager.get(handle.taskId);
    return {
      status: snapshot.status,
      fast: snapshot.lanes.fast.status,
      slow: snapshot.lanes.slow.status,
      done,
    };
  },
  async delivery(example) {
    const attempts = [];
    const queue = delivery.createMessageQueue({
      connectors: new Map([['onebot', connectorDouble()]]),
      logger: loggerDouble(),
      clock: clockDouble(100),
      transport: async (_connector, _context, candidate) => {
        attempts.push(candidate);
        if (example.input.failSend) throw new Error('Injected send failure');
      },
    });
    const candidate = {
      taskId: 'fixture-task',
      lane: 'fast',
      message: messageDouble(),
      reference: taskInputDouble().reference,
      text: example.input.text,
      kind: 'final',
      ...(example.input.record
        ? { record: { nodes: [{ type: 'text', text: example.input.text }] } }
        : {}),
    };
    try {
      if (example.input.record) queue.enqueueGroup([{ candidate, id: 'fixture-delivery' }]);
      else queue.enqueue(candidate, 'fixture-delivery');
      if (example.input.duplicate) queue.enqueue(candidate, 'fixture-delivery');
      await flushMicrotasks();
      const snapshot = queue.snapshot();
      if (example.kind === 'failure')
        return {
          sent: snapshot.sent,
          failed: snapshot.failed,
          attempts: attempts.length,
          failureNotifications: queue.messages().filter((entry) => entry.candidate.notification)
            .length,
          sourceAttempts: attempts.filter((entry) => !entry.notification).length,
        };
      return {
        sent: snapshot.sent,
        failed: snapshot.failed,
        attempts: attempts.length,
        referenceMessageId: attempts[0]?.reference?.messageId,
        ...(example.input.record ? { recordNodes: attempts[0]?.record?.nodes.length } : {}),
      };
    } finally {
      queue.close();
    }
  },
  async ingress(example) {
    const visited = [];
    const stages = example.input.stages.map((name) => async (_context, next) => {
      visited.push(name);
      if (example.input.failAt === name) throw new Error('Injected ingress failure');
      if (example.input.shortcut !== name) await next();
    });
    const context = {
      message: messageDouble(),
      connector: connectorDouble(),
      policy: connectorDouble().policy(),
      isAdmin: false,
      logger: loggerDouble(),
      responder: { async reply() {}, async error() {} },
    };
    try {
      await ingress.runStages(stages, context, async () => {
        visited.push('actor');
      });
      return { visited, rejected: false };
    } catch {
      return { visited, rejected: true };
    }
  },
  proactive(example) {
    let nextId = 0;
    const entries = [];
    const window = {
      convKey: 'ob11:g1',
      get entries() {
        return entries;
      },
      observeEntry(entry) {
        entries.push(structuredClone(entry));
      },
      anySince: (ts) => entries.some((entry) => entry.ts > ts),
      read: () => entries,
      get size() {
        return entries.length;
      },
    };
    const state = proactive.createConversationState('ob11:g1', window, {
      idFactory: () => `topic-${++nextId}`,
    });
    state.openSession(example.input.now, example.input.budget);
    if (example.kind === 'failure') {
      const snapshotWriteRejected = rejectedWrite(() =>
        Object.assign(state.session, { budgetLeft: 99 })
      );
      let closed = 0;
      const unsubscribe = state.onSessionClosed(() => {
        closed += 1;
      });
      const firstClose = state.closeSession('idle');
      const secondClose = state.closeSession('idle');
      unsubscribe();
      state.openSession(101, 2);
      state.closeSession('idle');
      return { snapshotWriteRejected, closed, firstClose, secondClose, afterUnsubscribe: closed };
    }
    if (example.input.question)
      state.observe(messageDouble('question', example.input.question, example.input.now));
    const scope = state.taskBudgetScope(example.input.budget);
    if (example.kind === 'normal') {
      scope.reserve();
      scope.commit(110);
    }
    return {
      scopeId: scope.id,
      budgetLeft: state.session.budgetLeft,
      committed: state.committedTaskCount(state.session),
      pendingQuestions: state.pendingQuestions(110).length,
      windowWrites: entries.length,
    };
  },
  offpeak(example) {
    try {
      const windows = offpeak.parseWindowsSpec(example.input.windows);
      return offpeak.evaluateGate({
        config: {
          enabled: true,
          windows,
          timeZone: 'Asia/Shanghai',
          modelPattern: 'deepseek',
          weekendsAllDay: false,
          holidays: new Set(),
        },
        provider: 'deepseek',
        model: 'deepseek-chat',
        isAdmin: example.input.isAdmin,
        now: example.input.now,
      });
    } catch (error) {
      return { rejected: true, error: error.name };
    }
  },
  observability(example) {
    const stats = observability.createPipelineStats();
    try {
      stats.record('received', example.input.amount);
    } catch (error) {
      return { rejected: true, error: error.name, received: stats.snapshot().received };
    }
    stats.recordDistribution('proactiveSessionClosedBy', 'idle', example.input.distributionAmount);
    const snapshot = stats.snapshot();
    return {
      received: snapshot.received,
      closedByIdle: snapshot.proactiveSessionClosedBy.idle,
      snapshotWriteRejected: rejectedWrite(() =>
        Object.assign(snapshot.proactiveSessionClosedBy, { idle: 99 })
      ),
    };
  },
};

async function protocolLoop(sessionId) {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = runtime.createHarnessSdkClient({ input, output });
  output.on('data', (chunk) => {
    const request = JSON.parse(String(chunk));
    const result =
      request.method === 'initialize'
        ? { serverInfo: { name: runtime.SDK_SERVER_INFO_NAME, version: 'fixture-v1' } }
        : { messageId: 'fixture-message' };
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  });
  try {
    const initialized = await client.initialize({
      cwd: '/fixture',
      provider: 'fixture',
      model: 'fixture',
    });
    const receipt = await client.prompt({
      sessionId,
      contentBlocks: [{ type: 'text', text: 'fixture' }],
    });
    client.close();
    return {
      initialized: initialized.serverInfo.name === runtime.SDK_SERVER_INFO_NAME,
      promptReceipt: receipt.messageId,
      pendingAfterClose: client.pendingCount,
    };
  } finally {
    client.close();
    input.destroy();
    output.destroy();
  }
}
function protocolFailure(frame) {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = runtime.createHarnessSdkClient({ input, output, onViolation: 'collect' });
  const violations = [];
  client.on('violation', (error) => {
    violations.push(error.name);
  });
  input.write(frame);
  client.close();
  input.destroy();
  output.destroy();
  return {
    violations: violations.length,
    error: violations[0],
    pendingAfterClose: client.pendingCount,
  };
}

export const smokeModuleIds = Object.freeze(Object.keys(runners));
export async function executeExample(example) {
  const runner = runners[example.module];
  if (!runner) throw new Error(`Unknown contract module: ${example.module}`);
  const actual = await runner(example);
  assert.deepEqual(actual, example.expected, example.id);
  return actual;
}
export async function smokeContracts(moduleId) {
  if (moduleId && !smokeModuleIds.includes(moduleId))
    throw new Error(`Unknown module ${moduleId}; choose ${smokeModuleIds.join(', ')}`);
  const selected = contractExamples.filter((example) => !moduleId || example.module === moduleId);
  for (const example of selected) {
    await executeExample(example);
    console.log(`PASS ${example.id}`);
  }
  return selected.map((example) => example.id);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await smokeContracts(process.argv[2]);
}
