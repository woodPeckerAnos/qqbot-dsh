import { readFile } from 'node:fs/promises';
import type { TaskHandleV3 as TaskHandle, Lane } from '@qqbot/contracts';
import { isTaskTerminal } from '../../../src/task/index.js';
import { until } from './harness.js';
import type { Harness } from './harness.js';
import { random } from './clock.js';
import type { BenchmarkCase } from './types.js';
import type { Definition } from './offline-cases.js';

export const remainingCases: Definition[] = [
  [
    'O13',
    '控制与身份',
    '本人管理员跨会话取消权限',
    async (h) => {
      const target = await h.submit({ text: '旧任务', sender: 'alice' }),
        other = await h.submit({ text: '其他成员', sender: 'bob' });
      const admin = await h.submit({ text: '管理员', sender: 'admin' }),
        foreign = await h.submit({ text: '跨群', sender: 'admin', session: 'foreign' });
      const self = await h.submit({ text: '本人', sender: 'alice' });
      h.check('other-denied', !h.control.bind(h.task(other.taskId)).cancel(target.taskId).accepted);
      h.check(
        'cross-session-denied',
        !h.control.bind(h.task(foreign.taskId)).cancel(target.taskId).accepted
      );
      h.check('self-accepted', h.control.bind(h.task(self.taskId)).cancel(target.taskId).accepted);
      h.check('admin-accepted', h.control.bind(h.task(admin.taskId)).cancel(other.taskId).accepted);
      h.system.actor.close();
      await Promise.all(h.handles.map((t) => t.done));
    },
  ],
  [
    'O14',
    '控制与身份',
    '/stop保留排队/new清空未完成',
    async (h) => {
      const first = (await h.input({ text: '执行' }))!;
      await h.runtime(first.taskId, 'fast');
      await h.runtime(first.taskId, 'slow');
      const queued = (await h.input({ text: '排队' }))!;
      await h.input({ text: '/stop', sender: 'admin' });
      await first.done;
      h.check('stop-retains-queued', !isTaskTerminal(h.task(queued.taskId)), h.task(queued.taskId));
      const third = (await h.input({ text: '第三项' }))!;
      await h.input({ text: '/new', sender: 'admin' });
      await queued.done;
      await third.done;
      h.check(
        'new-cancels-all',
        [queued, third].every((t) => h.task(t.taskId).status === 'cancelled')
      );
    },
  ],
  [
    'O15',
    '控制与身份',
    '重复和迟到事件不串属',
    async (h) => {
      const t = (await h.input({ text: '原输入' }, 'dedupe'))!;
      await h.input({ text: '原输入' }, 'dedupe');
      const old = await h.runtime(t.taskId, 'slow');
      await h.finish(t);
      const next = (await h.input({ text: '新输入' }))!,
        current = await h.runtime(next.taskId, 'slow');
      current.event('turn/end', { reason: { kind: 'completed' } }, old.prompts[0]!.sessionId);
      current.event('assistant/message', {
        message: { content: [{ type: 'text', text: '合法事件' }] },
      });
      current.event(
        'assistant/message',
        { message: { content: [{ type: 'text', text: '重复seq错误输出' }] } },
        current.prompts[0]!.sessionId,
        current.seq - 1
      );
      old.finish('迟到旧结果');
      h.check(
        'identity-ignores-late',
        h.task(next.taskId).lanes.slow.status === 'running' && h.handles.length === 2
      );
      await h.finish(next, '新结果');
      h.check(
        'no-late-output',
        h
          .received()
          .every((a) => !a.text.includes('迟到旧结果') && !a.text.includes('重复seq错误输出'))
      );
    },
  ],
  [
    'O16',
    '上下文与媒体',
    '判定期间换代不覆盖新generation',
    async (h) => {
      const warmup = (await h.input({ text: '建立可判定的历史' }))!;
      await h.finish(warmup);
      const gate = h.defer();
      let judging = false;
      h.topicJudge = async () => {
        judging = true;
        await gate.promise;
        return { related: false, mentionsChatRecord: false };
      };
      const pending = h.input({ text: '旧判定' });
      await until(() => judging);
      h.system.actor.reset('group-A');
      gate.resolve();
      const t = (await pending)!;
      h.check(
        'generation-after-reset',
        h.task(t.taskId).input.generation === 2,
        h.task(t.taskId).input
      );
      await h.finish(t);
    },
  ],
  [
    'O17',
    '上下文与媒体',
    '双lane摄取一次且同名附件不串任务',
    async (h) => {
      h.connector.fetch = async (media) =>
        Buffer.from(media.url === 'memory://A' ? 'INPUT-A' : 'INPUT-B');
      const a = (await h.input({ text: '文件A', media: 'file', mediaUrl: 'memory://A' }))!,
        b = (await h.input({ text: '文件B', media: 'file', mediaUrl: 'memory://B' }))!;
      await h.artifact(a, 'artifact-A');
      (await h.runtime(a.taskId, 'fast')).finish('承接A');
      const promptA = (await h.runtime(a.taskId, 'fast')).prompts.find(
        (p) => p.binding?.taskId === a.taskId
      )!.blocks;
      const promptB = (await h.runtime(b.taskId, 'fast')).prompts.find(
        (p) => p.binding?.taskId === b.taskId
      )!.blocks;
      const textA = JSON.stringify(promptA),
        textB = JSON.stringify(promptB);
      h.check(
        'same-name-inputs-isolated',
        textA.includes('INPUT-A') &&
          !textA.includes('INPUT-B') &&
          textB.includes('INPUT-B') &&
          !textB.includes('INPUT-A')
      );
      await h.finish(a, '承接A', '交付A');
      await h.artifact(b, 'artifact-B');
      await h.finish(b, '承接B', '交付B');
      h.check('ingest-once-per-task', h.connector.fetches === 2, h.connector.fetches);
      h.check(
        'same-name-isolated',
        h
          .received(a.taskId)
          .flatMap((a) => a.attachments)
          .some((a) => a.text === 'artifact-A') &&
          h
            .received(b.taskId)
            .flatMap((a) => a.attachments)
            .some((a) => a.text === 'artifact-B')
      );
    },
  ],
  [
    'O18',
    '上下文与媒体',
    '延迟回复保留原问题引用',
    async (h) => {
      h.connector.official = true;
      const t = (await h.input({ text: '原问题' }))!;
      (await h.runtime(t.taskId, 'fast')).finish('承接');
      await h.runtime(t.taskId, 'slow');
      await h.idle();
      h.clock.advance(300001);
      (await h.runtime(t.taskId, 'slow')).finish('延迟增量');
      await t.done;
      const fresh = h.message({ text: '新锚点' });
      h.system.queue.observe(fresh);
      await h.idle();
      await until(() => h.received(t.taskId).length === 2);
      h.check(
        'original-reference-new-anchor',
        h
          .received(t.taskId)
          .filter((a) => a.lane === 'slow')
          .every((a) => a.anchor === fresh.msgId && a.reference?.excerpt === '原问题'),
        h.received(t.taskId)
      );
    },
  ],
  [
    'O19',
    '投递',
    '官方群5/单聊4配额序号及新锚点',
    async (h) => {
      h.connector.official = true;
      h.connector.maxChars = 10;
      for (const session of ['group-quota', 'private-quota']) {
        const t = (await h.input({ text: '配额', session }))!;
        (await h.runtime(t.taskId, 'fast')).finish('甲乙丙丁戊己庚辛壬癸'.repeat(8));
        (await h.runtime(t.taskId, 'slow')).finish('NO_REPLY');
        const quota = session.startsWith('private') ? 4 : 5;
        await until(() => h.received(t.taskId).length === quota);
        h.check('official-quota', h.received(t.taskId).length === quota, h.received(t.taskId));
        h.check(
          'shared-sequence',
          h.received(t.taskId).every((a, i) => a.seq === i + 1)
        );
        h.system.queue.observe(h.message({ text: '新出口', session }));
        await t.done;
        await h.idle();
        h.check(
          'fresh-anchor-drains',
          h.system.queue.messages(t.taskId).every((m) => m.status === 'sent'),
          h.system.queue.messages(t.taskId)
        );
      }
    },
  ],
  [
    'O20',
    '投递',
    '上传阻塞时新快正文仍可发送',
    async (h) => {
      const gate = h.defer();
      h.connector.send = async (_c, out) => {
        if (out.attachments?.length) await gate.promise;
      };
      const first = (await h.input({ text: '生成文件' }))!;
      await h.artifact(first);
      (await h.runtime(first.taskId, 'fast')).finish('承接');
      (await h.runtime(first.taskId, 'slow')).finish('文件就绪');
      await first.done;
      await until(() => h.connector.actions.some((a) => a.attachments.length > 0));
      const next = (await h.input({ text: '短问题' }))!;
      (await h.runtime(next.taskId, 'fast')).finish('短答案');
      await until(() => h.received(next.taskId).length === 1);
      h.check(
        'text-not-blocked-by-upload',
        h.connector.actions.some((a) => a.attachments.length && a.status === 'attempted')
      );
      gate.resolve();
      (await h.runtime(next.taskId, 'slow')).finish('NO_REPLY');
      await next.done;
      await h.idle();
    },
  ],
  [
    'O21',
    '投递',
    '失败超时未知结果不重发通知不递归',
    async (h) => {
      h.connector.send = async () => {
        throw new Error('transport-failure');
      };
      const failed = (await h.input({ text: '发送失败' }))!;
      await h.finish(failed);
      h.system.queue.wake();
      await h.idle();
      h.check(
        'failure-no-recursion',
        h.connector.actions.length === 2 && h.task(failed.taskId).status === 'completed',
        h.connector.actions
      );
      const gate = h.defer();
      h.connector.send = async () => gate.promise;
      const timed = (await h.input({ text: '发送超时' }))!;
      (await h.runtime(timed.taskId, 'fast')).finish('超时正文');
      (await h.runtime(timed.taskId, 'slow')).finish('NO_REPLY');
      await until(() => h.system.queue.snapshot().sending === 1);
      h.clock.advance(120001);
      await new Promise<void>((r) => setImmediate(r));
      gate.resolve();
      await timed.done;
      await h.idle();
      h.system.queue.wake();
      await h.idle();
      h.check(
        'timeout-no-retry',
        h.connector.actions.filter((a) => a.text === '超时正文').length === 1 &&
          h.system.queue.messages(timed.taskId).some((m) => m.outcome === 'unknown'),
        h.system.queue.messages(timed.taskId)
      );
      h.connector.send = async () => {};
      const unknown = (await h.input({ text: '平台成功但终态保存失败' }))!;
      h.stores.messages.fail = (rows) =>
        rows.some((m) => m.candidate.text === 'unknown-body' && m.status === 'sent');
      (await h.runtime(unknown.taskId, 'fast')).finish('unknown-body');
      (await h.runtime(unknown.taskId, 'slow')).finish('NO_REPLY');
      await until(() => h.received(unknown.taskId).length === 1);
      h.system.queue.wake();
      await new Promise<void>((r) => setImmediate(r));
      h.check(
        'post-send-unknown-not-retried',
        h.connector.actions.filter((a) => a.text === 'unknown-body').length === 1 &&
          h.system.queue.messages(unknown.taskId).some((m) => m.outcome === 'unknown')
      );
      h.stores.messages.fail = () => false;
      h.system.queue.wake();
      await unknown.done;
      await h.idle();
    },
  ],
  [
    'O22',
    '持久化与回收',
    '保存失败恢复后只补结算',
    async (h) => {
      const t = await h.submit({ text: '结算恢复' }, true);
      await h.runtime(t.taskId, 'fast');
      await h.runtime(t.taskId, 'slow');
      h.stores.tasks.fail = (rows) => rows.some((r) => isTaskTerminal(r));
      h.stores.budgets.fail = (rows) => rows.some((r) => r.status === 'committed');
      (await h.runtime(t.taskId, 'fast')).finish('保存前已交付');
      (await h.runtime(t.taskId, 'slow')).finish('NO_REPLY');
      await until(
        () => h.system.actor.snapshot().fast.running + h.system.actor.snapshot().slow.running === 0
      );
      h.check('failed-save-not-terminal', !isTaskTerminal(h.task(t.taskId)));
      h.check('budget-save-remains-reserved', h.system.budget.get(t.taskId)?.status === 'reserved');
      h.stores.tasks.fail = () => false;
      h.stores.budgets.fail = () => false;
      h.system.actor.flushSettlements();
      await t.done;
      await h.idle();
      h.check(
        'settlement-no-rerun',
        h.runtimes.length === 2 &&
          h.received(t.taskId).length === 1 &&
          h.terminalCounts.get(t.taskId) === 1
      );
      h.system.output.reconcile(t.taskId);
      h.check('budget-recovered-once', h.system.budget.get(t.taskId)?.status === 'committed');
    },
  ],
  [
    'O23',
    '持久化与回收',
    '重启不重跑中断结果一次',
    async (h) => {
      const t = (await h.input({ text: '重启中断' }))!;
      (await h.runtime(t.taskId, 'fast')).finish('已完成快结果');
      await h.runtime(t.taskId, 'slow');
      await until(() => h.task(t.taskId).lanes.fast.status === 'completed');
      const rows = h.stores.tasks.load();
      await h.restart(rows);
      await h.idle();
      await h.restart();
      await h.idle();
      h.check(
        'restart-one-interruption',
        h.received(t.taskId).filter((a) => a.text.includes('重启')).length === 1 &&
          h.runtimes.length === 2 &&
          h.system.manager.get(t.taskId)?.lanes.fast.result?.kind === 'reply',
        h.system.manager.get(t.taskId)
      );
    },
  ],
  [
    'O24',
    '持久化与回收',
    'Task清理后附件可用关闭释放',
    async (h) => {
      h.connector.connected = false;
      const t = await h.submit({ text: '待发附件' });
      await h.artifact(t, 'durable-copy');
      await h.finish(t, 'NO_REPLY', '附件说明');
      const task = h.task(t.taskId);
      h.archived.push(task);
      h.system.manager.destroy(t.taskId);
      h.system.output.forget(t.taskId);
      await h.preparer.removeWorkspace(task);
      const pending = h.system.queue.messages(t.taskId).find((m) => m.candidate.attachment)!;
      h.check(
        'pending-copy-survives',
        (await readFile(pending.candidate.attachment!.absPath, 'utf8')) === 'durable-copy'
      );
      h.connector.connected = true;
      h.system.queue.observe(h.message({ text: '出口' }));
      await h.idle();
      h.check(
        'attachment-after-prune',
        h
          .received(t.taskId)
          .flatMap((a) => a.attachments)
          .some((a) => a.text === 'durable-copy')
      );
    },
  ],
];

async function load(h: Harness, kind: number) {
  const rng = random(h.seed),
    handles: TaskHandle[] = [],
    order: Record<Lane, string[]> = { fast: [], slow: [] };
  const count = kind === 1 ? 128 : 24;
  const sessions = kind === 1 ? 4 : 6;
  for (let i = 0; i < count; i++)
    handles.push(
      await h.submit(
        { text: `load-${i}`, session: kind === 0 ? 'single' : `session-${i % sessions}` },
        true
      )
    );
  const finished = new Set<string>();
  for (let rounds = 0; finished.size < count * 2 && rounds < count * 4; rounds++) {
    await until(() =>
      h.runtimes.some(
        (r) => r.prompts.length && !finished.has(r.prompts.at(-1)!.binding!.executionId)
      )
    );
    const active = h.runtimes.filter(
        (r) => r.prompts.length && !finished.has(r.prompts.at(-1)!.binding!.executionId)
      ),
      snapshot = h.system.actor.snapshot();
    h.check(
      'load-capacity',
      snapshot.fast.running <= 2 && snapshot.slow.running <= 2 && snapshot.unfinished <= 128,
      snapshot
    );
    active.sort(() => rng() - 0.5);
    for (const r of active) {
      const taskId = r.prompts.at(-1)!.binding!.taskId,
        lane = r.options.env!.QQBOT_LANE as Lane;
      order[lane].push(taskId);
      finished.add(r.prompts.at(-1)!.binding!.executionId);
      const slowText = kind === 2 && rng() > 0.5 ? `increment-${taskId}` : 'NO_REPLY';
      r.finish(lane === 'fast' ? `fast-${taskId}` : slowText);
    }
    h.clock.advance(1);
  }
  await Promise.all(handles.map((t) => t.done));
  await h.idle();
  for (const lane of ['fast', 'slow'] as const)
    for (const session of new Set(h.system.manager.list().map((t) => t.input.message.target.key))) {
      const expected = handles
        .filter((t) => h.task(t.taskId).input.message.target.key === session)
        .map((t) => t.taskId);
      h.check(
        'load-session-fifo',
        JSON.stringify(
          order[lane].filter((id) => h.task(id).input.message.target.key === session)
        ) === JSON.stringify(expected),
        { lane, session, expected }
      );
    }
  const budgets = h.system.budget.list();
  h.check(
    'load-budget-conservation',
    budgets.length === count && budgets.every((b) => b.status === 'committed'),
    budgets
  );
  h.check('load-all-lanes-progress', order.fast.length === count && order.slow.length === count);
  h.metadata.executionOrder = order;
}
async function batchedLoad(h: Harness) {
  const rng = random(h.seed),
    completed = new Set<string>(),
    order: Record<Lane, string[]> = { fast: [], slow: [] };
  const handles: TaskHandle[] = [];
  const settle = (r: Harness['runtimes'][number]) => {
    const id = r.prompts.at(-1)!.binding!.taskId,
      lane = r.options.env!.QQBOT_LANE as Lane;
    completed.add(r.prompts.at(-1)!.binding!.executionId);
    order[lane].push(id);
    r.finish(lane === 'fast' ? `fast-${id}` : 'NO_REPLY');
  };
  for (let batch = 0; batch < 3; batch++) {
    for (let i = 0; i < 8; i++)
      handles.push(await h.submit({ text: `batch-${batch}-${i}`, session: `mix-${i % 4}` }, true));
    while (h.system.actor.snapshot().fast.running + h.system.actor.snapshot().fast.queued > 0) {
      await until(() =>
        h.runtimes.some(
          (r) =>
            r.prompts.length &&
            r.options.env?.QQBOT_LANE === 'fast' &&
            !completed.has(r.prompts.at(-1)!.binding!.executionId)
        )
      );
      h.runtimes
        .filter(
          (r) =>
            r.prompts.length &&
            r.options.env?.QQBOT_LANE === 'fast' &&
            !completed.has(r.prompts.at(-1)!.binding!.executionId)
        )
        .forEach(settle);
      await new Promise<void>((r) => setImmediate(r));
    }
    await until(() =>
      h.runtimes.some(
        (r) =>
          r.prompts.length &&
          r.options.env?.QQBOT_LANE === 'slow' &&
          !completed.has(r.prompts.at(-1)!.binding!.executionId)
      )
    );
    await h.idle();
    h.check(
      'batch-fast-delivery-with-old-slow-running',
      handles.every((t) => h.received(t.taskId).some((a) => a.lane === 'fast')) &&
        h.system.actor.snapshot().slow.running > 0,
      h.system.actor.snapshot()
    );
    const active = h.runtimes.filter(
      (r) =>
        r.prompts.length &&
        r.options.env?.QQBOT_LANE === 'slow' &&
        !completed.has(r.prompts.at(-1)!.binding!.executionId)
    );
    if (active.length) settle(active[Math.floor(rng() * active.length)]!);
  }
  while (completed.size < handles.length * 2) {
    await until(() =>
      h.runtimes.some(
        (r) => r.prompts.length && !completed.has(r.prompts.at(-1)!.binding!.executionId)
      )
    );
    h.runtimes
      .filter((r) => r.prompts.length && !completed.has(r.prompts.at(-1)!.binding!.executionId))
      .forEach(settle);
    h.check(
      'batch-capacity',
      h.system.actor.snapshot().slow.running <= 2 && h.system.actor.snapshot().unfinished <= 128
    );
    h.clock.advance(1);
  }
  await Promise.all(handles.map((t) => t.done));
  await h.idle();
  for (const lane of ['fast', 'slow'] as const)
    for (const session of ['mix-0', 'mix-1', 'mix-2', 'mix-3']) {
      const expected = handles
        .filter((t) => h.task(t.taskId).input.message.target.key === session)
        .map((t) => t.taskId);
      h.check(
        'batch-fifo',
        JSON.stringify(
          order[lane].filter((id) => h.task(id).input.message.target.key === session)
        ) === JSON.stringify(expected),
        { session, lane }
      );
    }
  h.check(
    'batch-budget-conservation',
    h.system.budget.list().length === handles.length &&
      h.system.budget.list().every((b) => b.status === 'committed')
  );
  h.metadata.executionOrder = order;
}
export const mixedCases: BenchmarkCase[] = ['单会话积压', '多会话满容量', '长短任务分批交错'].map(
  (title, i) => ({
    id: `M0${i + 1}`,
    version: 1,
    group: '混合负载',
    title,
    steps: [{ text: title }],
    expectation: '容量FIFO双lane预算守恒释放',
    run: (h) => (i === 2 ? batchedLoad(h) : load(h, i)),
  })
);
