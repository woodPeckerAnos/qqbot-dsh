import { until } from './harness.js';
import type { Harness } from './harness.js';
import type { BenchmarkCase } from './types.js';
import { remainingCases, mixedCases } from './offline-resources.js';
import { contextCases } from './context-cases.js';

export type Definition = [string, string, string, (h: Harness) => Promise<void>];
const definitions: Definition[] = [
  [
    'O02C',
    '应答出口',
    'O02 正向协作：重复答案在最新快照消费后静默',
    async (h) => {
      const t = (await h.input({ text: '解释勾股定理' }))!;
      const slow = await h.runtime(t.taskId, 'slow');
      slow.cooperation!.responses.push('NO_REPLY');
      await h.finish(
        t,
        '直角三角形两直角边平方和等于斜边平方。',
        '勾股定理说：斜边平方等于两直角边平方之和。',
        true
      );
      h.check(
        'cooperation-duplicate-silent',
        h.received(t.taskId).length === 1 && h.task(t.taskId).lanes.slow.result?.kind === 'silent'
      );
      h.check(
        'cooperation-consumed',
        slow.cooperation!.consumed.some(
          (text) => text.includes('"ready":true') && text.includes('直角三角形')
        )
      );
    },
  ],
  [
    'O03C',
    '应答出口',
    'O03 正向协作：承接完整能力并明确纠正先前结论',
    async (h) => {
      const t = (await h.input({ text: '求解x+y=10，x-y=2' }))!;
      const slow = await h.runtime(t.taskId, 'slow');
      slow.cooperation!.responses.push('纠正先前快答的判断：两式相加得2x=12，所以x=6、y=4。');
      await h.finish(t, '初步算得 x=5、y=5，我会继续核查。', '草稿');
      h.check(
        'cooperation-corrected',
        h.received(t.taskId).at(-1)?.text.startsWith('纠正先前快答') === true
      );
      h.check(
        'cooperation-capability-prompt',
        JSON.stringify((await h.runtime(t.taskId, 'fast')).prompts).includes(
          '不因快 lane 工具限制否认整个 agent 的能力'
        )
      );
    },
  ],
  [
    'O01',
    '应答出口',
    '完全相同正文去重，交换lane完成顺序',
    async (h) => {
      for (const reverse of [false, true]) {
        const t = (await h.input({ text: '精确重复' }))!;
        await h.finish(t, '唯一正文', '唯一正文', reverse);
        h.check('exact-text-dedup', h.received(t.taskId).length === 1, h.received(t.taskId));
      }
    },
  ],
  [
    'O02',
    '应答出口',
    '近似重复保留并报告语义失败',
    async (h) => {
      const t = (await h.input({ text: '解释勾股定理' }))!;
      await h.finish(
        t,
        '直角三角形两直角边平方和等于斜边平方。',
        '勾股定理说：斜边的平方等于两条直角边平方之和。'
      );
      const replies = h.received(t.taskId);
      h.check('known-duplicate-delivered', replies.length === 2, replies);
      h.check(
        'substantive-duplication',
        false,
        replies.map((a) => a.text),
        'semantic'
      );
    },
  ],
  [
    'O03',
    '应答出口',
    '终局能力否认后完整解报告冲突',
    async (h) => {
      const t = (await h.input({ text: '求解x+y=10，x-y=2' }))!;
      await h.finish(t, '我无法解方程，这个任务无法完成。', '两式相加得2x=12，所以x=6、y=4。');
      const replies = h.received(t.taskId);
      h.check('known-contradiction-delivered', replies.length === 2, replies);
      h.check(
        'unexplained-terminal-reversal',
        false,
        replies.map((a) => a.text),
        'semantic'
      );
    },
  ],
  [
    'O04',
    '静默与失败',
    '普通问答慢lane正常NO_REPLY',
    async (h) => {
      const t = (await h.input({ text: '1+1等于几' }))!;
      await h.finish(t, '2');
      h.check(
        'ordinary-silence',
        h.task(t.taskId).status === 'completed' &&
          h.task(t.taskId).lanes.slow.result?.kind === 'silent' &&
          h.received(t.taskId).length === 1,
        h.task(t.taskId)
      );
    },
  ],
  [
    'O05',
    '静默与失败',
    '业务执行后NO_REPLY失败',
    async (h) => {
      const t = (await h.input({ text: '执行计算' }))!;
      (await h.runtime(t.taskId, 'slow')).event('tool/call', { name: 'shell', callId: 'business' });
      await h.finish(t, '会继续处理');
      h.check(
        'silent-after-business-fails',
        h.task(t.taskId).status === 'failed',
        h.task(t.taskId).lanes.slow.result
      );
    },
  ],
  [
    'O06',
    '静默与失败',
    '空结果和子代理失败，交换父子顺序',
    async (h) => {
      const empty = (await h.input({ text: '空结果' }))!;
      await h.finish(empty, '承接', '');
      h.check('empty-fails', h.task(empty.taskId).status === 'failed', h.task(empty.taskId));
      for (const parentFirst of [false, true]) {
        const t = (await h.input({ text: '子代理失败' }))!;
        const r = await h.runtime(t.taskId, 'slow');
        (await h.runtime(t.taskId, 'fast')).finish('等待子代理');
        r.child(true, 'child');
        if (parentFirst) {
          r.finish('完整结果');
          h.check('wait-child', h.task(t.taskId).lanes.slow.status === 'running');
          r.child(false, 'child', 'error');
        } else {
          r.child(false, 'child', 'error');
          r.finish('完整结果');
        }
        await t.done;
        h.check('child-failure-fails', h.task(t.taskId).status === 'failed', h.task(t.taskId));
      }
    },
  ],
  [
    'O07',
    '调度与容量',
    '旧慢任务期间新快回复送达',
    async (h) => {
      const old = (await h.input({ text: '长任务' }))!;
      (await h.runtime(old.taskId, 'fast')).finish('处理中');
      await h.runtime(old.taskId, 'slow');
      await until(() => h.received(old.taskId).length === 1);
      const next = (await h.input({ text: '新的短问题' }))!;
      (await h.runtime(next.taskId, 'fast')).finish('新快答案');
      await until(() => h.received(next.taskId).length === 1);
      h.check(
        'new-fast-before-old-slow',
        h.task(old.taskId).lanes.slow.status === 'running' &&
          !h.task(next.taskId).lanes.slow.startedAt,
        h.system.actor.snapshot()
      );
      (await h.runtime(old.taskId, 'slow')).finish('旧结果增量');
      await old.done;
      (await h.runtime(next.taskId, 'slow')).finish('NO_REPLY');
      await next.done;
    },
  ],
  [
    'O08',
    '调度与容量',
    '多会话容量与公平推进',
    async (h) => {
      const a = await h.submit({ text: 'A1', session: 'A' }),
        a2 = await h.submit({ text: 'A2', session: 'A' });
      const b = await h.submit({ text: 'B', session: 'B' }),
        c = await h.submit({ text: 'C', session: 'C' });
      await h.runtime(a.taskId, 'slow');
      await h.runtime(b.taskId, 'slow');
      h.check(
        'lane-capacity',
        h.system.actor.snapshot().slow.running === 2,
        h.system.actor.snapshot()
      );
      await h.finish(a);
      await h.runtime(c.taskId, 'slow');
      h.check(
        'fair-session-rotation',
        !h.task(a2.taskId).lanes.slow.startedAt,
        h.system.actor.snapshot()
      );
      await h.finish(b);
      await h.finish(c);
      await h.finish(a2);
    },
  ],
  [
    'O09',
    '调度与容量',
    'Session32/全局128原子准入',
    async (h) => {
      for (let s = 0; s < 4; s++) {
        for (let i = 0; i < 32; i++)
          await h.submit({ text: `task-${i}`, session: `capacity-${s}` });
        if (s === 0) {
          let rejected = false;
          try {
            await h.submit({ text: 'session-overflow', session: 'capacity-0' });
          } catch {
            rejected = true;
          }
          h.check(
            'session-32-before-global-full',
            rejected && h.system.manager.list().length === 32,
            h.system.actor.snapshot()
          );
        }
      }
      const before = h.system.actor.snapshot();
      for (const session of ['capacity-0', 'new-session']) {
        let rejected = false;
        try {
          await h.submit({ text: 'overflow', session });
        } catch {
          rejected = true;
        }
        h.check(
          'capacity-reject-atomic',
          rejected && h.system.manager.list().length === 128,
          h.system.actor.snapshot()
        );
      }
      h.check(
        'both-lanes-admitted',
        before.fast.running + before.fast.queued === 128 &&
          before.slow.running + before.slow.queued === 128,
        before
      );
      h.system.actor.close();
      await Promise.all(h.handles.map((t) => t.done));
    },
  ],
  [
    'O10',
    '时序与超时',
    '排队媒体初始化不计执行超时',
    async (h) => {
      const media = h.defer(),
        init = h.defer();
      h.connector.fetch = async () => {
        await media.promise;
        return Buffer.from('prepared');
      };
      h.runtimeSetup = (r) => {
        r.startGate = init.promise;
      };
      const first = (await h.input({ text: '准备媒体', media: 'file' }))!,
        next = (await h.input({ text: '排队' }))!;
      h.clock.advance(h.config.tasks.fastTimeoutMs + 1);
      h.check(
        'media-queue-no-model-timeout',
        h.task(first.taskId).lanes.fast.status === 'queued' &&
          h.task(next.taskId).lanes.fast.status === 'queued',
        h.task(first.taskId)
      );
      media.resolve();
      await until(() => h.runtimes.length === 2);
      h.clock.advance(h.config.tasks.fastTimeoutMs + 1);
      h.check(
        'initialize-no-model-timeout',
        h.task(first.taskId).lanes.fast.status === 'queued',
        h.task(first.taskId)
      );
      init.resolve();
      await h.finish(first);
      await h.finish(next);
    },
  ],
  [
    'O11',
    '时序与超时',
    '提醒满足条件且最多一次',
    async (h) => {
      const t = (await h.input({ text: '长执行' }))!;
      (await h.runtime(t.taskId, 'fast')).finish('承接');
      await h.runtime(t.taskId, 'slow');
      await until(() => h.received(t.taskId).length === 1);
      h.clock.advance(h.config.tasks.reminderMs - 1);
      await h.idle();
      h.check(
        'no-early-reminder',
        h.received(t.taskId).every((a) => a.kind !== 'progress')
      );
      h.clock.advance(1);
      await until(() => h.received(t.taskId).some((a) => a.kind === 'progress'));
      h.clock.advance(h.config.tasks.reminderMs);
      await h.idle();
      h.check(
        'one-reminder',
        h.received(t.taskId).filter((a) => a.kind === 'progress').length === 1
      );
      (await h.runtime(t.taskId, 'slow')).finish('结果');
      await t.done;
      const silent = (await h.input({ text: '快静默' }))!;
      (await h.runtime(silent.taskId, 'fast')).finish('NO_REPLY');
      await h.runtime(silent.taskId, 'slow');
      h.clock.advance(h.config.tasks.reminderMs);
      await h.idle();
      h.check('no-fast-delivery-no-reminder', h.received(silent.taskId).length === 0);
      (await h.runtime(silent.taskId, 'slow')).finish('结果');
      await silent.done;
    },
  ],
  [
    'O12',
    '时序与超时',
    '完成超时取消六种顺序只结算一次',
    async (h) => {
      for (const order of ['ctk', 'ckt', 'tck', 'tkc', 'kct', 'ktc']) {
        const t = (await h.input({ text: order }))!;
        (await h.runtime(t.taskId, 'fast')).finish('承接');
        const r = await h.runtime(t.taskId, 'slow');
        for (const event of order) {
          if (event === 'c') r.finish('最终结果');
          if (event === 't') h.clock.advance(h.config.tasks.slowTimeoutMs + 1);
          if (event === 'k') h.system.actor.cancel(t.taskId);
        }
        await t.done;
        h.check('race-one-terminal', h.terminalCounts.get(t.taskId) === 1, h.task(t.taskId));
      }
    },
  ],
];
const coreCases: BenchmarkCase[] = [...definitions, ...remainingCases].map(
  ([id, group, title, run]) => ({
    id,
    group,
    title,
    run,
    version: 1,
    steps: [{ text: title }],
    expectation: title,
    knownIssue: id === 'O02' || id === 'O03',
  })
);
export const offlineCases: BenchmarkCase[] = [...coreCases, ...contextCases];
export { mixedCases };
