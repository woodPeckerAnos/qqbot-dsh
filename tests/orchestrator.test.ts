/**
 * 编排层集成单测（假 runtime + 假 QQ API，全离线）。
 * 被测对象是 Orchestrator（Ingress 管线 + TurnRunner + Responder 的组装门面）。
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
import type { SessionEventNotification, PromptContentBlock } from '../src/dsh/protocol.js';
import { CN_HOLIDAYS_2026, OffpeakGate } from '../src/offpeak/index.js';
import { Responder } from '../src/pipeline/egress/responder.js';
import { AdmissionGate } from '../src/pipeline/ingress/admission.js';
import { createDedupeStage } from '../src/pipeline/ingress/dedupe.js';
import { OffpeakCommandRouter } from '../src/pipeline/ingress/offpeak-command.js';
import { createOffpeakGateStage } from '../src/pipeline/ingress/offpeak-gate.js';
import { createRecordStage } from '../src/pipeline/ingress/record.js';
import type { IngressStage } from '../src/pipeline/ingress/types.js';
import { Orchestrator } from '../src/pipeline/orchestrator.js';
import { PipelineStats } from '../src/pipeline/stats.js';
import { TurnRunner } from '../src/pipeline/turn-runner.js';
import { ConversationStore } from '../src/store/conversations.js';
import { ensureStoreDirs, resolveStorePaths } from '../src/store/paths.js';
import { SeenStore } from '../src/store/seen.js';
import { SessionStore } from '../src/store/sessions.js';
import type { SendMessageRequest } from '../src/adapters/qq-official/types.js';
import { c2cTarget, groupTarget } from '../src/adapters/qq-official/gateway.js';
import { renderMessage } from '../src/adapters/qq-official/render.js';
import type {
  BotConnector,
  ConversationTarget,
  NormalizedMessage,
  ReplyContext,
  ReplyPolicy,
} from '../src/core/connector.js';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 8 字节 PNG 魔数：体积无关紧要，只要能被嗅探成 image/png。 */
const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 假的 runtime：记录 prompt（content blocks），允许测试手动注入事件与状态。 */
class FakeRuntime {
  readonly prompts: Array<{ sessionId: string; text: string; blocks: PromptContentBlock[] }> = [];
  /** 模拟 runtime 附件准入拒绝（像素/字节超限）——用于验证纯文本回退 */
  rejectImagePrompts = false;
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

  async prompt(sessionId: string, blocks: PromptContentBlock[]): Promise<{ messageId: string }> {
    // text 只取文本块（图片块的 base64 不参与断言）；blocks 原样保留供多模态断言
    const text = blocks
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    // 先记录再判拒绝：被拒绝的那次尝试也要留在 prompts 里，测试才能断言"重试过"
    this.prompts.push({ sessionId, text, blocks });
    if (this.rejectImagePrompts && blocks.some((block) => block.type === 'image')) {
      throw new Error('Image exceeds the configured decoded-pixel limit.');
    }
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
          activeChildren: new Set<string>(),
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
  /** 发往哪个会话 */
  target: ConversationTarget;
  body: SendMessageRequest;
}

/**
 * 假连接器：reply 走真实的 renderMessage（保证 msg_seq/msg_id 互斥等行为
 * 与线上一致），但不发网络请求，只记录到 sent。
 * policy 与 main.ts 的映射保持一致，让 QQ_* 配置项在测试里照常生效。
 */
function createFakeConnector(config: Config, sent: SentMessage[]): BotConnector & {
  reply: ReturnType<typeof vi.fn>;
} {
  const groupPolicy: ReplyPolicy = {
    maxChars: config.qq.maxChars,
    maxRepliesPerMsg: config.qq.maxRepliesPerMsg,
    progressMax: config.qq.progressMax,
    progressAfterMs: config.qq.progressAfterMs,
    progressIntervalMs: config.qq.progressIntervalMs,
    turnTimeoutMs: config.qq.turnTimeoutMs,
  };
  const c2cPolicy: ReplyPolicy = {
    maxChars: config.qq.maxChars,
    maxRepliesPerMsg: config.qq.c2c.maxRepliesPerMsg,
    progressMax: config.qq.c2c.progressMax,
    progressAfterMs: config.qq.progressAfterMs,
    progressIntervalMs: config.qq.progressIntervalMs,
    turnTimeoutMs: config.qq.turnTimeoutMs,
  };
  return {
    platform: 'qq-official',
    acceptsC2C: config.qq.c2c.enabled,
    on: vi.fn(() => () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    health: vi.fn(() => ({ connected: true, state: 'ready' })),
    policy: vi.fn((kind: 'group' | 'c2c') => (kind === 'c2c' ? c2cPolicy : groupPolicy)),
    reply: vi.fn(async (ctx: ReplyContext, out: { text: string }) => {
      const body = renderMessage(out.text, {
        msgType: config.qq.msgType,
        msgSeq: ctx.seq,
        msgId: ctx.msgId,
        eventId: ctx.eventId,
      });
      sent.push({ target: ctx.target, body });
    }),
    // 多模态：替身取字节，避免测试触网
    fetchMedia: vi.fn(async () => ({ data: FAKE_PNG, mimeType: 'image/png' })),
  };
}

function setup(options: { configOverrides?: Record<string, string>; now?: () => number } = {}) {
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
  const connector = createFakeConnector(config, sent);
  const connectors = new Map<string, BotConnector>([[connector.platform, connector]]);

  const conversations = new ConversationStore(paths, logger);
  const seen = new SeenStore({ paths, logger });
  const sessions = new SessionStore({ paths, logger });

  // 组装方式与 main.ts 保持一致（显式构造每个 stage / 闸门 / 服务）。
  // 这里故意不抽公共工厂：组装就是业务逻辑，测试要验证的正是这套真实接线。
  const stats = new PipelineStats();
  const offpeak = new OffpeakGate({
    defaults: {
      enabled: config.offpeak.enabled,
      windows: config.offpeak.windows,
      timeZone: config.offpeak.timeZone,
      modelPattern: config.offpeak.modelPattern,
      weekendsAllDay: config.offpeak.weekendsAllDay,
      holidays: new Set([...CN_HOLIDAYS_2026, ...config.offpeak.holidays]),
    },
    filePath: join(paths.stateDir, 'offpeak-override.json'),
    logger,
    now: options.now,
  });
  const admission = new AdmissionGate({
    maxConcurrentTurns: config.pool.maxConcurrentTurns,
    stats,
  });
  const turnRunner = new TurnRunner({
    config,
    logger,
    pool,
    conversations,
    sessions,
    paths,
    stats,
    now: options.now,
  });
  const offpeakCommands = new OffpeakCommandRouter({ gate: offpeak, config, stats, now: options.now });
  const stages: IngressStage[] = [
    createDedupeStage({ seen, stats }),
    offpeakCommands.stage(),
    createOffpeakGateStage({ gate: offpeak, config, stats, now: options.now }),
    createRecordStage({ conversations }),
    admission.stage(),
  ];
  const orchestrator = new Orchestrator({
    logger,
    connectors,
    admins: config.admins,
    stats,
    stages,
    terminal: (ctx) => turnRunner.runTurn(ctx),
    createResponder: (message, conn, policy, messageLogger) =>
      new Responder({
        message,
        connector: conn,
        policy,
        conversations,
        stats,
        logger: messageLogger,
        now: options.now,
      }),
    turns: turnRunner,
    status: () => ({
      inFlight: admission.inUse,
      queued: admission.queued,
      offpeak: offpeak.snapshot(),
    }),
  });

  // 接线：真实实现里 main.ts 把 pool 的事件转给 orchestrator。
  // 这里的假池 on() 只是 spy，所以直接订阅假 runtime 的事件。
  runtime.on('session.event', (n: SessionEventNotification) => {
    const conversationKey = conversationKeyOf(n.sessionId, sessions);
    orchestrator.routeSessionEvent(conversationKey, n);
  });
  runtime.on('session.status', (n: { sessionId: string; status: 'idle' | 'running' }) => {
    const conversationKey = conversationKeyOf(n.sessionId, sessions);
    orchestrator.routeSessionStatus(conversationKey, n);
  });

  return {
    root,
    paths,
    config,
    orchestrator,
    runtime,
    pool,
    connector,
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

describe('编排 正常一轮', () => {
  beforeEach(() => {
    ctx = setup();
  });

  it('回复的是最后一条非空 assistant 文本，而不是中间那句', async () => {
    const message = makeMessage();
    const pending = ctx.orchestrator.handleEvent(message);
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
    const pending = ctx.orchestrator.handleEvent(makeMessage());
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
    const pending = ctx.orchestrator.handleEvent(makeMessage({ username: '张三', content: '写个脚本' }));
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好']);
    await pending;

    expect(ctx.runtime.prompts[0]!.text).toContain('张三');
    expect(ctx.runtime.prompts[0]!.text).toContain('写个脚本');
  });

  it('turn 结束后池被 release', async () => {
    const pending = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['ok']);
    await pending;

    expect(ctx.pool.release).toHaveBeenCalledWith('GROUP-1');
  });
});

describe('编排 去重与并发', () => {
  beforeEach(() => {
    ctx = setup();
  });

  it('相同 eventId 重复投递只处理一次', async () => {
    const pending = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['答案']);
    await pending;

    // 重放同一个事件
    await ctx.orchestrator.handleEvent(makeMessage());

    expect(ctx.runtime.prompts).toHaveLength(1);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.orchestrator.snapshotStats().deduplicated).toBe(1);
  });

  it('eventId 为空时回退用 msgId 去重', async () => {
    const pending = ctx.orchestrator.handleEvent(makeMessage({ eventId: '' }));
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['答案']);
    await pending;

    await ctx.orchestrator.handleEvent(makeMessage({ eventId: '' }));
    expect(ctx.runtime.prompts).toHaveLength(1);
  });
});

describe('编排 超时与错误', () => {
  it('超时后给出交代，并回收 runtime 以终止任务', async () => {
    ctx = setup({ configOverrides: { QQ_TURN_TIMEOUT_MS: '8000', QQ_PROGRESS_AFTER_MS: '3000' } });
    const pending = ctx.orchestrator.handleEvent(makeMessage());
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
    expect(ctx.orchestrator.snapshotStats().timedOut).toBe(1);
  });

  it('turn/end 为 error 时把错误信息告知用户', async () => {
    ctx = setup();
    const pending = ctx.orchestrator.handleEvent(makeMessage());
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
    const pending = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['很长的回答'], { kind: 'max-tokens' });
    await pending;

    expect(ctx.sent[0]!.body.content).toContain('长度上限');
  });
});

describe('编排 分段与配额', () => {
  it('长回答按配额分段，msg_seq 单调递增且不超过总额配', async () => {
    ctx = setup({ configOverrides: { QQ_MAX_CHARS: '100', QQ_MAX_REPLIES_PER_MSG: '3', QQ_PROGRESS_MAX: '1' } });
    const pending = ctx.orchestrator.handleEvent(makeMessage());
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
    const pending = ctx.orchestrator.handleEvent(makeMessage());
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

describe('编排 冷启动回放', () => {
  it('首次为某群建会话时把历史并入 prompt', async () => {
    ctx = setup();
    // 预置历史记录
    ctx.conversations.append('GROUP-1', { role: 'user', speaker: '老王', text: '之前我们聊过部署', ts: 1 });
    ctx.conversations.append('GROUP-1', { role: 'assistant', speaker: 'bot', text: '是的，用 docker compose', ts: 2 });

    const pending = ctx.orchestrator.handleEvent(makeMessage({ content: '继续上次那个话题' }));
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

    const pending = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['ok']);
    await pending;

    expect(ctx.runtime.prompts[0]!.text).not.toContain('很久以前的话');
  });
});

describe('编排 进群/加好友欢迎', () => {
  it('群进群事件用 event_id 而非 msg_id 回复（平台要求二者互斥）', async () => {
    ctx = setup();
    await ctx.orchestrator.handleEvent({
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
    await ctx.orchestrator.handleEvent({
      kind: 'c2c-friend-add',
      at: 1,
      target: c2cTarget('USER-1'),
      eventId: 'EVENT-FRIEND',
      raw: {},
    });

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.target).toEqual(c2cTarget('USER-1'));
    expect(ctx.sent[0]!.body.event_id).toBe('EVENT-FRIEND');
    expect(ctx.sent[0]!.body.msg_id).toBeUndefined();
  });

  it('缺少 eventId 时不崩（只记日志）', async () => {
    ctx = setup();
    await ctx.orchestrator.handleEvent({
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
    await ctx.orchestrator.handleEvent({
      kind: 'c2c-friend-add',
      at: 1,
      target: c2cTarget('USER-1'),
      eventId: 'EVENT-FRIEND',
      raw: {},
    });
    expect(ctx.sent).toHaveLength(0);
  });
});

describe('编排 单聊', () => {
  it('单聊消息走 sendUserMessage，并落到 c2c: 会话键下', async () => {
    ctx = setup();
    const pending = ctx.orchestrator.handleEvent(makeC2CMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);

    const sessionId = ctx.sessions.peek('c2c:USER-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['在的']);
    await pending;

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
    const pending = ctx.orchestrator.handleEvent(makeC2CMessage());
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
    await ctx.orchestrator.handleEvent(makeC2CMessage());

    expect(ctx.sent).toHaveLength(0);
    expect(ctx.runtime.prompts).toHaveLength(0);
    expect(ctx.connector.reply).not.toHaveBeenCalled();
    expect(ctx.orchestrator.snapshotStats().skippedC2C).toBe(1);
  });

  it('群聊与单聊的 openid 即使字面相同也不会串成一个会话', () => {
    expect(groupTarget('SAME').key).toBe('SAME');
    expect(c2cTarget('SAME').key).toBe('c2c:SAME');
    expect(groupTarget('SAME').key).not.toBe(c2cTarget('SAME').key);
  });
});

describe('编排 统计', () => {
  beforeEach(() => {
    ctx = setup();
  });

  it('统计各计数并暴露 inFlight', async () => {
    const pending = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['ok']);
    await pending;

    const stats = ctx.orchestrator.snapshotStats();
    expect(stats.received).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.repliesSent).toBe(1);
    expect(stats.inFlight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 谷时段闸（DeepSeek 正价时段不调用 API）
// ---------------------------------------------------------------------------

// 固定时间戳：Asia/Shanghai 的 12:00（正价）与 02:00（谷内）
const SHANGHAI_NOON = Date.UTC(2026, 0, 15, 4, 0);
const SHANGHAI_2AM = Date.UTC(2026, 0, 14, 18, 0);

const OFFPEAK_ON = {
  QQ_OFFPEAK_ENABLED: 'true',
  // 单窗口 00:30–08:30：这样 12:00 就是正价时段，用例可以拿同一个时间戳验证"拦/放"两侧
  QQ_OFFPEAK_WINDOWS: '00:30-08:30',
  QQ_OFFPEAK_TZ: 'Asia/Shanghai',
};

describe('谷时段闸', () => {
  it('峰时段拦截：直接回复提示，不派发给 runtime、不写对话记录', async () => {
    ctx = setup({ configOverrides: OFFPEAK_ON, now: () => SHANGHAI_NOON });
    await ctx.orchestrator.handleEvent(makeMessage());

    expect(ctx.runtime.prompts).toHaveLength(0);
    expect(ctx.sent).toHaveLength(1);
    const body = ctx.sent[0]!.body;
    expect(body.content).toContain('正价时段');
    expect(body.content).toContain('00:30–08:30');
    expect(ctx.conversations.readTail('GROUP-1', 10)).toHaveLength(0);
    expect(ctx.orchestrator.snapshotStats().gatedOffpeak).toBe(1);
  });

  it('谷时段内正常处理', async () => {
    ctx = setup({ configOverrides: OFFPEAK_ON, now: () => SHANGHAI_2AM });
    const pending = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好']);
    await pending;

    expect(ctx.sent.at(-1)!.body.content).toBe('好');
    expect(ctx.orchestrator.snapshotStats().gatedOffpeak).toBe(0);
  });

  it('默认关闭：不配 QQ_OFFPEAK_ENABLED 时峰时段也正常处理（不影响既有部署）', async () => {
    ctx = setup({ now: () => SHANGHAI_NOON });
    const pending = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好']);
    await pending;

    expect(ctx.runtime.prompts).toHaveLength(1);
  });

  it('模型不匹配时不拦（换成非 DeepSeek 模型后峰时段也放行）', async () => {
    ctx = setup({
      configOverrides: { ...OFFPEAK_ON, DSH_PROVIDER: 'other-provider', DSH_MODEL: 'some-other-model' },
      now: () => SHANGHAI_NOON,
    });
    const pending = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好']);
    await pending;

    expect(ctx.runtime.prompts).toHaveLength(1);
  });

  it('管理员任何时段都不被拦', async () => {
    ctx = setup({
      configOverrides: { ...OFFPEAK_ON, QQ_ADMIN_OPENIDS: 'MEMBER-1' },
      now: () => SHANGHAI_NOON,
    });
    const pending = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好']);
    await pending;

    expect(ctx.runtime.prompts).toHaveLength(1);
    expect(ctx.orchestrator.snapshotStats().gatedOffpeak).toBe(0);
  });
});

describe('谷时段闸（周末与法定节假日）', () => {
  it('周六全天谷价：周末中午正常处理（DeepSeek 2026-08-23 起规则）', async () => {
    // 2026-01-17 是周六
    ctx = setup({ configOverrides: OFFPEAK_ON, now: () => Date.UTC(2026, 0, 17, 4, 0) });
    const pending = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好']);
    await pending;

    expect(ctx.runtime.prompts).toHaveLength(1);
    expect(ctx.orchestrator.snapshotStats().gatedOffpeak).toBe(0);
  });

  it('法定节假日全天谷价：国庆中午正常处理（内置官方日历，2026-10-01 周四）', async () => {
    ctx = setup({ configOverrides: OFFPEAK_ON, now: () => Date.UTC(2026, 9, 1, 4, 0) });
    const pending = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好']);
    await pending;

    expect(ctx.runtime.prompts).toHaveLength(1);
    expect(ctx.orchestrator.snapshotStats().gatedOffpeak).toBe(0);
  });

  it('管理员 /offpeak holiday add 追加日期后，该日中午立即放行（跨年数据维护路径）', async () => {
    // 2026-01-15 周四中午：默认被拦
    ctx = setup({
      configOverrides: { ...OFFPEAK_ON, QQ_ADMIN_OPENIDS: 'MEMBER-1' },
      now: () => SHANGHAI_NOON,
    });
    await ctx.orchestrator.handleEvent(makeMessage({ content: '/offpeak holiday add 2026-01-15' }));
    expect(ctx.sent.at(-1)!.body.content).toContain('已追加');

    const pending = ctx.orchestrator.handleEvent(
      makeMessage({ eventId: 'EVENT-2', msgId: 'MSG-2', senderId: 'SOMEBODY' }),
    );
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好']);
    await pending;

    expect(ctx.runtime.prompts).toHaveLength(1);
  });

  it('/offpeak holiday list 对所有人开放，列出官方节假日', async () => {
    ctx = setup({ configOverrides: OFFPEAK_ON, now: () => SHANGHAI_NOON });
    await ctx.orchestrator.handleEvent(makeMessage({ content: '/offpeak holiday list' }));
    const text = ctx.sent.map((item) => item.body.content ?? '').join('\n');
    expect(text).toContain('2026-10-01');
    expect(ctx.runtime.prompts).toHaveLength(0);
  });
});

describe('/offpeak 命令', () => {
  it('非管理员变更配置被拒绝，闸保持拦截', async () => {
    ctx = setup({
      configOverrides: { ...OFFPEAK_ON, QQ_ADMIN_OPENIDS: 'SOMEONE-ELSE' },
      now: () => SHANGHAI_NOON,
    });
    await ctx.orchestrator.handleEvent(makeMessage({ content: '/offpeak off' }));
    expect(ctx.sent.at(-1)!.body.content).toContain('无权限');
    expect(ctx.runtime.prompts).toHaveLength(0);

    // 闸仍然生效
    await ctx.orchestrator.handleEvent(makeMessage({ eventId: 'EVENT-2', msgId: 'MSG-2' }));
    expect(ctx.sent.at(-1)!.body.content).toContain('正价时段');
    expect(ctx.runtime.prompts).toHaveLength(0);
  });

  it('管理员 /offpeak off 热切换后，下一条消息立即放行，且覆盖持久化', async () => {
    ctx = setup({
      configOverrides: { ...OFFPEAK_ON, QQ_ADMIN_OPENIDS: 'MEMBER-1' },
      now: () => SHANGHAI_NOON,
    });
    await ctx.orchestrator.handleEvent(makeMessage({ content: '/offpeak off' }));
    expect(ctx.sent.at(-1)!.body.content).toContain('已关闭');
    expect(ctx.runtime.prompts).toHaveLength(0);

    // 下一条普通消息立即放行（热切换，无需重启）
    const pending = ctx.orchestrator.handleEvent(
      makeMessage({ eventId: 'EVENT-2', msgId: 'MSG-2', senderId: 'SOMEBODY' }),
    );
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好']);
    await pending;

    // 覆盖已持久化到 stateDir
    const { readFileSync } = await import('node:fs');
    const file = JSON.parse(
      readFileSync(join(ctx.paths.stateDir, 'offpeak-override.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(file['enabled']).toBe(false);
  });

  it('管理员 /offpeak on 热开启后恢复拦截', async () => {
    ctx = setup({
      configOverrides: { ...OFFPEAK_ON, QQ_OFFPEAK_ENABLED: 'false', QQ_ADMIN_OPENIDS: 'MEMBER-1' },
      now: () => SHANGHAI_NOON,
    });
    await ctx.orchestrator.handleEvent(makeMessage({ content: '/offpeak on' }));
    expect(ctx.sent.at(-1)!.body.content).toContain('已开启');

    await ctx.orchestrator.handleEvent(
      makeMessage({ eventId: 'EVENT-2', msgId: 'MSG-2', senderId: 'SOMEBODY' }),
    );
    expect(ctx.sent.at(-1)!.body.content).toContain('正价时段');
    expect(ctx.runtime.prompts).toHaveLength(0);
  });

  it('/offpeak status 对非管理员开放，不进 runtime、不写对话记录', async () => {
    ctx = setup({ configOverrides: OFFPEAK_ON, now: () => SHANGHAI_NOON });
    await ctx.orchestrator.handleEvent(makeMessage({ content: '/offpeak status' }));

    const text = ctx.sent.map((item) => item.body.content ?? '').join('\n');
    expect(text).toContain('谷时段闸：开启');
    expect(text).toContain('拦截中');
    expect(ctx.runtime.prompts).toHaveLength(0);
    expect(ctx.conversations.readTail('GROUP-1', 10)).toHaveLength(0);
  });

  it('/offpeak whoami 回senderId（管理员自助发现 openid 的入口）', async () => {
    ctx = setup({ configOverrides: OFFPEAK_ON, now: () => SHANGHAI_NOON });
    await ctx.orchestrator.handleEvent(makeMessage({ content: '/offpeak whoami' }));
    expect(ctx.sent.at(-1)!.body.content).toContain('MEMBER-1');
  });

  it('/offpeak window 参数非法时回复错误，不改变配置', async () => {
    ctx = setup({
      configOverrides: { ...OFFPEAK_ON, QQ_ADMIN_OPENIDS: 'MEMBER-1' },
      now: () => SHANGHAI_NOON,
    });
    await ctx.orchestrator.handleEvent(makeMessage({ content: '/offpeak window 25:00-26:00' }));
    expect(ctx.sent.at(-1)!.body.content).toContain('设置失败');

    // 重叠窗口同样被拒
    await ctx.orchestrator.handleEvent(
      makeMessage({
        eventId: 'EVENT-OVERLAP',
        msgId: 'MSG-OVERLAP',
        content: '/offpeak window 00:00-09:00,08:00-12:00',
      }),
    );
    expect(ctx.sent.at(-1)!.body.content).toContain('重叠');

    // 配置未被破坏：峰时段仍按原窗口拦截
    await ctx.orchestrator.handleEvent(
      makeMessage({ eventId: 'EVENT-2', msgId: 'MSG-2', senderId: 'SOMEBODY' }),
    );
    expect(ctx.sent.at(-1)!.body.content).toContain('00:30–08:30');
  });

  it('管理员 /offpeak window 可整组换成多窗口，下一条消息按新窗口判定', async () => {
    ctx = setup({
      configOverrides: { ...OFFPEAK_ON, QQ_ADMIN_OPENIDS: 'MEMBER-1' },
      // 12:00 北京：旧窗口（00:30–08:30）下是正价，换到 12:00-14:00 后应变谷时段
      now: () => SHANGHAI_NOON,
    });
    await ctx.orchestrator.handleEvent(
      makeMessage({ content: '/offpeak window 00:00-09:00,12:00-14:00,18:00-24:00' }),
    );
    const reply = ctx.sent.at(-1)!.body.content ?? '';
    expect(reply).toContain('已更新为');
    expect(reply).toContain('00:00–09:00');
    expect(reply).toContain('12:00–14:00');
    expect(reply).toContain('18:00–24:00');

    // 同一个时间戳（12:00）现在应当放行并真的派发给 runtime
    const pending = ctx.orchestrator.handleEvent(
      makeMessage({ eventId: 'EVENT-3', msgId: 'MSG-3', senderId: 'SOMEBODY' }),
    );
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好']);
    await pending;
    expect(ctx.sent.at(-1)!.body.content).toBe('好');
  });

  it('群聊里带 mention 前缀的命令也能识别', async () => {
    ctx = setup({
      configOverrides: { ...OFFPEAK_ON, QQ_ADMIN_OPENIDS: 'MEMBER-1' },
      now: () => SHANGHAI_NOON,
    });
    await ctx.orchestrator.handleEvent(makeMessage({ content: '<@!99999> /offpeak status' }));
    const text = ctx.sent.map((item) => item.body.content ?? '').join('\n');
    expect(text).toContain('谷时段闸');
  });

  it('统计与 /metrics 快照里能看到闸状态', async () => {
    ctx = setup({ configOverrides: OFFPEAK_ON, now: () => SHANGHAI_NOON });
    await ctx.orchestrator.handleEvent(makeMessage());
    const stats = ctx.orchestrator.snapshotStats();
    expect(stats.gatedOffpeak).toBe(1);
    expect(stats.offpeak).toMatchObject({ enabled: true, overridden: false });
  });
});

// ---------------------------------------------------------------------------
// 多模态输入：图片进 prompt content blocks
// ---------------------------------------------------------------------------

describe('多模态输入', () => {
  beforeEach(() => {
    ctx = setup();
  });

  it('消息里的图片被内联成 image block，文字说明留在文本块里', async () => {
    const pending = ctx.orchestrator.handleEvent(
      makeMessage({
        content: '看看这张\n[图片: a.png]',
        parts: [
          { type: 'text', text: '看看这张' },
          { type: 'image', url: 'https://cdn.example.com/a.png', mimeType: 'image/png' },
        ],
      }),
    );
    await waitFor(() => ctx.runtime.prompts.length === 1);

    const blocks = ctx.runtime.prompts[0]!.blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect((blocks[0] as { text: string }).text).toContain('看看这张');
    expect(blocks[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(ctx.orchestrator.snapshotStats().imagesInlined).toBe(1);

    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['这是张风景照']);
    await pending;
    // 对话记录里留的是可读文本形态，冷启动回放不会丢"这条消息里有图"的事实
    const recorded = ctx.conversations.readAll('GROUP-1');
    expect(recorded[0]!.text).toBe('看看这张\n[图片: a.png]');
  });

  it('引用消息被引用方的内容与图片一并送进模型', async () => {
    const pending = ctx.orchestrator.handleEvent(
      makeMessage({
        content: '[引用 小红] 看这个 [图片]\n这张图什么意思',
        parts: [
          {
            type: 'quote',
            author: '小红',
            parts: [
              { type: 'text', text: '看这个' },
              { type: 'image', url: 'https://cdn.example.com/quoted.png' },
            ],
          },
          { type: 'text', text: '这张图什么意思' },
        ],
      }),
    );
    await waitFor(() => ctx.runtime.prompts.length === 1);

    const blocks = ctx.runtime.prompts[0]!.blocks;
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as { text: string }).text).toContain('[引用 小红] 看这个 [图片]');
    expect(blocks[1]).toMatchObject({ type: 'image' });

    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好的']);
    await pending;
  });

  it('关掉富媒体时退回纯文本，并在 prompt 里说明有图未读入', async () => {
    ctx = setup({ configOverrides: { BOT_ATTACHMENT_ENABLED: 'false' } });
    const pending = ctx.orchestrator.handleEvent(
      makeMessage({
        content: '看看这张\n[图片]',
        parts: [
          { type: 'text', text: '看看这张' },
          { type: 'image', url: 'https://cdn.example.com/a.png' },
        ],
      }),
    );
    await waitFor(() => ctx.runtime.prompts.length === 1);

    const blocks = ctx.runtime.prompts[0]!.blocks;
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { text: string }).text).toContain('已关闭图片读取');
    expect(ctx.orchestrator.snapshotStats().imagesSkipped).toBe(1);

    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好的']);
    await pending;
  });

  it('runtime 拒绝图片时退回纯文本重试，文字回答照常送达', async () => {
    ctx.runtime.rejectImagePrompts = true;
    const pending = ctx.orchestrator.handleEvent(
      makeMessage({
        content: '看看这张\n[图片]',
        parts: [
          { type: 'text', text: '看看这张' },
          { type: 'image', url: 'https://cdn.example.com/huge.png' },
        ],
      }),
    );
    // 第一次带图被 runtime 拒绝 → 自动重试为纯文本
    await waitFor(() => ctx.runtime.prompts.length === 2);
    expect(ctx.runtime.prompts[0]!.blocks).toHaveLength(2);
    expect(ctx.runtime.prompts[1]!.blocks).toHaveLength(1);
    expect(ctx.runtime.prompts[1]!.text).toContain('未能被模型接收');

    const stats = ctx.orchestrator.snapshotStats();
    expect(stats.imagesInlined).toBe(0);
    expect(stats.imagesSkipped).toBe(1);

    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['图片没读进来，但文字我看到了']);
    await pending;
    expect(ctx.sent.at(-1)!.body.content).toBe('图片没读进来，但文字我看到了');
  });

  it('只有图片、没有文字的消息也能触发一轮', async () => {
    const pending = ctx.orchestrator.handleEvent(
      makeMessage({
        content: '[图片]',
        parts: [{ type: 'image', url: 'https://cdn.example.com/only.png' }],
      }),
    );
    await waitFor(() => ctx.runtime.prompts.length === 1);
    expect(ctx.runtime.prompts[0]!.blocks).toHaveLength(2);

    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['我看到一张图片']);
    await pending;
    expect(ctx.sent.at(-1)!.body.content).toBe('我看到一张图片');
  });
});

// ---------------------------------------------------------------------------
// 后台子代理桥接：子会话事件过滤（串扰防护）+ 自发轮次收口（结果暂存与带出）
// ---------------------------------------------------------------------------

describe('后台子代理桥接', () => {
  beforeEach(() => {
    ctx = setup();
  });

  it('子会话（后台子代理）的事件不会污染父轮次', async () => {
    const pending = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;

    ctx.runtime.emitStatus(sessionId, 'running');
    // 子会话也在同一个 runtime 进程里跑：它的 assistant 文本、turn/end、idle
    // 都会从同一条 wire 上来。若不过滤，父轮次会被提前"结算"成子代理的文本。
    ctx.runtime.emitEvent('child-session-x', {
      type: 'assistant/message',
      seq: 1,
      data: { message: { content: [{ type: 'text', text: '子代理的中间输出' }] } },
    });
    ctx.runtime.emitEvent('child-session-x', {
      type: 'turn/end',
      seq: 2,
      data: { turn: 1, reason: { kind: 'completed' } },
    });
    ctx.runtime.emitStatus('child-session-x', 'idle');

    // 父轮次此时必须仍未结算，随后给出自己的答案
    ctx.runtime.completeTurn(sessionId, ['父会话的最终答案']);
    await pending;

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.body.content).toBe('父会话的最终答案');
    expect(ctx.orchestrator.snapshotStats().childEventsFiltered).toBeGreaterThan(0);
  });

  it('后台任务完成的自发轮次被捕获，并随下一条回复带出', async () => {
    // 第一轮：建立会话（真实系统里子代理只可能在某个轮次中被派发）
    const first = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['已派发后台任务']);
    await first;
    expect(ctx.sent).toHaveLength(1);

    // 子代理完成 → DSH 唤醒空闲的父代理跑"自发轮次"（没有新的用户消息）
    ctx.runtime.emitStatus(sessionId, 'running');
    ctx.runtime.emitEvent(sessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { message: { content: [{ type: 'text', text: '压缩完成，共处理 42 个文件' }] } },
    });
    ctx.runtime.emitEvent(sessionId, {
      type: 'turn/end',
      seq: 11,
      data: { turn: 2, reason: { kind: 'completed' } },
    });
    ctx.runtime.emitStatus(sessionId, 'idle');

    // 捕获进暂存，不主动发消息（QQ 被动窗口下当时多半发不出去）
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.orchestrator.snapshotStats().backgroundCaptured).toBe(1);

    // 第二轮：用户新消息 → 回复前置带出后台结果
    const second = ctx.orchestrator.handleEvent(
      makeMessage({ eventId: 'EVENT-2', msgId: 'MSG-2', senderId: 'SOMEBODY', content: '跑得怎么样了' }),
    );
    await waitFor(() => ctx.runtime.prompts.length === 2);
    // 假池每次 acquire 都返回 replayed:false → 第二轮会轮换 sessionId，必须重读
    // （真实池只在 runtime 重建后轮换，见 store/sessions.ts）
    const sessionId2 = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId2, ['一切正常']);
    await second;

    const last = ctx.sent.at(-1)!.body.content ?? '';
    expect(last).toContain('【后台任务完成】压缩完成，共处理 42 个文件');
    expect(last).toContain('一切正常');
    const stats = ctx.orchestrator.snapshotStats();
    expect(stats.backgroundCaptured).toBe(1);
    expect(stats.backgroundDelivered).toBe(1);
  });

  it('自发轮次没有产出文本时不暂存、不带出', async () => {
    const first = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId, ['好']);
    await first;

    // 自发轮次只有工具调用没有可见文本
    ctx.runtime.emitStatus(sessionId, 'running');
    ctx.runtime.emitEvent(sessionId, {
      type: 'assistant/message',
      seq: 10,
      data: { message: { content: [{ type: 'text', text: '' }] } },
    });
    ctx.runtime.emitEvent(sessionId, { type: 'turn/end', seq: 11, data: { turn: 2, reason: { kind: 'completed' } } });
    ctx.runtime.emitStatus(sessionId, 'idle');
    expect(ctx.orchestrator.snapshotStats().backgroundCaptured).toBe(0);

    const second = ctx.orchestrator.handleEvent(
      makeMessage({ eventId: 'EVENT-2', msgId: 'MSG-2', senderId: 'SOMEBODY' }),
    );
    await waitFor(() => ctx.runtime.prompts.length === 2);
    // 同上：假池每轮都轮换 sessionId，重读后再驱动
    const sessionId2 = ctx.sessions.peek('GROUP-1')!.currentSessionId;
    ctx.runtime.completeTurn(sessionId2, ['第二轮答案']);
    await second;

    expect(ctx.sent.at(-1)!.body.content).toBe('第二轮答案');
  });

  it('用户轮次进行中时，自发轮次不会与之争抢事件（activeTurns 优先）', async () => {
    const pending = ctx.orchestrator.handleEvent(makeMessage());
    await waitFor(() => ctx.runtime.prompts.length === 1);
    const sessionId = ctx.sessions.peek('GROUP-1')!.currentSessionId;

    // 用户轮次在途时子代理完成：settlement 会被 DSH steer 进当前轮次，
    // 桥上表现为同一个 activeTurns 累积器继续收事件，不产生自发轮次
    ctx.runtime.emitStatus(sessionId, 'running');
    ctx.runtime.emitEvent(sessionId, {
      type: 'assistant/message',
      seq: 1,
      data: { message: { content: [{ type: 'text', text: '顺便说一句：后台任务完成了' }] } },
    });
    ctx.runtime.emitEvent(sessionId, {
      type: 'assistant/message',
      seq: 2,
      data: { message: { content: [{ type: 'text', text: '对你问题的正式回答' }] } },
    });
    ctx.runtime.emitEvent(sessionId, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } });
    ctx.runtime.emitStatus(sessionId, 'idle');
    await pending;

    expect(ctx.sent.at(-1)!.body.content).toBe('对你问题的正式回答');
    expect(ctx.orchestrator.snapshotStats().backgroundCaptured).toBe(0);
  });
});
