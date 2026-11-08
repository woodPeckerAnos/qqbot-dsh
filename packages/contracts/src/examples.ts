import { immutableConstant } from './readonly.js';
import type { modules } from './metadata.js';

/** Historical v1 union stays closed; consumers of newly registered modules use V2. */
export type ContractModuleId = Exclude<(typeof modules)[number]['id'], 'session'>;
export type ContractModuleIdV2 = (typeof modules)[number]['id'];
export interface ContractExample {
  readonly id: string;
  readonly module: ContractModuleId;
  readonly kind: 'normal' | 'edge' | 'failure';
  readonly input: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<Record<string, unknown>>;
}
export interface ContractExampleV2 extends Omit<ContractExample, 'module'> {
  readonly module: ContractModuleIdV2;
}

/** 数据夹具由消费者测试和独立离线冒烟共用；此包不包含生产实现。 */
export const contractExamples = immutableConstant([
  {
    id: 'session.normal',
    module: 'session',
    kind: 'normal',
    input: { text: '完成了吗', target: true },
    expected: {
      followUpOf: 'original',
      progressOnly: true,
      contextTasks: 1,
      rendered: true,
      immutable: true,
    },
  },
  {
    id: 'session.edge',
    module: 'session',
    kind: 'edge',
    input: { text: '完成了吗', target: false },
    expected: { contextTasks: 0, rendered: false, immutable: true },
  },
  {
    id: 'session.failure',
    module: 'session',
    kind: 'failure',
    input: { text: '还没吃饭吗', target: true },
    expected: {},
  },

  {
    id: 'config.normal',
    module: 'config',
    kind: 'normal',
    input: { text: 'onebot:\n  port: 6700\n' },
    expected: { value: { onebot: { port: 6700 } } },
  },
  {
    id: 'config.edge',
    module: 'config',
    kind: 'edge',
    input: { text: '' },
    expected: { value: {} },
  },
  {
    id: 'config.failure',
    module: 'config',
    kind: 'failure',
    input: { text: 'unknown_section: true\n' },
    expected: { rejected: true, error: 'ConfigError' },
  },

  {
    id: 'content.normal',
    module: 'content',
    kind: 'normal',
    input: { text: '甲乙丙丁。戊己庚辛。', maxChars: 5, maxSegments: 2 },
    expected: { segments: ['甲乙丙丁。', '戊己庚辛。'], truncated: false, originalLength: 10 },
  },
  {
    id: 'content.edge',
    module: 'content',
    kind: 'edge',
    input: { text: '  ', maxChars: 40, maxSegments: 2 },
    expected: { segments: [], truncated: false, originalLength: 0 },
  },
  {
    id: 'content.failure',
    module: 'content',
    kind: 'failure',
    input: { text: '无法交付的正文', maxChars: 40, maxSegments: 0 },
    expected: { segments: [], truncated: true, originalLength: 7 },
  },

  {
    id: 'connectors.normal',
    module: 'connectors',
    kind: 'normal',
    input: { token: 'fixture-token', expiresIn: '7200', concurrent: false },
    expected: {
      tokens: ['fixture-token', 'fixture-token'],
      fetchCalls: 1,
      hasToken: true,
      expiresInMs: 7200000,
    },
  },
  {
    id: 'connectors.edge',
    module: 'connectors',
    kind: 'edge',
    input: { token: 'concurrent-token', expiresIn: '120', concurrent: true },
    expected: {
      tokens: ['concurrent-token', 'concurrent-token'],
      fetchCalls: 1,
      hasToken: true,
      expiresInMs: 120000,
    },
  },
  {
    id: 'connectors.failure',
    module: 'connectors',
    kind: 'failure',
    input: { code: 100016, message: 'invalid app credentials' },
    expected: { rejected: true, code: 100016, fetchCalls: 1, hasToken: false },
  },

  {
    id: 'store.normal',
    module: 'store',
    kind: 'normal',
    input: {
      allowlist: ['ob11:g1'],
      messages: [
        { id: 'm1', text: '第一条', ts: 100 },
        { id: 'm2', text: '第二条', ts: 110 },
      ],
      maxAgeMs: 20,
    },
    expected: { accepted: [true, true], texts: ['第一条', '第二条'], buffered: 2 },
  },
  {
    id: 'store.edge',
    module: 'store',
    kind: 'edge',
    input: { allowlist: [], messages: [{ id: 'm1', text: '白名单外', ts: 100 }], maxAgeMs: 20 },
    expected: { accepted: [false], texts: [], buffered: 0 },
  },
  {
    id: 'store.failure',
    module: 'store',
    kind: 'failure',
    input: { sessionKey: 'ob11:g1', failWrite: true },
    expected: { rejected: true, error: 'PERSISTENCE_FAILED', sessions: 0 },
  },

  {
    id: 'media.normal',
    module: 'media',
    kind: 'normal',
    input: { fileName: 'note.txt', bytes: [104, 101, 108, 108, 111, 13, 10], maxChars: 40 },
    expected: { extraction: { text: 'hello' }, spawnCalls: 0 },
  },
  {
    id: 'media.edge',
    module: 'media',
    kind: 'edge',
    input: { fileName: 'empty.txt', bytes: [], maxChars: 40 },
    expected: { extraction: { reason: '文件内容为空' }, spawnCalls: 0 },
  },
  {
    id: 'media.failure',
    module: 'media',
    kind: 'failure',
    input: { fileName: 'binary.txt', bytes: [0, 1, 2], maxChars: 40 },
    expected: { extraction: { reason: '该文件是二进制内容，未按文本读取' }, spawnCalls: 0 },
  },

  {
    id: 'runtime.normal',
    module: 'runtime',
    kind: 'normal',
    input: { sessionId: 'fixture-session', text: '最终答案', reason: 'completed', idle: true },
    expected: {
      initialized: true,
      promptReceipt: 'fixture-message',
      settled: true,
      result: { kind: 'completed', text: '最终答案', reason: 'completed' },
      pendingAfterClose: 0,
    },
  },
  {
    id: 'runtime.edge',
    module: 'runtime',
    kind: 'edge',
    input: { sessionId: 'fixture-session', text: '等待idle', reason: 'completed', idle: false },
    expected: { settled: false, sawTurnEnd: true, text: '等待idle' },
  },
  {
    id: 'runtime.failure',
    module: 'runtime',
    kind: 'failure',
    input: { frame: 'not-json\n' },
    expected: { violations: 1, error: 'ProtocolViolationError', pendingAfterClose: 0 },
  },

  {
    id: 'task.normal',
    module: 'task',
    kind: 'normal',
    input: { taskId: 'fixture-task', now: 100, finishBoth: true },
    expected: { status: 'completed', fast: 'completed', slow: 'completed', done: true },
  },
  {
    id: 'task.edge',
    module: 'task',
    kind: 'edge',
    input: { taskId: 'fixture-task', now: 100, finishBoth: false },
    expected: { status: 'running', fast: 'completed', slow: 'queued', done: false },
  },
  {
    id: 'task.failure',
    module: 'task',
    kind: 'failure',
    input: { taskId: 'fixture-task', now: 100, failWrite: true },
    expected: { rejected: true, tasks: 0, notifications: 0 },
  },

  {
    id: 'delivery.normal',
    module: 'delivery',
    kind: 'normal',
    input: { text: '交付结果', duplicate: false, failSend: false, record: true },
    expected: {
      sent: 1,
      failed: 0,
      attempts: 1,
      referenceMessageId: 'original-message',
      recordNodes: 1,
    },
  },
  {
    id: 'delivery.edge',
    module: 'delivery',
    kind: 'edge',
    input: { text: '同一产物', duplicate: true, failSend: false },
    expected: { sent: 1, failed: 0, attempts: 1, referenceMessageId: 'original-message' },
  },
  {
    id: 'delivery.failure',
    module: 'delivery',
    kind: 'failure',
    input: { text: '发送失败', duplicate: false, failSend: true },
    expected: { sent: 0, failed: 2, attempts: 2, failureNotifications: 1, sourceAttempts: 1 },
  },

  {
    id: 'ingress.normal',
    module: 'ingress',
    kind: 'normal',
    input: { stages: ['dedupe', 'command', 'record'], shortcut: '', failAt: '' },
    expected: { visited: ['dedupe', 'command', 'record', 'actor'], rejected: false },
  },
  {
    id: 'ingress.edge',
    module: 'ingress',
    kind: 'edge',
    input: { stages: ['dedupe', 'command', 'record'], shortcut: 'command', failAt: '' },
    expected: { visited: ['dedupe', 'command'], rejected: false },
  },
  {
    id: 'ingress.failure',
    module: 'ingress',
    kind: 'failure',
    input: { stages: ['dedupe', 'command', 'record'], shortcut: '', failAt: 'dedupe' },
    expected: { visited: ['dedupe'], rejected: true },
  },

  {
    id: 'proactive.normal',
    module: 'proactive',
    kind: 'normal',
    input: { now: 100, budget: 2, question: '这个接口怎么调用？' },
    expected: {
      scopeId: 'ob11:g1:topic-2',
      budgetLeft: 1,
      committed: 1,
      pendingQuestions: 1,
      windowWrites: 1,
    },
  },
  {
    id: 'proactive.edge',
    module: 'proactive',
    kind: 'edge',
    input: { now: 100, budget: 0, question: '' },
    expected: {
      scopeId: 'ob11:g1:topic-2',
      budgetLeft: 0,
      committed: 0,
      pendingQuestions: 0,
      windowWrites: 0,
    },
  },
  {
    id: 'proactive.failure',
    module: 'proactive',
    kind: 'failure',
    input: { now: 100, budget: 2 },
    expected: {
      snapshotWriteRejected: true,
      closed: 1,
      firstClose: true,
      secondClose: false,
      afterUnsubscribe: 1,
    },
  },

  {
    id: 'offpeak.normal',
    module: 'offpeak',
    kind: 'normal',
    input: { windows: '00:00-09:00', now: 1793665800000, isAdmin: false },
    expected: { gated: false, reason: 'in-window' },
  },
  {
    id: 'offpeak.edge',
    module: 'offpeak',
    kind: 'edge',
    input: { windows: '00:00-09:00', now: 1793707200000, isAdmin: true },
    expected: { gated: false, reason: 'admin' },
  },
  {
    id: 'offpeak.failure',
    module: 'offpeak',
    kind: 'failure',
    input: { windows: '00:00-09:00,08:00-10:00' },
    expected: { rejected: true, error: 'OffpeakConfigError' },
  },

  {
    id: 'observability.normal',
    module: 'observability',
    kind: 'normal',
    input: { amount: 2, distributionAmount: 1 },
    expected: { received: 2, closedByIdle: 1, snapshotWriteRejected: true },
  },
  {
    id: 'observability.edge',
    module: 'observability',
    kind: 'edge',
    input: { amount: 0, distributionAmount: 0 },
    expected: { received: 0, closedByIdle: 0, snapshotWriteRejected: true },
  },
  {
    id: 'observability.failure',
    module: 'observability',
    kind: 'failure',
    input: { amount: -1 },
    expected: { rejected: true, error: 'RangeError', received: 0 },
  },
] as const satisfies readonly ContractExampleV2[]);
