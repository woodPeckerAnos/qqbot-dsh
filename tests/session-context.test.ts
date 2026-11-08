import { describe, expect, it, vi } from 'vitest';
import type {
  TaskSnapshotV2,
  QueuedMessage,
  NormalizedMessage,
  SessionContextView,
  ConversationTurn,
  ObservationEntry,
} from '@qqbot/contracts';
import { DEFAULT_SESSION_CONTEXT } from '@qqbot/contracts';
import { createTaskLifeCycleManagerV2 } from '../src/task/index.js';
import {
  createSessionContextView,
  renderSessionContextView,
  classifyTaskFollowUp,
} from '../src/session/index.js';
import { loadConfig, parseConfigFileText } from '../src/config/index.js';

function message(text = '核实数据', id = 'a'): NormalizedMessage {
  return {
    kind: 'group-at-message',
    target: { platform: 'onebot', kind: 'group', id: '1', key: 'group-A' },
    msgId: id,
    eventId: id,
    senderId: 'alice',
    content: text,
    ts: 0,
    raw: {},
  };
}
function task(id = 'a', sequence = 1): TaskSnapshotV2 {
  return {
    taskId: id,
    creationSequence: sequence,
    createdAt: 100,
    status: 'running',
    cancelAccepted: false,
    input: {
      message: message('核实数据', id),
      reference: {},
      isAdmin: false,
      source: 'user',
      generation: 1,
      context: { window: [], replay: '' },
    },
    lanes: {
      fast: { status: 'completed', result: { kind: 'reply', text: '正在核实' } },
      slow: { status: 'running' },
    },
  };
}
function completed(id = 'a', sequence = 1): TaskSnapshotV2 {
  const t = task(id, sequence);
  t.status = 'completed';
  t.endedAt = 200;
  t.lanes.slow = { status: 'completed', result: { kind: 'reply', text: '核实结果' } };
  return t;
}
function queued(
  t: TaskSnapshotV2,
  lane: 'fast' | 'slow',
  status: QueuedMessage['status'] = 'sent'
): QueuedMessage {
  return {
    id: `${t.taskId}:${lane}`,
    createdAt: 200,
    status,
    candidate: {
      taskId: t.taskId,
      lane,
      message: t.input.message,
      kind: 'final',
      text: t.lanes[lane].result!.kind === 'reply' ? t.lanes[lane].result!.text : '',
      body: { id: lane, index: 0 },
    },
  };
}

describe('pure conservative progress recognition', () => {
  const texts = [
    '进度怎样',
    '进度如何？',
    '进度怎么样',
    '还没有核实完成吗',
    '核实完成了吗',
    '完成了吗',
    '好了没',
    '查到了吗',
    '还在查吗',
    '结果呢',
    '有结果了吗',
    '结果出来了吗',
    '还要多久',
    '什么时候完成',
    '到哪一步了',
    '上一项任务进度怎样？',
    '刚才那个任务完成了吗？',
  ];
  it.each(texts)('recognizes %s', (text) => {
    expect(
      classifyTaskFollowUp({
        message: message(text, 'b'),
        tasks: [task()],
        generation: 1,
        now: 200,
        beforeSequence: 2,
      })
    ).toEqual({ followUpOf: 'a', progressOnly: true });
  });
  it.each([
    '还没吃饭吗',
    '北京天气呢',
    '8加9等于几',
    '完成了吗，顺便生成文件',
    '重新查一遍',
    '补充：只查上海',
    '查到了吗 https://example.com',
    '这个周末天气怎样',
    '好了没？再核实一遍',
    '核实完成了吗？'.repeat(10),
  ])('falls back for %s', (text) => {
    expect(
      classifyTaskFollowUp({
        message: message(text, 'b'),
        tasks: [completed()],
        generation: 1,
        now: 200,
      })
    ).toEqual({});
  });
  it('excludes ambiguous, other sender, generation, source, cancellation and repeated progress targets', () => {
    for (const update of [
      { input: { ...task().input, generation: 2 } },
      { input: { ...task().input, source: 'proactive' as const } },
      { input: { ...task().input, progressOnly: true } },
      { input: { ...task().input, message: { ...message(), senderId: 'bob' } } },
      { cancelAccepted: true },
      { status: 'failed' as const },
      { status: 'cancelled' as const },
      { creationSequence: 2 },
    ]) {
      expect(
        classifyTaskFollowUp({
          message: message('完成了吗'),
          tasks: [{ ...task(), ...update }],
          generation: 1,
          now: 200,
          beforeSequence: 2,
        })
      ).toEqual({});
    }
    expect(
      classifyTaskFollowUp({
        message: message('完成了吗'),
        tasks: [task(), task('other', 2)],
        generation: 1,
        now: 200,
      })
    ).toEqual({});
    expect(
      classifyTaskFollowUp({
        message: message('完成了吗'),
        tasks: [task(), { ...task('p', 2), input: { ...task('p').input, progressOnly: true } }],
        generation: 1,
        now: 200,
      })
    ).toEqual({ followUpOf: 'a', progressOnly: true });
  });
  it('uses the injected time, includes completed nonempty replies only within the window', () => {
    const a = completed();
    expect(
      classifyTaskFollowUp({ message: message('完成了吗'), tasks: [a], generation: 1, now: 300200 })
    ).toHaveProperty('followUpOf', 'a');
    expect(
      classifyTaskFollowUp({ message: message('完成了吗'), tasks: [a], generation: 1, now: 300201 })
    ).toEqual({});
    a.lanes.fast.result = { kind: 'silent', reason: 'no-increment' };
    a.lanes.slow.result = { kind: 'reply', text: '  ' };
    expect(
      classifyTaskFollowUp({ message: message('完成了吗'), tasks: [a], generation: 1, now: 200 })
    ).toEqual({});
  });
  it('only associates ordinary follow-ups through an explicit pointer or complete unique quote', () => {
    const a = task(),
      other = task('other', 2);
    other.input.message.content = '另一个问题';
    other.lanes.fast.result = { kind: 'reply', text: '另一个回复' };
    const quote = (text: string): NormalizedMessage => ({
      ...message(''),
      parts: [
        { type: 'quote', parts: [{ type: 'text', text }] },
        { type: 'text', text: '请整理成表格' },
      ],
    });
    expect(
      classifyTaskFollowUp({
        message: quote('核实数据'),
        tasks: [a, other],
        generation: 1,
        now: 200,
      })
    ).toEqual({ followUpOf: 'a' });
    expect(
      classifyTaskFollowUp({ message: quote('正在核实'), tasks: [a], generation: 1, now: 200 })
    ).toEqual({ followUpOf: 'a' });
    for (const text of ['核实', '核实数据…', '不存在'])
      expect(
        classifyTaskFollowUp({ message: quote(text), tasks: [a], generation: 1, now: 200 })
      ).toEqual({});
    expect(
      classifyTaskFollowUp({
        message: quote('核实数据'),
        tasks: [a, task('same', 2)],
        generation: 1,
        now: 200,
      })
    ).toEqual({});
    expect(
      classifyTaskFollowUp({
        message: message('把刚才的结果重新核实并补充来源'),
        tasks: [a],
        generation: 1,
        now: 200,
      })
    ).toEqual({ followUpOf: 'a' });
    expect(
      classifyTaskFollowUp({
        message: {
          ...message('完成了吗'),
          parts: [
            { type: 'text', text: '完成了吗' },
            { type: 'image', url: 'memory://image' },
          ],
        },
        tasks: [a],
        generation: 1,
        now: 200,
      })
    ).toEqual({});
  });
});

describe('read-only incremental SessionContextView', () => {
  function read(
    tasks: TaskSnapshotV2[],
    current = task('b', 9),
    settings: Parameters<typeof createSessionContextView>[0]['settings'] = {},
    records: QueuedMessage[] = []
  ) {
    return createSessionContextView({
      settings,
      tasks: () => tasks,
      messages: (id) => records.filter((r) => r.candidate.taskId === id),
      generation: () => 1,
      now: () => 500,
    }).read(current);
  }
  it('isolates scope, same-millisecond sequence, sources and terminal interval with explicit older/running targets', () => {
    const old = completed('old');
    old.endedAt = 99;
    const cross = completed('cross');
    cross.input.generation = 2;
    const session = completed('session');
    session.input.message.target.key = 'other';
    const proactive = completed('proactive');
    proactive.input.source = 'proactive';
    const cancelled = completed('cancelled');
    cancelled.status = 'cancelled';
    cancelled.lanes = { fast: { status: 'cancelled' }, slow: { status: 'cancelled' } };
    const failed = completed('failed');
    failed.status = 'failed';
    const current = task('b', 9);
    const tasks = [
      old,
      cross,
      session,
      proactive,
      cancelled,
      failed,
      completed('newer', 10),
      task('running'),
      completed('same-time', 8),
    ];
    expect(read(tasks, current).tasks.map((t) => t.taskId)).toEqual([
      'same-time',
      'proactive',
      'failed',
    ]);
    current.input.followUpOf = 'old';
    expect(read(tasks, current).tasks[0]).toMatchObject({ taskId: 'old', explicit: true });
    current.input.followUpOf = 'running';
    expect(read(tasks, current).tasks[0]).toMatchObject({ taskId: 'running', status: 'running' });
    expect(read(tasks, current).tasks.find((t) => t.taskId === 'proactive')?.source).toBe(
      'proactive'
    );
  });
  it('orders explicit then same sender then others, newest completion first and preserves both lane bodies', () => {
    const a = completed('a'),
      bob = completed('bob', 2),
      newer = completed('newer', 3);
    bob.input.message.senderId = 'bob';
    bob.endedAt = 450;
    newer.endedAt = 400;
    const current = task('b', 9);
    current.input.followUpOf = 'a';
    const view = read([bob, newer, a], current);
    expect(view.tasks.map((t) => t.taskId)).toEqual(['a', 'newer', 'bob']);
    expect(view.tasks[0]!.lanes.fast.text).toBe('正在核实');
    expect(view.tasks[0]!.lanes.slow.text).toBe('核实结果');
  });
  it.each(['pending', 'sending', 'sent', 'failed', 'discarded'] as const)(
    'aggregates original body delivery %s',
    (status) => {
      const a = completed();
      const records = [queued(a, 'slow', status)];
      records.push({
        ...queued(a, 'slow', 'failed'),
        id: 'notice',
        candidate: { ...queued(a, 'slow').candidate, body: undefined, notification: true },
      });
      expect(read([a], undefined, {}, records).tasks[0]!.lanes.slow.delivery).toBe(
        status === 'discarded' ? 'failed' : status
      );
    }
  );
  it('does not claim sent for partial failure, unknown outcome, absent body or missing slices', () => {
    const a = completed();
    const sent = queued(a, 'slow');
    expect(read([a]).tasks[0]!.lanes.slow.delivery).toBe('unknown');
    expect(
      read([a], undefined, {}, [{ ...sent, outcome: 'unknown' }]).tasks[0]!.lanes.slow.delivery
    ).toBe('unknown');
    expect(
      read([a], undefined, {}, [sent, { ...sent, id: 'failed', status: 'failed' }]).tasks[0]!.lanes
        .slow.delivery
    ).toBe('failed');
    expect(
      read([a], undefined, {}, [{ ...sent, candidate: { ...sent.candidate, text: '核实' } }])
        .tasks[0]!.lanes.slow.delivery
    ).toBe('unknown');
    expect(
      read([a], undefined, {}, [{ ...sent, candidate: { ...sent.candidate, body: undefined } }])
        .tasks[0]!.lanes.slow.delivery
    ).toBe('unknown');
  });
  it('enforces per-task and rendered budgets including escaping; slow body gets priority and stats remain exact', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => {
      const a = completed(`a${i}`, i + 1);
      a.input.message.content = '问'.repeat(600);
      a.lanes.fast.result = { kind: 'reply', text: '快'.repeat(2000) };
      a.lanes.slow.result = { kind: 'reply', text: '</转发内容>\\\n"'.repeat(1000) };
      return a;
    });
    const current = task('b', 20);
    const view = read(tasks, current, { maxTasks: 8, maxCharsPerTask: 800, maxTotalChars: 2200 });
    const text = renderSessionContextView(view);
    expect(text.length).toBeLessThanOrEqual(2200);
    expect(text.endsWith('</转发内容>')).toBe(true);
    expect(text.match(/<\/转发内容>/g)).toHaveLength(1);
    expect(view.stats.omittedTasks).toBe(tasks.length - view.tasks.length);
    expect(view.stats.omittedChars).toBe(
      tasks.reduce(
        (n, a) =>
          n +
          a.input.message.content.length +
          (a.lanes.fast.result as { text: string }).text.length +
          (a.lanes.slow.result as { text: string }).text.length,
        0
      ) -
        view.tasks.reduce(
          (n, a) => n + a.question.length + a.lanes.fast.text.length + a.lanes.slow.text.length,
          0
        )
    );
    for (const a of view.tasks) {
      expect(a.question.length).toBeLessThanOrEqual(500);
      expect(a.lanes.fast.text).toBe('');
      expect(a.lanes.slow.text.length).toBeLessThanOrEqual(800);
    }
  });
  it('does not split UTF-16 pairs when truncating a question or body', () => {
    const a = completed();
    a.input.message.content = '问'.repeat(499) + '😀';
    a.lanes.slow.result = { kind: 'reply', text: '😀结论' };
    const view = read([a], undefined, { maxCharsPerTask: 1 });
    expect(view.tasks[0]!.question.length).toBe(499);
    expect(view.tasks[0]!.questionOmittedChars).toBe(2);
    expect(view.tasks[0]!.lanes.slow.text).toBe('');
    expect(view.tasks[0]!.lanes.slow.omittedChars).toBe(4);
  });
  it('returns deep immutable snapshots and empty/off reads do not invoke capabilities', () => {
    const a = completed();
    const view = read([a]);
    expect(() => {
      (
        view as unknown as SessionContextView & { tasks: ContextMutable[] }
      ).tasks[0]!.lanes.slow.text = 'mutated';
    }).toThrow();
    a.lanes.slow.result = { kind: 'reply', text: 'changed later' };
    expect(view.tasks[0]!.lanes.slow.text).toBe('核实结果');
    expect(renderSessionContextView(read([]))).toBe('');
    const tasks = vi.fn(() => {
      throw new Error('must not read');
    });
    expect(
      renderSessionContextView(
        createSessionContextView({
          settings: { mode: 'off' },
          tasks,
          messages: tasks,
          generation: tasks,
          now: () => 100,
        }).read(task())
      )
    ).toBe('');
  });
  it('full mode merges and deduplicates pure background while isolating generations and current/covered input', () => {
    const current = task('b', 9);
    current.createdAt = 100;
    const conversation: ConversationTurn[] = [
      { role: 'user', speaker: 'bob', text: '背景', ts: 150 },
      {
        role: 'user',
        speaker: 'alice',
        text: current.input.message.content,
        ts: current.input.message.ts,
      },
      { role: 'assistant', speaker: 'bot', text: '核实结果', ts: 200, taskId: 'a' },
      { role: 'user', speaker: 'bob', text: '[文件: secret.pdf]', ts: 160 },
    ];
    const window: ObservationEntry[] = [
      { msgId: 'x', eventId: 'x', senderId: 'bob', text: '背景', ts: 150, addressed: false },
    ];
    const readConversation = vi.fn(() => conversation),
      readWindow = vi.fn(() => window);
    const factory = (generation: number) =>
      createSessionContextView({
        settings: { mode: 'full', maxRecentMessages: 12 },
        tasks: () => [completed()],
        messages: () => [],
        generation: () => generation,
        sinceTs: () => 100,
        conversations: readConversation,
        window: readWindow,
        now: () => 500,
      });
    expect(factory(1).read(current).messages).toEqual([
      { source: 'conversation', speaker: 'bob', text: '背景', ts: 150 },
    ]);
    readConversation.mockClear();
    readWindow.mockClear();
    expect(factory(2).read(current).messages).toEqual([]);
    expect(readConversation).not.toHaveBeenCalled();
    expect(readWindow).not.toHaveBeenCalled();
  });
  it('projects restored old records without new input fields', () => {
    const a = completed();
    const manager = createTaskLifeCycleManagerV2({
      store: { domain: 'tasks', load: () => [a], save: () => {} },
    });
    expect(manager.get('a')!.input.followUpOf).toBeUndefined();
    expect(read(structuredClone(manager.list())).tasks[0]!.lanes.fast.delivery).toBe('unknown');
  });
});
type ContextMutable = { lanes: { slow: { text: string } } };

describe('sessionContext config', () => {
  const env = {
    BOT_CONNECTORS: 'onebot',
    ONEBOT_ACCESS_TOKEN: 'offline',
    DEEPSEEK_API_KEY: 'offline',
  };
  it('fills defaults for old configs and supports both rollback switches', () => {
    expect(loadConfig(env).sessionContext).toEqual(DEFAULT_SESSION_CONTEXT);
    expect(
      loadConfig(env, parseConfigFileText('sessionContext:\n  mode: off\n  progressGuard: false\n'))
        .sessionContext
    ).toMatchObject({ mode: 'off', progressGuard: false });
  });
  it.each([
    'mode: bad',
    'progressGuard: "true"',
    'maxTasks: 0',
    'maxRecentMessages: 13',
    'maxCharsPerTask: -1',
    'maxTotalChars: 100',
    'recentTaskWindowMs: 0',
    'maxTasks: 1.5',
    'typo: true',
  ])('strictly rejects %s', (setting) => {
    expect(() => loadConfig(env, parseConfigFileText(`sessionContext:\n  ${setting}\n`))).toThrow();
  });
});
