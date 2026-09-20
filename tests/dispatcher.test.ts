/**
 * 编排器集成单测（假 runtime + 假 QQ API，全离线）。
 *
 * 这是最接近真实行为的一层，验证的是**用户最终看到的东西**：
 *   - 一轮问答结束后回复了正确的最终答案（而不是中间那句"我来看看"）；
 *   - `msg_seq` 单调递增且不重复（否则平台会 40054005 去重，用户收不到第二条）；
 *   - 进度回执不会把配额吃光；
 *   - 超时能给出交代；
 *   - 重复事件被丢弃；
 *   - 冷启动会把历史回放进 prompt。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, type Config } from '../src/config.js';
import { createNullLogger } from '../src/logger.js';
import type { RuntimeEntry, RuntimePool } from '../src/dsh/pool.js';
import type { SessionEventNotification } from '../src/dsh/protocol.js';
import { Dispatcher } from '../src/pipeline/dispatcher.js';
import { ConversationStore } from '../src/store/conversations.js';
import { ensureStoreDirs, resolveStorePaths } from '../src/store/paths.js';
import { SeenStore } from '../src/store/seen.js';
import { SessionStore } from '../src/store/sessions.js';
import type { SendMessageRequest } from '../src/qq/types.js';
import {
  c2cTarget,
  groupTarget,
  type ConversationTarget,
  type NormalizedMessage,
} from '../src/qq/gateway.js';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 假的 runtime：记录 prompt，允许测试手动注入事件与状态。 */
class FakeRuntime {
  readonly prompts: Array<{ sessionId: string; text: string }> = [];
  ready = true;
  private readonly eventHandlers: Array<(n: SessionEventNotification) => void> = [];
  private readonly statusHandlers: Array<(n: { sessionId: string; status: 'idle' | 'running' }) => void> = [];

  constructor(readonly options: { cwd: string }) {}

  get isReady(): boolean {
    return this.ready;
  }

  get pid(): number {
    return 4242;
  }

  on(event: string, handler: (payload: never) => void): void {
    if (event === 'session.event') this.eventHandlers.push(handler as never);
    if (event === 'session.status') this.statusHandlers.push(handler as never);
  }

  async start(): Promise<unknown> {
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } };
  }

  async prompt(sessionId: string, text: string): Promise<{ messageId: string }> {
    this.prompts.push({ sessionId, text });
    return { messageId: `m-${this.prompts.length}` };
  }

  async dispose(): Promise<void> {
    this.ready = false;
  }

  // --- 测试驱动接口 ---
  emitEvent(sessionId: string, event: { type: string; seq: number; data: Record<string, unknown> }): void {
    for (const handler of this.eventHandlers) handler({ sessionId, event });
  }

  emitStatus(sessionId: string, status: 'idle' | 'running'): void {
    for (const handler of this.statusHandlers) handler({ sessionId, status });
  }

  /** 模拟一轮完整回答：running → assistant 若干 → turn/end → idle */
  completeTurn(sessionId: string, texts: string[], reason: { kind: string } = { kind: 'completed' }): void {
    this.emitStatus(sessionId, 'running');
    texts.forEach((text, index) => {
      this.emitEvent(sessionId, {
        type: 'assistant/message',
        seq: index + 1,
        data: { turn: 1, step: index + 1, message: { content: [{ type: 'text', text }] } },
      });
    });
    this.emitEvent(sessionId, { type: 'turn/end', seq: 90, data: { turn: 1, reason } });
    this.emitStatus(sessionId, 'idle');
  }
}

/** 假池：只维护一个 runtime（够用，且行为可控）。 */
function createFakePool(runtime: FakeRuntime) {
  const pool = {
    size: 1,
    activeConversationKeys: () => ['g'],
    on: vi.fn(),
    acquire: vi.fn(
      async (conversationKey: string, workspacePath: string): Promise<RuntimeEntry> => {
        // workspacePath 应指向该会话的专属工作区（由 ensureWorkspace 创建）
        expect(workspacePath).toContain('ws');
        return {
          conversationKey,
          runtime: runtime as never,
          sessionId: 's',
          replayed: false,
          createdAt: 0,
          lastUsedAt: 0,
          busy: false,
        };
      },
    ),
    release: vi.fn(),
    drop: vi.fn(async () => {}),
    disposeAll: vi.fn(async () => {}),
  };
  return pool as unknown as RuntimePool & { acquire: ReturnType<typeof vi.fn> };
}

interface SentMessage {
  /** 发往哪个会话（群 openid 或用户 openid） */
  target: ConversationTarget;
  body: SendMessageRequest;
}

function setup(options: { configOverrides?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-disp-'));
  const paths = resolveStorePaths({
    workspacesRoot: join(root, 'ws'),
    stateDir: join(root, 'bot'),
  });
  ensureStoreDirs(paths);

  const config: Config = loadConfig({
    QQ_APP_ID: 'a',
    QQ_APP_SECRET: 's',
    DEEPSEEK_API_KEY: 'k',
    QQ_MAX_REPLIES_PER_MSG: '4',
    QQ_PROGRESS_MAX: '2',
    QQ_PROGRESS_AFTER_MS: '60000',
    QQ_TURN_TIMEOUT_MS: '90000',
    QQ_MAX_CHARS: '200',
    ...options.configOverrides,
  });

  const logger = createNullLogger();
  const runtime = new FakeRuntime({ cwd: paths.workspacesRoot });
  const pool = createFakePool(runtime);
  const sent: SentMessage[] = [];
  const api = {
    sendGroupMessage: vi.fn(async (groupOpenid: string, body: SendMessageRequest) => {
      sent.push({ target: groupTarget(groupOpenid), body });
      return { id: `resp-${sent.length}` };
    }),
    sendUserMessage: vi.fn(async (userOpenid: string, body: SendMessageRequest) => {
      sent.push({ target: c2cTarget(userOpenid), body });
      return { id: `resp-${sent.length}` };
    }),
  };

  const conversations = new ConversationStore(paths, logger);
  const seen = new SeenStore({ paths, logger });
  const sessions = new SessionStore({ paths, logger });

  const dispatcher = new Dispatcher({
    config,
    logger,
    pool,
    api: api as never,
    conversations,
    seen,
    sessions,
    paths,
  });

  // 接线：真实实现里 main.ts 把 pool 的事件转给 dispatcher。
  // 这里的假池 on() 只是 spy，所以直接订阅假 runtime 的事件。
  runtime.on('session.event', (n: SessionEventNotification) => {
    const conversationKey = conversationKeyOf(n.sessionId, sessions);
    dispatcher.routeSessionEvent(conversationKey, n.event);
  });
  runtime.on('session.status', (n: { sessionId: string; status: 'idle' | 'running' }) => {
    const conversationKey = conversationKeyOf(n.sessionId, sessions);
    dispatcher.routeSessionStatus(conversationKey, n);
  });

  return {
    root,
    paths,
    config,
    dispatcher,
    runtime,
    pool,
    api,
    sent,
    conversations,
    sessions,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * 假 runtime 的事件不带会话信息，测试里只有一个会话，直接映射回去即可。
 * 用 sessionId → conversationKey 反查，避免硬编码。
 */
function conversationKeyOf(sessionId: string, sessions: SessionStore): string {
  for (const record of sessions.all()) {
    if (record.currentSessionId === sessionId) return record.conversationKey;
  }
  return 'GROUP-1';
}

function makeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    kind: 'group-at-message',
    target: groupTarget('GROUP-1'),
    eventId: 'EVENT-1',
    msgId: 'MSG-1',
    senderId: 'MEMBER-1',
    username: '小明',
    content: '帮我看看',
    ts: 1_700_000_000_000,
    raw: {},
    ...overrides,
  };
}

/** 造一条单聊消息（会话键 `c2c:USER-1`）。 */
function makeC2CMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    kind: 'c2c-message',
    target: c2cTarget('USER-1'),
    eventId: 'EVENT-C2C-1',
    msgId: 'MSG-C2C-1',
    senderId: 'USER-1',
    content: '在吗',
    ts: 1_700_000_000_000,
    raw: {},
    ...overrides,
  };
}

/**
 * 等 dispatch 完成：completeTurn 之后派发链还需要若干宏任务才收敛。
 * 轮询比固定 sleep 更稳。
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor 超时');
}

// ---------------------------------------------------------------------------

let ctx: ReturnType<typeof setup>;
afterEach(() => ctx?.cleanup());

describe('Dispatcher 正常一轮', () => {
  beforeEach(() => {
    ctx = setup();
  });

  it('回复的是最后一条非空 assistant 文本，而不是中间那句', async () => {
    const message = makeMessage();
    const pending = ctx.dispatcher.handleEvent(message);
    await waitFor(() => ctx.runtime.prompts.length === 1);

    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['我先看看', '', '结论是 42']);
    await pending;

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.body.content).toBe('结论是 42');
    expect(ctx.sent[0]!.body.msg_id).toBe('MSG-1');
    expect(ctx.sent[0]!.body.msg_seq).toBe(1);
    expect(ctx.sent[0]!.target).toEqual(groupTarget('GROUP-1'));
  });

  it('把用户消息与助手回复都写进对话记录', async () => {
    const pending = ctx.dispatcher.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['答案']);
    await pending;

    const turns = ctx.conversations.readAll('GROUP-1');
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ['user', '帮我看看'],
      ['assistant', '答案'],
    ]);
  });

  it('prompt 里带上提问者与内容', async () => {
    const pending = ctx.dispatcher.handleEvent(makeMessage({ username: '张三', content: '写个脚本' }));
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好']);
    await pending;

    expect(ctx.runtime.prompts[0]!.text).toContain('张三');
    expect(ctx.runtime.prompts[0]!.text).toContain('写个脚本');
  });

  it('turn 结束后池被 release', async () => {
    const pending = ctx.dispatcher.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['ok']);
    await pending;

    expect(ctx.pool.release).toHaveBeenCalledWith('GROUP-1');
  });
});

describe('Dispatcher 去重与并发', () => {
  beforeEach(() => {
    ctx = setup();
  });

  it('相同 eventId 重复投递只处理一次', async () => {
    const pending = ctx.dispatcher.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['答案']);
    await pending;

    // 重放同一个事件
    await ctx.dispatcher.handleEvent(makeMessage());

    expect(ctx.runtime.prompts).toHaveLength(1);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.dispatcher.snapshotStats().deduplicated).toBe(1);
  });

  it('eventId 为空时回退用 msgId 去重', async () => {
    const pending = ctx.dispatcher.handleEvent(makeMessage({ eventId: '' }));
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['答案']);
    await pending;

    await ctx.dispatcher.handleEvent(makeMessage({ eventId: '' }));
    expect(ctx.runtime.prompts).toHaveLength(1);
  });
});

describe('Dispatcher 超时与错误', () => {
  it('超时后给出交代，并回收 runtime 以终止任务', async () => {
    ctx = setup({ configOverrides: { QQ_TURN_TIMEOUT_MS: '8000', QQ_PROGRESS_AFTER_MS: '3000' } });
    const pending = ctx.dispatcher.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);

    // 只发一部分内容，然后不再有任何事件 → 触发超时
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.emitStatus(sessionId, 'running');
    ctx.runtime.emitEvent(sessionId, {
      type: 'assistant/message',
      seq: 1,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '做到一半' }] } },
    });

    await pending;

    const finalMessage = ctx.sent.find(
      (s) => (s.body.content ?? '').includes('时限') || (s.body.content ?? '').includes('超时'),
    );
    expect(finalMessage).toBeDefined();
    expect(finalMessage!.body.content).toContain('做到一半');
    expect(ctx.pool.drop).toHaveBeenCalledWith('GROUP-1');
    expect(ctx.dispatcher.snapshotStats().timedOut).toBe(1);
  });

  it('turn/end 为 error 时把错误信息告知用户', async () => {
    ctx = setup();
    const pending = ctx.dispatcher.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;

    ctx.runtime.emitStatus(sessionId, 'running');
    ctx.runtime.emitEvent(sessionId, {
      type: 'turn/end',
      seq: 9,
      data: { turn: 1, reason: { kind: 'error', error: { message: '模型不可用' } } },
    });
    ctx.runtime.emitStatus(sessionId, 'idle');
    await pending;

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.body.content).toContain('模型不可用');
  });

  it('max-tokens 时提示内容被截断', async () => {
    ctx = setup();
    const pending = ctx.dispatcher.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['很长的回答'], { kind: 'max-tokens' });
    await pending;

    expect(ctx.sent[0]!.body.content).toContain('长度上限');
  });
});

describe('Dispatcher 分段与配额', () => {
  it('长回答按配额分段，msg_seq 单调递增且不超过总额配', async () => {
    ctx = setup({ configOverrides: { QQ_MAX_CHARS: '100', QQ_MAX_REPLIES_PER_MSG: '3', QQ_PROGRESS_MAX: '1' } });
    const pending = ctx.dispatcher.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;

    // 三段各 80 字符，共 240 → 需要 3 段
    ctx.runtime.completeTurn(sessionId, [
      ['A'.repeat(80), 'B'.repeat(80), 'C'.repeat(80)].join('\n\n'),
    ]);
    await pending;

    expect(ctx.sent.length).toBeGreaterThan(1);
    expect(ctx.sent.length).toBeLessThanOrEqual(3);
    const sequences = ctx.sent.map((s) => s.body.msg_seq!);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    // 每段不超过上限
    for (const s of ctx.sent) {
      expect((s.body.content ?? '').length).toBeLessThanOrEqual(100);
    }
  });

  it('内容超过配额时最后一段带截断提示，且回复总数不超过总额配', async () => {
    ctx = setup({ configOverrides: { QQ_MAX_CHARS: '100', QQ_MAX_REPLIES_PER_MSG: '2', QQ_PROGRESS_MAX: '1' } });
    const pending = ctx.dispatcher.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;

    ctx.runtime.completeTurn(sessionId, ['X'.repeat(1000)]);
    await pending;

    expect(ctx.sent.length).toBeLessThanOrEqual(2);
    const last = ctx.sent[ctx.sent.length - 1]!;
    expect(last.body.content).toContain('已截断');
    expect((last.body.content ?? '').length).toBeLessThanOrEqual(100);
  });
});

describe('Dispatcher 冷启动回放', () => {
  it('首次为某群建会话时把历史并入 prompt', async () => {
    ctx = setup();
    // 预置历史记录
    ctx.conversations.append('GROUP-1', { role: 'user', speaker: '老王', text: '之前我们聊过部署', ts: 1 });
    ctx.conversations.append('GROUP-1', { role: 'assistant', speaker: 'bot', text: '是的，用 docker compose', ts: 2 });

    const pending = ctx.dispatcher.handleEvent(makeMessage({ content: '继续上次那个话题' }));
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好']);
    await pending;

    const prompt = ctx.runtime.prompts[0]!.text;
    expect(prompt).toContain('<历史对话');
    expect(prompt).toContain('之前我们聊过部署');
    expect(prompt).toContain('是的，用 docker compose');
    // 当前提问不能重复出现在历史里
    expect(prompt.match(/继续上次那个话题/g)?.length).toBe(1);
  });

  it('QQ_REPLAY_TURNS=0 时不回放', async () => {
    ctx = setup({ configOverrides: { QQ_REPLAY_TURNS: '0' } });
    ctx.conversations.append('GROUP-1', { role: 'user', speaker: '老王', text: '很久以前的话', ts: 1 });

    const pending = ctx.dispatcher.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['ok']);
    await pending;

    expect(ctx.runtime.prompts[0]!.text).not.toContain('很久以前的话');
  });
});

describe('Dispatcher 进群/加好友欢迎', () => {
  it('群进群事件用 event_id 而非 msg_id 回复（平台要求二者互斥）', async () => {
    ctx = setup();
    await ctx.dispatcher.handleEvent({
      kind: 'group-add-robot',
      at: 1,
      target: groupTarget('GROUP-1'),
      eventId: 'EVENT-ADD',
      raw: {},
    });

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.target).toEqual(groupTarget('GROUP-1'));
    expect(ctx.sent[0]!.body.event_id).toBe('EVENT-ADD');
    expect(ctx.sent[0]!.body.msg_id).toBeUndefined();
    expect(ctx.sent[0]!.body.msg_seq).toBe(1);
  });

  it('单聊加好友走 sendUserMessage，并用 event_id 回复', async () => {
    ctx = setup();
    await ctx.dispatcher.handleEvent({
      kind: 'c2c-friend-add',
      at: 1,
      target: c2cTarget('USER-1'),
      eventId: 'EVENT-FRIEND',
      raw: {},
    });

    expect(ctx.api.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.target).toEqual(c2cTarget('USER-1'));
    expect(ctx.sent[0]!.body.event_id).toBe('EVENT-FRIEND');
    expect(ctx.sent[0]!.body.msg_id).toBeUndefined();
  });

  it('缺少 eventId 时不崩（只记日志）', async () => {
    ctx = setup();
    await ctx.dispatcher.handleEvent({
      kind: 'group-add-robot',
      at: 1,
      target: groupTarget('GROUP-1'),
      raw: {},
    });
    // 没有 event_id 也没有 msg_id 的请求会被发出，但不应抛错
    expect(ctx.sent.length).toBeLessThanOrEqual(1);
  });

  it('单聊被禁用时不发欢迎语', async () => {
    ctx = setup({ configOverrides: { QQ_C2C_ENABLED: 'false' } });
    await ctx.dispatcher.handleEvent({
      kind: 'c2c-friend-add',
      at: 1,
      target: c2cTarget('USER-1'),
      eventId: 'EVENT-FRIEND',
      raw: {},
    });
    expect(ctx.sent).toHaveLength(0);
  });
});

describe('Dispatcher 单聊', () => {
  it('单聊消息走 sendUserMessage，并落到 c2c: 会话键下', async () => {
    ctx = setup();
    const pending = ctx.dispatcher.handleEvent(makeC2CMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);

    const sessionId = ctx.sessions.peek('c2c:USER-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['在的']);
    await pending;

    expect(ctx.api.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(ctx.api.sendGroupMessage).not.toHaveBeenCalled();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.target).toEqual(c2cTarget('USER-1'));
    expect(ctx.sent[0]!.body.content).toBe('在的');
    expect(ctx.sent[0]!.body.msg_id).toBe('MSG-C2C-1');
    expect(ctx.sent[0]!.body.msg_seq).toBe(1);
    // prompt 里标明渠道与发送者，避免模型把群/私聊身份混起来
    expect(ctx.runtime.prompts[0]!.text).toContain('私聊用户');
    expect(ctx.runtime.prompts[0]!.text).toContain('USER-1');
    // 对话记录落在单聊自己的会话键下
    expect(ctx.conversations.readAll('c2c:USER-1').map((t) => t.text)).toEqual(['在吗', '在的']);
  });

  it('单聊使用自己的回复配额（默认 4 条，而不是群聊的 5 条）', async () => {
    ctx = setup({
      configOverrides: {
        QQ_C2C_MAX_REPLIES_PER_MSG: '2',
        QQ_C2C_PROGRESS_MAX: '0',
        QQ_MAX_CHARS: '100',
      },
    });
    const pending = ctx.dispatcher.handleEvent(makeC2CMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('c2c:USER-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['X'.repeat(1000)]);
    await pending;

    expect(ctx.sent.length).toBeLessThanOrEqual(2);
    const sequences = ctx.sent.map((s) => s.body.msg_seq!);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('QQ_C2C_ENABLED=false 时单聊消息被忽略（不回复、不进 runtime）', async () => {
    ctx = setup({ configOverrides: { QQ_C2C_ENABLED: 'false' } });
    await ctx.dispatcher.handleEvent(makeC2CMessage());

    expect(ctx.sent).toHaveLength(0);
    expect(ctx.runtime.prompts).toHaveLength(0);
    expect(ctx.api.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.dispatcher.snapshotStats().skippedC2C).toBe(1);
  });

  it('群聊与单聊的 openid 即使字面相同也不会串成一个会话', () => {
    expect(groupTarget('SAME').key).toBe('SAME');
    expect(c2cTarget('SAME').key).toBe('c2c:SAME');
    expect(groupTarget('SAME').key).not.toBe(c2cTarget('SAME').key);
  });
});

describe('Dispatcher 统计', () => {
  beforeEach(() => {
    ctx = setup();
  });

  it('统计各计数并暴露 inFlight', async () => {
    const pending = ctx.dispatcher.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['ok']);
    await pending;

    const stats = ctx.dispatcher.snapshotStats();
    expect(stats.received).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.repliesSent).toBe(1);
    expect(stats.inFlight).toBe(0);
  });
});
