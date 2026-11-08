import type { TaskHandleV2 } from '@qqbot/contracts';
import type { BenchmarkCase } from './types.js';
import { until, type Harness } from './harness.js';

const generate = `只调用一次 bash 工具执行命令 node -e 'console.log("receipt="+require("node:crypto").randomUUID())'。不要调用其他工具，不要保存文件，不要再次生成。最终正文逐字复述命令输出的 receipt=<编号>，不要自行编造编号。`;
const reuse = '请直接复述刚才任务的 receipt 编号，沿用已有结果，不要重新生成。';
const progress = '上个任务进度怎样？';
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;
const controls = new Set(['query_tasks', 'cancel_task']);
const common = ['original-execution-ready', 'original-tool-result', 'live-execution-success'];

function executions(h: Harness, task: TaskHandleV2) {
  return h.evidence.executions.filter((execution) => execution.taskId === task.taskId);
}
function bodyRecords(h: Harness, task: TaskHandleV2) {
  return h.system.queue
    .messages(task.taskId)
    .filter(
      ({ candidate }) =>
        candidate.lane === 'slow' &&
        candidate.kind === 'final' &&
        !!candidate.body &&
        !candidate.notification
    );
}
async function pausedOriginal(h: Harness) {
  const gate = h.defer();
  let pausedTaskId: string | undefined;
  h.beforeRuntimePrompt = (options) => {
    if (options.env?.QQBOT_LANE !== 'slow') return;
    pausedTaskId ??= options.env.QQBOT_TASK_ID;
    if (options.env.QQBOT_TASK_ID === pausedTaskId) return gate.promise;
  };
  const a = (await h.input({ text: generate }))!;
  await until(
    () =>
      (pausedTaskId === a.taskId && h.received(a.taskId).some((reply) => reply.lane === 'fast')) ||
      !!h.task(a.taskId).endedAt,
    h.config.tasks.fastTimeoutMs + h.config.dsh.runtimeStartTimeoutMs
  );
  const ready =
    pausedTaskId === a.taskId &&
    h.task(a.taskId).lanes.slow.status === 'running' &&
    h.received(a.taskId).some((reply) => reply.lane === 'fast');
  h.check('original-execution-ready', ready, h.task(a.taskId));
  if (!ready) throw new Error('original-execution-precondition-missing');
  return { a, release: gate.resolve };
}
function originalResult(h: Harness, a: TaskHandleV2) {
  const result = h.task(a.taskId).lanes.slow.result;
  const receipt =
    result?.kind === 'reply' ? result.text.match(uuid)?.[0]?.toLowerCase() : undefined;
  const slow = executions(h, a).filter((execution) => execution.lane === 'slow');
  const tools = slow.flatMap((execution) => execution.toolNames ?? []);
  const results = slow.flatMap((execution) => execution.toolResultUuids ?? []);
  h.check(
    'original-tool-result',
    !!receipt &&
      slow.length === 1 &&
      slow[0]!.toolErrors === 0 &&
      tools.length === 1 &&
      tools[0] === 'bash' &&
      results.length === 1 &&
      results[0] === receipt,
    { receipt, tools, results, toolErrors: slow[0]?.toolErrors }
  );
  return receipt;
}
function complete(h: Harness) {
  h.check(
    'live-execution-success',
    h.handles.length === 2 && h.system.manager.list().every((task) => task.status === 'completed'),
    h.system.manager.list().map((task) => ({ taskId: task.taskId, status: task.status }))
  );
}
function reference(h: Harness, a: TaskHandleV2) {
  const replies = h.received(a.taskId).filter((reply) => reply.lane === 'slow');
  h.check(
    'original-result-reference',
    replies.length > 0 &&
      replies.every((reply) => reply.reference?.messageId === h.task(a.taskId).input.message.msgId),
    replies
  );
}
async function queuedResult(h: Harness) {
  const { a, release } = await pausedOriginal(h);
  const b = (await h.input({ text: reuse }))!;
  await until(
    () => h.received(b.taskId).some((reply) => reply.lane === 'fast') || !!h.task(b.taskId).endedAt,
    h.config.tasks.fastTimeoutMs + h.config.dsh.runtimeStartTimeoutMs
  );
  h.check(
    'follow-up-admitted-before-result',
    !h.task(a.taskId).endedAt &&
      h.task(b.taskId).input.followUpOf === a.taskId &&
      h.task(b.taskId).lanes.slow.status === 'queued' &&
      h.received(b.taskId).some((reply) => reply.lane === 'fast'),
    { original: h.task(a.taskId), followUp: h.task(b.taskId) }
  );
  release();
  await Promise.all([a.done, b.done]);
  await h.idle();
  const receipt = originalResult(h, a);
  const slow = executions(h, b).find((execution) => execution.lane === 'slow');
  const entry = slow?.contextView?.tasks.find((task) => task.taskId === a.taskId);
  h.check(
    'dispatched-view-has-new-result',
    !!receipt &&
      slow?.contextView?.scope.taskId === b.taskId &&
      entry?.status === 'completed' &&
      entry.lanes.slow.text.toLowerCase().includes(receipt) &&
      h.task(a.taskId).endedAt! >= h.task(b.taskId).createdAt &&
      slow.promptAt! >= h.task(a.taskId).endedAt!,
    { entry, promptAt: slow?.promptAt, admittedAt: h.task(b.taskId).createdAt }
  );
  const replies = h.received(b.taskId);
  h.check(
    'existing-uuid-reused',
    !!receipt && replies.some((reply) => reply.text.toLowerCase().includes(receipt)),
    { receipt, replies },
    'semantic'
  );
  h.check(
    'follow-up-no-business-tools-or-artifacts',
    executions(h, b).every((execution) =>
      (execution.toolNames ?? []).every((name) => controls.has(name))
    ) && replies.every((reply) => reply.attachments.length === 0),
    executions(h, b)
  );
  reference(h, a);
  complete(h);
}
function progressChecks(
  h: Harness,
  a: TaskHandleV2,
  b: TaskHandleV2,
  delivery: 'pending' | 'failed'
) {
  const calls = executions(h, b).flatMap((execution) => execution.taskQueries ?? []);
  h.check(
    'progress-target-query',
    calls.some(
      (call) =>
        call.taskId === a.taskId &&
        Array.isArray(call.result) &&
        call.result.some(
          (task: { taskId?: string; status?: string }) =>
            task.taskId === a.taskId && task.status === 'completed'
        )
    ),
    calls
  );
  h.check(
    'progress-no-slow-resources',
    h.task(b.taskId).input.progressOnly === true &&
      h.task(b.taskId).input.followUpOf === a.taskId &&
      h.task(b.taskId).lanes.slow.result?.kind === 'silent' &&
      executions(h, b).every((execution) => execution.lane !== 'slow'),
    executions(h, b)
  );
  const records = bodyRecords(h, a);
  const snapshot = {
    taskId: a.taskId,
    callerTaskId: b.taskId,
    at: h.connector.now(),
    status: h.task(a.taskId).status,
    delivery:
      records.length > 0 && records.every((record) => record.status === delivery)
        ? delivery
        : 'unknown',
    records: records.map((record) => ({
      id: record.id,
      status: record.status,
      outcome: record.outcome,
    })),
  };
  h.deliveryEvidence.push(snapshot);
  h.check(
    'completed-with-undelivered-body',
    snapshot.status === 'completed' &&
      records.length > 0 &&
      records.every((record) => record.status === delivery) &&
      h
        .received(a.taskId)
        .every((reply) => !records.some((record) => record.id === reply.messageId)),
    snapshot
  );
  h.check(
    'progress-no-artifacts-or-reminders',
    h.system.queue.messages(b.taskId).length > 0 &&
      h.system.queue
        .messages(b.taskId)
        .every(
          ({ candidate }) =>
            candidate.lane === 'fast' &&
            candidate.kind === 'final' &&
            !candidate.attachment &&
            !candidate.notification
        ),
    h.system.queue.messages(b.taskId)
  );
}
async function undeliveredProgress(h: Harness, failed: boolean) {
  const { a, release } = await pausedOriginal(h);
  if (failed)
    h.connector.send = async (ctx, out) => {
      const { messageId } = h.connector.identify(ctx, out);
      if (bodyRecords(h, a).some((record) => record.id === messageId))
        throw new Error('benchmark-original-body-send-failed');
    };
  else h.connector.connected = false;
  release();
  await a.done;
  await h.idle();
  originalResult(h, a);
  const b = (await h.input({ text: progress }))!;
  await b.done;
  await h.idle();
  progressChecks(h, a, b, failed ? 'failed' : 'pending');
  const attempts = h.connector.actions.filter((action) =>
    bodyRecords(h, a).some((record) => record.id === action.messageId)
  ).length;
  h.connector.connected = true;
  h.system.queue.wake();
  await h.idle();
  if (failed)
    h.check(
      'failed-body-never-retried',
      attempts === bodyRecords(h, a).length &&
        h.connector.actions.filter((action) =>
          bodyRecords(h, a).some((record) => record.id === action.messageId)
        ).length === attempts,
      { attempts, records: bodyRecords(h, a) }
    );
  else reference(h, a);
  h.check(
    'progress-answer-delivered',
    h.received(b.taskId).some((reply) => reply.lane === 'fast')
  );
  complete(h);
}

export const liveContextCases: BenchmarkCase[] = [
  {
    id: 'LC01',
    version: 2,
    group: '真实任务衔接',
    title: '排队期间新结果复用',
    steps: [{ text: generate }, { text: reuse, after: 'running' }],
    expectation:
      '原任务实际通过一次业务工具产生 UUID；B 在结果形成前准入，慢 lane 从实际派发的 View 复述同一编号，不再执行业务工具、不产生附件。原结果引用原问题。',
    requiredAssertions: [
      ...common,
      'follow-up-admitted-before-result',
      'dispatched-view-has-new-result',
      'existing-uuid-reused',
      'follow-up-no-business-tools-or-artifacts',
      'original-result-reference',
    ],
    run: queuedResult,
  },
  ...[false, true].map((failed): BenchmarkCase => ({
    id: failed ? 'LC03' : 'LC02',
    version: 2,
    group: '真实任务衔接',
    title: failed ? '投递失败后的真实进度回答' : '完成但待投递的真实进度回答',
    steps: [{ text: generate }, { text: progress, after: 'done' }],
    expectation: `A 执行 completed，但原始慢正文${failed ? '投递失败且不得重试' : '在 B 查询/生成回答时始终 pending，之后才恢复送达'}。B 快 lane 实际查询原 Task，慢 runtime 为零。必须区分执行完成和投递完成；查询没有 delivery 字段时不能宣称已经送达，可如实说明投递未确认。按 deliveryEvidence 和 query 时刻判定，后来恢复送达不能追認此前声称。`,
    requiredAssertions: [
      ...common,
      'progress-target-query',
      'progress-no-slow-resources',
      'completed-with-undelivered-body',
      'progress-no-artifacts-or-reminders',
      'progress-answer-delivered',
      failed ? 'failed-body-never-retried' : 'original-result-reference',
    ],
    run: (h) => undeliveredProgress(h, failed),
  })),
];
