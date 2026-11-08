import type {
  ContextDeliveryStatus,
  SessionContextViewValue,
  TaskHandleV2,
  TaskStatus,
} from '@qqbot/contracts';
import type { Harness } from './harness.js';
import type { BenchmarkRuntime } from './mock-runtime.js';

export const ORIGINAL_QUESTION = '核实采购表中甲12元和乙8元的合计，并说明来源';
export const ORIGINAL_RESULT = '核实结果：合计20元，来源是采购表的甲12元和乙8元。';
export const FOLLOW_UP = '请把刚才的结果整理成表格';

export function promptText(runtime: BenchmarkRuntime): string {
  return runtime.prompts[0]!.blocks.filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
export function runtimes(h: Harness, id: string, lane: 'fast' | 'slow') {
  return h.runtimes.filter(
    (r) => r.options.env?.QQBOT_TASK_ID === id && r.options.env.QQBOT_LANE === lane
  );
}
export async function original(h: Harness) {
  const a = (await h.input({ text: ORIGINAL_QUESTION }))!;
  const slow = await h.runtime(a.taskId, 'slow');
  (await h.runtime(a.taskId, 'fast')).finish('我来核实采购表。');
  await h.idle();
  return { a, slow };
}
export async function progress(h: Harness, a: TaskHandleV2, text: string, status: TaskStatus) {
  const b = (await h.input({ text }))!;
  const fast = await h.runtime(b.taskId, 'fast');
  const query = fast.options.taskControl!({
    action: 'query',
    taskId: a.taskId,
    sessionId: fast.prompts[0]!.sessionId,
  });
  h.check(
    'progress-real-query',
    Array.isArray(query) &&
      query.length === 1 &&
      query[0]?.taskId === a.taskId &&
      query[0].status === status &&
      promptText(fast).includes('必须实际调用 query_tasks') &&
      promptText(fast).includes(`taskId=${a.taskId}`) &&
      h.evidence.executions.some(
        (execution) =>
          execution.taskId === b.taskId &&
          execution.lane === 'fast' &&
          execution.taskQueries?.some((call) => call.taskId === a.taskId)
      ),
    { caller: b.taskId, target: a.taskId, result: query }
  );
  h.check(
    'query-does-not-prove-delivery',
    Array.isArray(query) &&
      query.every((entry) => !('delivery' in entry)) &&
      promptText(fast).includes('查询没有 delivery 字段时，不声称结果已送达'),
    { query, constraint: '查询没有 delivery 字段时，不声称结果已送达' }
  );
  h.check(
    'progress-independent-task',
    b.taskId !== a.taskId &&
      h.task(b.taskId).input.followUpOf === a.taskId &&
      h.task(b.taskId).input.progressOnly === true,
    { original: a.taskId, progress: b.taskId, input: h.task(b.taskId).input }
  );
  h.check(
    'progress-no-slow-resources',
    runtimes(h, b.taskId, 'slow').length === 0 &&
      h.task(b.taskId).lanes.slow.result?.kind === 'silent' &&
      h.system.actor.snapshot().slow.queued === 0,
    { task: h.task(b.taskId), scheduler: h.system.actor.snapshot().slow }
  );
  fast.finish(
    status === 'completed' ? '原任务执行已完成，查询未提供投递状态。' : '原任务还在执行中。'
  );
  await b.done;
  return b;
}
export function progressOutput(h: Harness, tasks: TaskHandleV2[]) {
  const messages = tasks.flatMap((task) => h.system.queue.messages(task.taskId));
  h.check(
    'progress-no-artifacts-or-reminders',
    messages.length === tasks.length &&
      messages.every(
        (message) =>
          message.candidate.lane === 'fast' &&
          message.candidate.kind === 'final' &&
          !message.candidate.attachment &&
          !message.candidate.notification
      ) &&
      tasks.every((task) => runtimes(h, task.taskId, 'slow').length === 0) &&
      h.connector.fetches === 0,
    messages
  );
}
export function originalOutput(h: Harness, a: TaskHandleV2) {
  const received = h.received(a.taskId).filter((action) => action.lane === 'slow');
  h.check(
    'original-delivered-once-with-reference',
    received.length === 1 &&
      received[0]!.text === ORIGINAL_RESULT &&
      received[0]!.reference?.messageId === h.task(a.taskId).input.message.msgId &&
      runtimes(h, a.taskId, 'fast').length === 1 &&
      runtimes(h, a.taskId, 'slow').length === 1,
    received
  );
}
/** Inspect the block actually dispatched to DSH, never recompute an expected View. */
export function readView(h: Harness, task: TaskHandleV2, runtime: BenchmarkRuntime) {
  const block = runtime.prompts[0]!.blocks.find(
    (entry) =>
      entry.type === 'text' && entry.text.startsWith('当前输入是唯一执行项。以下是只读背景')
  );
  if (block?.type !== 'text') throw new Error('missing-dispatched-context-view');
  const json = block.text.match(/<转发内容>\n([\s\S]+)\n<\/转发内容>$/u)?.[1];
  if (!json) throw new Error('malformed-dispatched-context-view');
  const view = JSON.parse(json) as SessionContextViewValue;
  h.check('context-task-identity', view.scope.taskId === task.taskId, view.scope);
  h.check(
    'context-delivery-constraint',
    block.text.includes('delivery=unknown 不能声称已送达') &&
      block.text.includes('pending/sending 结果由原 Task 继续交付，勿重复执行'),
    { taskId: task.taskId, instruction: block.text.split('\n')[0] }
  );
  return view;
}
export async function inspectDelivery(
  h: Harness,
  a: TaskHandleV2,
  expected: ContextDeliveryStatus
) {
  const b = (await h.input({ text: FOLLOW_UP }))!;
  (await h.runtime(b.taskId, 'fast')).finish('整理中。');
  const slow = await h.runtime(b.taskId, 'slow');
  const view = readView(h, b, slow);
  const entry = view.tasks.find((task) => task.taskId === a.taskId);
  h.check(
    'execution-and-delivery-separated',
    h.task(a.taskId).status === 'completed' &&
      entry?.status === 'completed' &&
      entry.lanes.slow.delivery === expected &&
      entry.lanes.fast.delivery === 'sent',
    { task: entry, expected, messages: h.system.queue.messages(a.taskId) }
  );
  return { b, slow };
}
