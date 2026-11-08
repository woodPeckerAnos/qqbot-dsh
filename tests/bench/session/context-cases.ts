import type { BenchmarkCase } from './types.js';
import type { Harness } from './harness.js';
import { until } from './harness.js';
import {
  FOLLOW_UP,
  ORIGINAL_QUESTION,
  ORIGINAL_RESULT,
  original,
  originalOutput,
  progress,
  progressOutput,
  promptText,
  readView,
  runtimes,
  inspectDelivery,
} from './context-helpers.js';

export const CONTEXT_GROUP = '任务衔接基线';
const COMMON = [
  'context-baseline-enabled',
  'all-inputs-create-task',
  'single-terminal-notification',
  'all-task-lanes-terminal',
  'no-duplicate-platform-attempts',
  'resources-released',
];
const PROGRESS = [
  'progress-real-query',
  'query-does-not-prove-delivery',
  'progress-independent-task',
  'progress-no-slow-resources',
  'progress-no-artifacts-or-reminders',
  'original-delivered-once-with-reference',
];
const VIEW = ['context-task-identity', 'context-delivery-constraint'];
const FRESH = [...VIEW, 'latest-result-visible', 'original-delivered-once-with-reference'];
const DELIVERY = [...VIEW, 'execution-and-delivery-separated'];

async function repeatedProgress(h: Harness) {
  const { a, slow } = await original(h);
  h.topicJudge = async () => ({ related: false, mentionsChatRecord: false });
  const b = await progress(h, a, '上个任务进度怎样？', 'running');
  const c = await progress(h, a, '还没有核实完成吗', 'running');
  h.check('two-progress-inputs', h.handles.length === 3 && b.taskId !== c.taskId, h.inputs);
  h.clock.advance(h.config.tasks.reminderMs + 1);
  slow.finish(ORIGINAL_RESULT);
  await a.done;
  await h.idle();
  progressOutput(h, [b, c]);
  // Ignore the original task's legitimate progress reminder when checking its final result.
  const final = h.received(a.taskId).filter((action) => action.kind === 'final');
  h.check(
    'original-delivered-once-with-reference',
    final.filter((action) => action.lane === 'slow').length === 1 &&
      final.some(
        (action) =>
          action.text === ORIGINAL_RESULT &&
          action.reference?.messageId === h.task(a.taskId).input.message.msgId
      ) &&
      runtimes(h, a.taskId, 'slow').length === 1,
    final
  );
}
async function completedProgress(h: Harness) {
  const { a, slow } = await original(h);
  h.connector.connected = false;
  slow.finish(ORIGINAL_RESULT);
  await a.done;
  const b = await progress(h, a, '核实完成了吗', 'completed');
  h.check(
    'completed-result-still-pending',
    h.task(a.taskId).status === 'completed' &&
      h.system.queue.messages(a.taskId).some((m) => m.candidate.body && m.status === 'pending') &&
      h.received(a.taskId).every((action) => action.lane !== 'slow'),
    h.system.queue.messages(a.taskId)
  );
  h.connector.connected = true;
  h.system.queue.wake();
  await h.idle();
  progressOutput(h, [b]);
  originalOutput(h, a);
}
async function mixedFollowUp(h: Harness) {
  const { a, slow } = await original(h);
  const b = (await h.input({ text: '刚才的任务完成了吗？请补充来源并整理成表格' }))!;
  (await h.runtime(b.taskId, 'fast')).finish('会补充来源并整理。');
  slow.finish(ORIGINAL_RESULT);
  await a.done;
  const current = await h.runtime(b.taskId, 'slow');
  h.check(
    'mixed-request-keeps-dual-lanes',
    !h.task(b.taskId).input.progressOnly &&
      h.task(b.taskId).input.followUpOf === a.taskId &&
      runtimes(h, b.taskId, 'fast').length === 1 &&
      runtimes(h, b.taskId, 'slow').length === 1,
    h.task(b.taskId).input
  );
  current.finish('表格：甲12元，乙8元，合计20元；来源为采购表。');
  await b.done;
  await h.idle();
  originalOutput(h, a);
}
async function queuedContext(h: Harness) {
  const { a, slow } = await original(h);
  h.clock.advance(10);
  const b = (await h.input({ text: FOLLOW_UP }))!;
  const fast = await h.runtime(b.taskId, 'fast');
  fast.finish('收到，会整理。');
  await h.idle();
  h.check(
    'new-fast-progresses-during-old-slow',
    h.received(b.taskId).length === 1 &&
      h.task(a.taskId).lanes.slow.status === 'running' &&
      h.task(b.taskId).lanes.slow.status === 'queued',
    { scheduler: h.system.actor.snapshot(), received: h.received(b.taskId) }
  );
  h.clock.advance(10);
  slow.finish(ORIGINAL_RESULT);
  await a.done;
  const current = await h.runtime(b.taskId, 'slow');
  const view = readView(h, b, current);
  const entry = view.tasks.find((task) => task.taskId === a.taskId);
  h.check(
    'latest-result-visible',
    entry?.lanes.slow.text === ORIGINAL_RESULT &&
      entry.status === 'completed' &&
      entry.lanes.slow.delivery === 'sent' &&
      entry.endedAt! > h.task(b.taskId).createdAt,
    view
  );
  h.check(
    'fast-context-remains-frozen',
    !promptText(fast).includes(ORIGINAL_RESULT) && h.connector.fetches === 0,
    { fastPrompt: promptText(fast), mediaFetches: h.connector.fetches }
  );
  current.finish('表格：采购合计20元。');
  await b.done;
  await h.idle();
  originalOutput(h, a);
}
async function initializingContext(h: Harness) {
  const { a, slow } = await original(h);
  const gate = h.defer();
  h.runtimeSetup = (r) => {
    if (r.options.env?.QQBOT_LANE === 'slow') r.startGate = gate.promise;
  };
  const b = (await h.input({ text: FOLLOW_UP }))!;
  (await h.runtime(b.taskId, 'fast')).finish('收到，会整理。');
  h.stores.tasks.fail = (records) =>
    records.some((task) => task.taskId === a.taskId && task.status === 'completed');
  slow.finish(ORIGINAL_RESULT);
  await until(() => runtimes(h, b.taskId, 'slow').length === 1);
  const initializing = runtimes(h, b.taskId, 'slow')[0]!;
  h.check(
    'result-not-settled-before-initialization',
    initializing.prompts.length === 0 &&
      h.task(a.taskId).status === 'running' &&
      h.task(a.taskId).lanes.slow.result === undefined,
    { old: h.task(a.taskId), prompts: initializing.prompts.length }
  );
  h.clock.advance(10);
  h.stores.tasks.fail = () => false;
  h.system.actor.flushSettlements();
  await a.done;
  gate.resolve();
  const current = await h.runtime(b.taskId, 'slow');
  const view = readView(h, b, current);
  const entry = view.tasks.find((task) => task.taskId === a.taskId);
  h.check(
    'latest-result-visible',
    entry?.status === 'completed' &&
      entry.lanes.slow.text === ORIGINAL_RESULT &&
      entry.endedAt! > h.task(b.taskId).createdAt &&
      view.scope.now >= entry.endedAt!,
    view
  );
  current.finish('表格：采购合计20元。');
  await b.done;
  await h.idle();
  originalOutput(h, a);
}
async function pendingDelivery(h: Harness) {
  const { a, slow } = await original(h);
  h.connector.connected = false;
  slow.finish(ORIGINAL_RESULT);
  await a.done;
  const next = await inspectDelivery(h, a, 'pending');
  h.connector.connected = true;
  h.system.queue.wake();
  await h.idle();
  next.slow.finish('NO_REPLY');
  await next.b.done;
  originalOutput(h, a);
}
async function sendingDelivery(h: Harness) {
  const { a, slow } = await original(h);
  const gate = h.defer();
  h.connector.send = async (_ctx, out) => {
    if (out.text === ORIGINAL_RESULT) await gate.promise;
  };
  slow.finish(ORIGINAL_RESULT);
  await a.done;
  await until(() => h.system.queue.messages(a.taskId).some((m) => m.status === 'sending'));
  const next = await inspectDelivery(h, a, 'sending');
  gate.resolve();
  await h.idle();
  next.slow.finish('NO_REPLY');
  await next.b.done;
  originalOutput(h, a);
}
async function partialFailure(h: Harness) {
  const { a, slow } = await original(h);
  h.connector.maxChars = 30;
  let parts = 0;
  h.connector.send = async (ctx, out) => {
    const identity = h.connector.identify(ctx, out);
    if (identity.taskId === a.taskId && identity.lane === 'slow' && ctx.kind === 'final') {
      if (++parts === 2) throw new Error('injected-body-segment-failure');
    }
  };
  slow.finish('采购表核实结论：甲12元，乙8元，合计20元。'.repeat(4));
  await a.done;
  await h.idle();
  const next = await inspectDelivery(h, a, 'failed');
  const rows = h.system.queue.messages(a.taskId);
  h.check(
    'partial-failure-not-hidden-by-sent-notice',
    rows.some((m) => m.candidate.lane === 'slow' && m.candidate.body && m.status === 'sent') &&
      rows.some((m) => m.candidate.body && m.status === 'failed') &&
      rows.some((m) => m.candidate.notification && m.status === 'sent'),
    rows
  );
  next.slow.finish('NO_REPLY');
  await next.b.done;
}
async function unknownDelivery(h: Harness) {
  const { a, slow } = await original(h);
  const gate = h.defer();
  h.connector.send = async (_ctx, out) => {
    if (out.text === ORIGINAL_RESULT) await gate.promise;
  };
  slow.finish(ORIGINAL_RESULT);
  await a.done;
  await until(() => h.system.queue.messages(a.taskId).some((m) => m.status === 'sending'));
  h.clock.advance(120001);
  await until(() => h.system.queue.messages(a.taskId).some((m) => m.outcome === 'unknown'));
  gate.resolve();
  await h.idle();
  const next = await inspectDelivery(h, a, 'unknown');
  next.slow.finish('NO_REPLY');
  await next.b.done;
  h.system.queue.wake();
  await h.idle();
  h.check(
    'unknown-outcome-never-retried',
    h.connector.actions.filter((action) => action.text === ORIGINAL_RESULT).length === 1 &&
      h.system.queue.messages(a.taskId).some((m) => m.outcome === 'unknown'),
    { messages: h.system.queue.messages(a.taskId), actions: h.connector.actions }
  );
}
async function missingBodyRecord(h: Harness) {
  const { a, slow } = await original(h);
  slow.finish(ORIGINAL_RESULT);
  await a.done;
  await h.idle();
  const messages = h.system.queue.messages.bind(h.system.queue);
  // Fault only the read capability: real MessageQueue state remains untouched.
  h.system.queue.messages = (id) =>
    messages(id).filter(
      (message) => id !== a.taskId || message.candidate.lane !== 'slow' || !message.candidate.body
    );
  const next = await inspectDelivery(h, a, 'unknown');
  h.system.queue.messages = messages;
  h.check(
    'missing-original-body-evidence',
    messages(a.taskId).some(
      (m) => m.candidate.lane === 'slow' && m.candidate.body && m.status === 'sent'
    ),
    { actualMessages: messages(a.taskId), viewWithoutBody: 'unknown' }
  );
  next.slow.finish('NO_REPLY');
  await next.b.done;
  originalOutput(h, a);
}

type Definition = [string, string, readonly string[], (h: Harness) => Promise<void>];
const definitions: Definition[] = [
  ['C01', '连续进度追问只查询原任务', [...PROGRESS, 'two-progress-inputs'], repeatedProgress],
  [
    'C02',
    '已完成但待发送的进度追问不重做',
    [...PROGRESS, 'completed-result-still-pending'],
    completedProgress,
  ],
  [
    'C03',
    '含补充工作的追问仍执行双lane',
    ['mixed-request-keeps-dual-lanes', 'original-delivered-once-with-reference'],
    mixedFollowUp,
  ],
  [
    'C04',
    '排队期间完成的旧结果进入慢lane',
    [...FRESH, 'new-fast-progresses-during-old-slow', 'fast-context-remains-frozen'],
    queuedContext,
  ],
  [
    'C05',
    '初始化期间结算的旧结果进入慢lane',
    [...FRESH, 'result-not-settled-before-initialization'],
    initializingContext,
  ],
  [
    'C06',
    '执行完成但正文仍待发送',
    [...DELIVERY, 'original-delivered-once-with-reference'],
    pendingDelivery,
  ],
  [
    'C07',
    '执行完成但正文仍在发送',
    [...DELIVERY, 'original-delivered-once-with-reference'],
    sendingDelivery,
  ],
  [
    'C08',
    '部分正文失败不被成功通知掩盖',
    [...DELIVERY, 'partial-failure-not-hidden-by-sent-notice'],
    partialFailure,
  ],
  [
    'C09',
    '超时投递为unknown且不重发',
    [...DELIVERY, 'unknown-outcome-never-retried'],
    unknownDelivery,
  ],
  [
    'C10',
    '缺少原始正文记录不能声称sent',
    [...DELIVERY, 'missing-original-body-evidence', 'original-delivered-once-with-reference'],
    missingBodyRecord,
  ],
];
export const contextCases: BenchmarkCase[] = definitions.map(([id, title, required, run]) => ({
  id,
  title,
  group: CONTEXT_GROUP,
  version: 1,
  steps: [{ text: ORIGINAL_QUESTION }, { text: title }],
  expectation: title,
  requiredAssertions: [...COMMON, ...required],
  run: async (h) => {
    h.clock.time = Date.parse('2026-11-08T05:44:00Z');
    h.check(
      'context-baseline-enabled',
      h.config.sessionContext?.mode === 'board-only' && h.config.sessionContext.progressGuard,
      h.config.sessionContext
    );
    await run(h);
    h.check('all-inputs-create-task', h.inputs.length === h.handles.length, h.inputs);
  },
}));
