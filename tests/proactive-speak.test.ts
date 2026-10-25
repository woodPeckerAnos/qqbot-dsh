/**
 * 主动发言「措辞轮次」单测（`TurnRunner.runProactiveTurn`，全离线）。
 *
 * 被测行为：
 *   1. 正常路径：措辞经真实 agent turn 产出，prompt 里带判定要点与群聊上下文；
 *   2. 并发护栏：会话有用户轮次在跑 → 直接放弃（不排队）；
 *   3. 逃生门：模型看完完整上下文回「不说」→ 不发言；
 *   4. 超时：回收 runtime、返回 undefined（本次不发言）；
 *   5. 抢占：生成中来了用户消息 → 回收 runtime，用户轮次拿到全新 runtime 正常跑；
 *   6. 失控兜底：模型写长文时按硬上限截断。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, type Config } from '../src/config.js';
import type { ConversationTarget, NormalizedMessage, ReplyPolicy } from '../src/core/connector.js';
import type { RuntimeEntry, RuntimePool } from '../src/dsh/pool.js';
import type { PromptContentBlock, SessionEventNotification } from '../src/dsh/protocol.js';
import type { BackgroundPusher } from '../src/pipeline/egress/background.js';
import { Responder } from '../src/pipeline/egress/responder.js';
import type { MessageContext } from '../src/pipeline/ingress/types.js';
import { PipelineStats } from '../src/pipeline/stats.js';
import { TurnRunner } from '../src/pipeline/turn-runner.js';
import { createNullLogger } from '../src/logger.js';
import { ConversationStore } from '../src/store/conversations.js';
import { ensureStoreDirs, resolveStorePaths } from '../src/store/paths.js';
import { SessionStore } from '../src/store/sessions.js';
import { ObservationWindowStore } from '../src/store/window.js';

const GROUP_TARGET: ConversationTarget = {
  platform: 'onebot',
  kind: 'group',
  id: '8888',
  key: 'ob11:g8888',
};

const SPEAK_INPUT = {
  target: GROUP_TARGET,
  scene: 'scene-4' as const,
  directive: '回答 NAS 上跑 docker 的可行性',
  reason: '有人点名问 bot',
};

const POLICY: ReplyPolicy = {
  maxChars: 1000,
  maxRepliesPerMsg: 10,
  progressMax: 2,
  progressAfterMs: 60_000,
  progressIntervalMs: 60_000,
  turnTimeoutMs: 60_000,
  passiveWindowMs: Number.POSITIVE_INFINITY,
};

/** 假的 runtime：记录 prompt，允许测试手动注入事件与状态（与 orchestrator.test.ts 同款）。 */
class FakeRuntime {
  readonly prompts: Array<{ sessionId: string; text: string }> = [];
  ready = true;
  private readonly eventHandlers: Array<(n: SessionEventNotification) => void> = [];
  private readonly statusHandlers: Array<(n: { sessionId: string; status: 'idle' | 'running' }) => void> = [];

  get isReady(): boolean {
    return this.ready;
  }

  on(event: string, handler: (payload: never) => void): void {
    if (event === 'session.event') this.eventHandlers.push(handler as never);
    if (event === 'session.status') this.statusHandlers.push(handler as never);
  }

  async prompt(sessionId: string, blocks: PromptContentBlock[]): Promise<{ messageId: string }> {
    const text = blocks
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    this.prompts.push({ sessionId, text });
    return { messageId: `m-${this.prompts.length}` };
  }

  async dispose(): Promise<void> {
    this.ready = false;
  }

  emitEvent(sessionId: string, event: { type: string; seq: number; data: Record<string, unknown> }): void {
    for (const handler of this.eventHandlers) handler({ sessionId, event });
  }

  emitStatus(sessionId: string, status: 'idle' | 'running'): void {
    for (const handler of this.statusHandlers) handler({ sessionId, status });
  }

  /** 模拟一轮完整回答：running → assistant 文本 → turn/end → idle */
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

function setup(envOverrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-proactive-speak-'));
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
    ...envOverrides,
  });

  const logger = createNullLogger();
  const runtime = new FakeRuntime();
  const entry: RuntimeEntry = {
    conversationKey: GROUP_TARGET.key,
    runtime: runtime as never,
    sessionId: 's-proactive',
    replayed: false,
    createdAt: 0,
    lastUsedAt: 0,
    busy: false,
    activeChildren: new Set<string>(),
  };
  const pool = {
    acquire: vi.fn(async () => entry),
    release: vi.fn(() => {
      entry.busy = false;
    }),
    drop: vi.fn(async () => {}),
  } as unknown as RuntimePool & {
    acquire: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    drop: ReturnType<typeof vi.fn>;
  };

  const stats = new PipelineStats();
  const conversations = new ConversationStore(paths, logger);
  const sessions = new SessionStore({ paths, logger });
  const windows = new ObservationWindowStore({ allowlist: [GROUP_TARGET.key] });
  // 措辞轮次只读这三个方法（capture/takePending 是被动轮次与后台结果的接缝）
  const background = {
    noteAnchor: () => {},
    takePending: () => [],
    capture: () => {},
  } as unknown as BackgroundPusher;

  const turns = new TurnRunner({
    config,
    logger,
    pool,
    conversations,
    windows,
    sessions,
    paths,
    stats,
    background,
  });

  // 与 main.ts 同款接线：runtime 事件 → TurnRunner 路由
  runtime.on('session.event', (n: SessionEventNotification) => {
    turns.routeSessionEvent(GROUP_TARGET.key, n);
  });
  runtime.on('session.status', (n: { sessionId: string; status: 'idle' | 'running' }) => {
    turns.routeSessionStatus(GROUP_TARGET.key, n);
  });

  return {
    root,
    turns,
    runtime,
    pool,
    sessions,
    windows,
    conversations,
    stats,
    config,
    logger,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 等条件成立（fs 操作是宏任务，微任务 flush 覆盖不到，用轮询最稳）。 */
async function waitFor(predicate: () => void): Promise<void> {
  await vi.waitFor(predicate, { timeout: 5000, interval: 5 });
}

function makeUserCtx(h: ReturnType<typeof setup>, text: string): MessageContext {
  const message: NormalizedMessage = {
    kind: 'group-at-message',
    target: GROUP_TARGET,
    eventId: 'EVT-U1',
    msgId: 'MSG-U1',
    senderId: 'MEMBER-1',
    username: '小明',
    content: text,
    ts: 1_700_000_000_000,
    raw: {},
  };
  const connector = {
    platform: 'onebot',
    acceptsC2C: true,
    on: () => () => {},
    start: async () => {},
    stop: async () => {},
    health: () => ({ connected: true, state: 'test' }),
    policy: () => POLICY,
    reply: async () => {},
  };
  const responder = new Responder({
    message,
    connector: connector as never,
    policy: POLICY,
    conversations: h.conversations,
    stats: h.stats,
    logger: h.logger,
  });
  return {
    message,
    connector: connector as never,
    policy: POLICY,
    isAdmin: false,
    logger: h.logger,
    responder,
  };
}

describe('runProactiveTurn：主动发言的措辞轮次', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => h.cleanup());

  it('正常路径：返回模型最终文本；prompt 含判定要点与群聊上下文；entry 用完释放', async () => {
    h.windows.observe({
      kind: 'group-message',
      target: GROUP_TARGET,
      eventId: 'EVT-O1',
      msgId: 'MSG-O1',
      senderId: 'u1',
      username: '阿梁',
      content: 'NAS 上能跑吗？',
      ts: Date.now(),
      raw: {},
    });

    const promise = h.turns.runProactiveTurn(SPEAK_INPUT);
    await waitFor(() => expect(h.runtime.prompts).toHaveLength(1));
    const prompt = h.runtime.prompts[0]!;
    expect(prompt.text).toContain('回答 NAS 上跑 docker 的可行性');
    expect(prompt.text).toContain('NAS 上能跑吗？');
    expect(prompt.text).toContain('不说');

    h.runtime.completeTurn(prompt.sessionId, ['能跑，记得给容器挂上数据卷']);
    await expect(promise).resolves.toBe('能跑，记得给容器挂上数据卷');
    expect(h.pool.release).toHaveBeenCalledWith(GROUP_TARGET.key);
  });

  it('会话有用户轮次在跑 → 直接放弃，不派发 prompt', async () => {
    const userTurn = h.turns.runTurn(makeUserCtx(h, '帮我看看')); // 不喂事件，保持占用
    await waitFor(() => expect(h.runtime.prompts).toHaveLength(1));

    await expect(h.turns.runProactiveTurn(SPEAK_INPUT)).resolves.toBeUndefined();
    expect(h.runtime.prompts).toHaveLength(1);

    // 收尾用户轮次，别留悬挂的 promise
    const sessionId = h.sessions.peek(GROUP_TARGET.key)!.currentSessionId;
    h.runtime.completeTurn(sessionId, ['看了，没问题']);
    await userTurn;
  });

  it('逃生门：模型回「不说」→ 返回 undefined（本次不发言）', async () => {
    const promise = h.turns.runProactiveTurn(SPEAK_INPUT);
    await waitFor(() => expect(h.runtime.prompts).toHaveLength(1));
    h.runtime.completeTurn(h.runtime.prompts[0]!.sessionId, ['不说']);
    await expect(promise).resolves.toBeUndefined();
  });

  it('失控兜底：模型写长文时按硬上限截断', async () => {
    const promise = h.turns.runProactiveTurn(SPEAK_INPUT);
    await waitFor(() => expect(h.runtime.prompts).toHaveLength(1));
    h.runtime.completeTurn(h.runtime.prompts[0]!.sessionId, ['很长的回答'.repeat(100)]);
    const text = await promise;
    expect(text).toBeDefined();
    expect(text!.length).toBeLessThanOrEqual(301); // 300 + 省略号
    expect(text!.endsWith('…')).toBe(true);
  });

  it('生成超时：回收 runtime、返回 undefined', async () => {
    vi.useFakeTimers();
    try {
      const h2 = setup({ BOT_PROACTIVE_SPEAK_TIMEOUT_MS: '30000' });
      const promise = h2.turns.runProactiveTurn(SPEAK_INPUT);
      await vi.advanceTimersByTimeAsync(0); // 让 acquire/prompt 微任务跑完
      expect(h2.runtime.prompts).toHaveLength(1);
      // 不喂任何事件 → 永不 settle → 到点超时
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(promise).resolves.toBeUndefined();
      expect(h2.pool.drop).toHaveBeenCalledWith(GROUP_TARGET.key);
      h2.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it('抢占：生成中来了用户消息 → 主动轮次作废、runtime 回收、用户轮次正常', async () => {
    const proactive = h.turns.runProactiveTurn(SPEAK_INPUT);
    await waitFor(() => expect(h.runtime.prompts).toHaveLength(1));

    const userTurn = h.turns.runTurn(makeUserCtx(h, '帮我看看这个'));
    // 主动轮次被抢占：abort 收尾 → undefined；runtime 被回收
    await expect(proactive).resolves.toBeUndefined();
    expect(h.pool.drop).toHaveBeenCalledWith(GROUP_TARGET.key);

    // 用户轮次在新一轮里正常完成
    await waitFor(() => expect(h.runtime.prompts.length).toBeGreaterThan(1));
    const sessionId = h.sessions.peek(GROUP_TARGET.key)!.currentSessionId;
    h.runtime.completeTurn(sessionId, ['看了，没问题']);
    await userTurn;
  });
});
