/**
 * 话题 session（主动发言的唯一放行闸门）专项单测。
 *
 * 逐条对应 docs/TOPIC-SESSION-REQUIREMENT.md 的**验收标准 1–14**：
 *
 * | 用例 | 验收 |
 * |---|---|
 * | 验收1 | 无 session + 判成立 → 开 session、扣 1 点预算、计 `proactiveSessionOpened` |
 * | 验收2 | 无 session + 判不成立 → 不开 session，计 `proactiveNoSession` |
 * | 验收3 | session 开启后再次唤醒 → 不再要求"有新内容"，直接进判定并说第二句 |
 * | 验收4 | 预算减到 0 → 立即关闭；此后唤醒 `silent('no-session')` |
 * | 验收5 | LLM 给 `close` → 关闭（llm-closed），**本次发言照常发出** |
 * | 验收6 | 静默超过 `sessionIdleMs` → 自动关闭（idle），**不调 LLM** |
 * | 验收7 | 间隔 < `sessionMinGapMs` → `min-gap`，**不消耗预算** |
 * | 验收8 | 转录自上次评估无新增 → **不调 LLM** |
 * | 验收9 | `sessionBudget=9` → 按硬上限 5 处理并 warn |
 * | 验收10 | `rate-limit` 仍**先于** session 闸门 |
 * | 验收11 | `opened === closed === Σ closedBy{reason}`（账目闭合） |
 * | 验收12 | 旧标识符在 `src/` 里不再存在（grep 断言） |
 * | 验收13 | session 关闭后再次判成立 → 重新开启（`openedAt` 更新、预算重置） |
 * | 验收14 | session 期间话题换了（LLM 没给 close）→ 仍按旧 session 走，不崩溃 |
 *
 * 用假判定 + 手动时钟，因此每一步都能断言"闸门为什么过/不过"。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  BotConnector,
  ConversationTarget,
  NormalizedMessage,
  OutgoingMessage,
  ProactiveResult,
  ReplyPolicy,
} from '../src/core/connector.js';
import { createNullLogger, type Logger } from '../src/logger.js';
import type {
  SceneCandidate,
  SceneVerdict,
  SessionDirective,
} from '../src/pipeline/proactive/contract.js';
import { ProactiveSpeaker } from '../src/pipeline/proactive/deliver/speaker.js';
import type { ProactiveJudge, ProactiveJudgeInput } from '../src/pipeline/proactive/judge/client.js';
import {
  DEFAULT_WATCHER_CONFIG,
  ProactiveWatcher,
  type ProactiveWatcherConfig,
} from '../src/pipeline/proactive/scene/watcher.js';

const START = 1_700_000_000_000;
const GROUP_KEY = 'ob11:g8888';
const GROUP_TARGET: ConversationTarget = {
  platform: 'onebot',
  kind: 'group',
  id: '8888',
  key: GROUP_KEY,
};
const POLICY: ReplyPolicy = {
  maxChars: 1000,
  maxRepliesPerMsg: 10,
  progressMax: 2,
  progressAfterMs: 1000,
  progressIntervalMs: 1000,
  turnTimeoutMs: 60_000,
  passiveWindowMs: Number.POSITIVE_INFINITY,
};

/** 让判定成立的场景 + 会话级指令（模拟模型在每条判定上重复 `session` 字段）。 */
interface Plan {
  satisfied: string[];
  session?: SessionDirective;
}

interface Harness {
  watcher: ProactiveWatcher;
  advance(ms: number): void;
  observe(senderId: string, text: string): void;
  setPlan(plan: Plan): void;
  /** 让判定失败（超时 / 密钥 / 解析） */
  setJudgeFailure(fail: boolean): void;
  judgeCalls: ProactiveJudgeInput[];
  snapshot(): ReturnType<ProactiveWatcher['snapshot']>;
  /** 当前 session 的只读快照（测试断言预算/时刻用） */
  session(): { openedAt: number; budgetLeft: number; lastSpokeAt?: number } | undefined;
  delivered: Array<{ target: ConversationTarget; out: OutgoingMessage }>;
  warnings: string[];
}

function setup(
  overrides: Partial<ProactiveWatcherConfig> = {},
  logger?: Logger,
): Harness {
  let clock = START;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const judgeCalls: ProactiveJudgeInput[] = [];
  const delivered: Array<{ target: ConversationTarget; out: OutgoingMessage }> = [];
  const warnings: string[] = [];
  let plan: Plan = { satisfied: [] };
  let failing = false;

  const judge: ProactiveJudge = {
    async judge(input) {
      judgeCalls.push(input);
      if (failing) return undefined;
      const current = plan;
      return input.candidates.map((candidate: SceneCandidate): SceneVerdict => {
        const hit = current.satisfied.includes(candidate.scene);
        return {
          scene: candidate.scene,
          satisfied: hit,
          confidence: hit ? 0.9 : 0.1,
          reason: hit ? '判定成立' : '判定不成立',
          ...(current.session === undefined ? {} : { session: current.session }),
        };
      });
    },
  };

  const connector: BotConnector = {
    platform: 'onebot',
    acceptsC2C: true,
    start: async () => {},
    stop: async () => {},
    on: () => () => {},
    health: () => ({ connected: true, state: 'test' }),
    policy: () => POLICY,
    reply: async () => {},
    proactive: async (target, out): Promise<ProactiveResult> => {
      delivered.push({ target, out });
      return { ok: true };
    },
  };

  const speaker = new ProactiveSpeaker({
    connectorFor: () => connector,
    enabled: true,
    dryRun: false,
    logger: createNullLogger(),
  });

  const baseLogger: Logger = logger ?? createNullLogger();
  const captureLogger: Logger = {
    debug: baseLogger.debug.bind(baseLogger),
    info: baseLogger.info.bind(baseLogger),
    warn: (msg, fields) => {
      warnings.push(msg);
      baseLogger.warn(msg, fields);
    },
    error: baseLogger.error.bind(baseLogger),
    child: () => captureLogger,
  };

  const watcher = new ProactiveWatcher({
    config: {
      ...DEFAULT_WATCHER_CONFIG,
      enabled: true,
      dryRun: false,
      whitelistGroups: [GROUP_KEY],
      ...overrides,
    },
    speaker,
    judge,
    logger: captureLogger,
    now: () => clock,
    schedule: (fn, delayMs) => {
      const timer = { at: clock + delayMs, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });

  function fireDue(): void {
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= clock) {
        timer.cancelled = true;
        timer.fn();
      }
    }
  }

  return {
    watcher,
    advance(ms) {
      clock += ms;
      fireDue();
    },
    observe(senderId, text) {
      const message: NormalizedMessage = {
        kind: 'group-message',
        target: GROUP_TARGET,
        eventId: `evt-${senderId}-${clock}-${text}`,
        msgId: `msg-${senderId}-${clock}-${text}`,
        senderId,
        username: senderId,
        content: text,
        ts: clock,
        raw: {},
      };
      watcher.observe(message);
    },
    setPlan(next) {
      plan = next;
    },
    setJudgeFailure(fail) {
      failing = fail;
    },
    judgeCalls,
    snapshot: () => watcher.snapshot(),
    session: () => watcher.stateFor(GROUP_KEY).session,
    delivered,
    warnings,
  };
}

/** 等 fire-and-forget 的评估收口。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 一条命中场景 4（指代）的旁听消息：本地预筛必须能命中，否则判定根本不跑。 */
const ADDRESS = '机器人帮我看看这个报错';

// ---------------------------------------------------------------------------
// 验收 1–2：开与不开
// ---------------------------------------------------------------------------

describe('session 的开启（验收1、验收2）', () => {
  it('验收1：无 session 时判成立 → 开 session（预算 = sessionBudget），该次发言消耗 1 点', async () => {
    const h = setup({ sessionBudget: 2 });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();

    expect(h.snapshot().spoke).toBe(1);
    expect(h.snapshot().sessions.opened).toBe(1);
    const session = h.session();
    expect(session).toBeDefined();
    expect(session?.budgetLeft).toBe(1); // 2 - 1：开启时是 2，这一句扣掉 1
    expect(session?.openedAt).toBe(START);
    expect(session?.lastSpokeAt).toBe(START);
  });

  it('验收2：无 session 时判不成立 → 不开 session，计 proactiveNoSession', async () => {
    const h = setup();
    h.setPlan({ satisfied: [] });
    h.observe('u1', ADDRESS);
    await settle();

    expect(h.snapshot().sessions.opened).toBe(0);
    expect(h.session()).toBeUndefined();
    expect(h.snapshot().sessions.noSession).toBe(1);
    expect(h.snapshot().vetoed['no-session']).toBe(1);
    expect(h.snapshot().spoke).toBe(0);

    // "下次唤醒仍从需要 LLM 重新判值得开始"：判成立立刻就开
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u2', '机器人再帮我看看');
    await settle();
    expect(h.snapshot().sessions.opened).toBe(1);
    expect(h.snapshot().spoke).toBe(1);
  });

  it('验收2b：模型全判不成立但**已有** session → 记 no-scene（session 保持开启）', async () => {
    const h = setup({ sessionBudget: 3 });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();
    expect(h.snapshot().sessions.opened).toBe(1);

    h.setPlan({ satisfied: [] });
    h.observe('u2', '机器人这个我知道了');
    await settle();
    expect(h.snapshot().vetoed['no-scene']).toBe(1);
    expect(h.snapshot().sessions.noSession).toBe(0);
    expect(h.session()?.budgetLeft).toBe(2); // 不成立不消耗预算
  });
});

// ---------------------------------------------------------------------------
// 验收 3–5：session 开着的时候
// ---------------------------------------------------------------------------

describe('session 开着时的放行（验收3、验收5）', () => {
  it('验收3：session 开启后再次唤醒 → 不再要求"有新内容"，直接进判定说第二句', async () => {
    const h = setup({ sessionBudget: 3, sessionMinGapMs: 45_000 });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();
    expect(h.snapshot().spoke).toBe(1);

    // 越过最小间隔后又说一句：这是旧实现里被"每话题一次"拦掉的那一句
    h.advance(45_000);
    h.observe('u1', '机器人再帮我看看这个报错');
    await settle();

    expect(h.snapshot().spoke).toBe(2);
    expect(h.snapshot().sessions.opened).toBe(1); // 没有开第二个 session
    expect(h.session()?.budgetLeft).toBe(1);
    expect(h.session()?.lastSpokeAt).toBe(START + 45_000);
  });

  it('验收5：LLM 给 close → 关闭（llm-closed），且本次发言照常发出', async () => {
    const h = setup({ sessionBudget: 3 });
    h.setPlan({ satisfied: ['scene-4'], session: 'close' });
    h.observe('u1', ADDRESS);
    await settle();

    expect(h.snapshot().spoke, 'close 不影响这一条').toBe(1);
    expect(h.snapshot().sessions.closedBy['llm-closed']).toBe(1);
    expect(h.session()).toBeUndefined();
  });

  it('验收5b：LLM 给 close 但本次不发言（satisfied:false）→ 照样关闭，不发言', async () => {
    const h = setup({ sessionBudget: 3 });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();
    expect(h.snapshot().sessions.opened).toBe(1);

    h.setPlan({ satisfied: [], session: 'close' });
    h.observe('u2', '机器人这个话题就这样吧');
    await settle();

    expect(h.snapshot().spoke).toBe(1); // 没多说
    expect(h.snapshot().sessions.closedBy['llm-closed']).toBe(1);
    expect(h.session()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 验收 4、13：预算与重开
// ---------------------------------------------------------------------------

describe('预算（验收4、验收4b、验收13）', () => {
  it('验收4：预算减到 0 → **闭嘴但不关会话**；同一话题再判成立仍不放行、也不新开', async () => {
    const h = setup({ sessionBudget: 1, sessionMinGapMs: 10_000 });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();

    expect(h.snapshot().spoke).toBe(1);
    // 维护者修正过的口径：**预算不驱动 session 的生死**——会话还在，只是耗尽
    expect(h.session(), '预算耗尽不关闭会话').toBeDefined();
    expect(h.session()?.budgetLeft).toBe(0);
    expect(h.snapshot().sessions.spent).toBe(1);
    expect(h.snapshot().sessions.closed).toBe(0);
    expect(Object.keys(h.snapshot().sessions.closedBy)).toHaveLength(0);

    // 同一个话题里再判成立（间隔也过了）→ 闸门不放行，而且**不为了预算新开一个**
    h.advance(60_000);
    h.observe('u1', '机器人再帮我看看这个报错');
    await settle();
    expect(h.snapshot().vetoed['budget-exhausted']).toBe(1);
    expect(h.snapshot().sessions.budgetExhausted).toBe(1);
    expect(h.snapshot().sessions.opened, '不为了预算新开会话').toBe(1);
    expect(h.snapshot().spoke).toBe(1);
    expect(h.session()?.budgetLeft).toBe(0);

    // 再连说三次也一样：这才是"预算真的当刹车"
    // （旧口径下每次都能靠"关掉旧的 → 下次唤醒再开一个"绕过去）
    for (let index = 0; index < 3; index += 1) {
      h.advance(60_000);
      h.observe('u1', `机器人再帮我看看第 ${index} 次`);
      await settle();
    }
    expect(h.snapshot().spoke).toBe(1);
    expect(h.snapshot().sessions.opened).toBe(1);
    expect(h.snapshot().sessions.budgetExhausted).toBe(4);
  });

  it('验收4b：模型明确说换话题（new-topic）→ 关旧开新、预算重置、本次照说', async () => {
    const h = setup({ sessionBudget: 2, sessionMinGapMs: 45_000 });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();
    h.advance(45_000);
    h.observe('u1', '机器人再帮我看看');
    await settle();
    expect(h.session()?.budgetLeft, '说满两句 → 耗尽但会话还在').toBe(0);

    // ① 换话题的声明**不能**绕过节奏：间隔没到照样 min-gap
    h.setPlan({ satisfied: ['scene-4'], session: 'new-topic' });
    h.advance(5_000);
    h.observe('u1', '机器人换个话题，帮我查下明天天气');
    await settle();
    expect(h.snapshot().vetoed['min-gap']).toBe(1);
    expect(h.snapshot().sessions.opened, '没放过闸门就不该开新会话').toBe(1);

    // ② 间隔到了 + 模型说换话题 → 关旧（topic-changed）开新，预算重置
    h.advance(45_000);
    h.observe('u1', '机器人换个话题，帮我查下明天天气');
    await settle();
    expect(h.snapshot().spoke).toBe(3);
    expect(h.snapshot().sessions.opened).toBe(2);
    expect(h.snapshot().sessions.closedBy['topic-changed']).toBe(1);
    expect(h.session()?.budgetLeft, '新话题的预算是满的减 1').toBe(1);
  });

  it('验收13：session 关闭后再次判成立 → 重新开启（openedAt 更新、预算重置）', async () => {
    const h = setup({ sessionBudget: 2, sessionIdleMs: 60_000 });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();
    const first = h.session();
    expect(first?.openedAt).toBe(START);
    expect(first?.budgetLeft).toBe(1);

    // 静默超时关闭（下一次唤醒之前它就已经关了）
    h.advance(60_000);
    expect(h.snapshot().sessions.closedBy['idle']).toBe(1);
    expect(h.session()).toBeUndefined();

    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', '机器人帮我看看新问题');
    await settle();

    expect(h.snapshot().sessions.opened).toBe(2);
    const second = h.session();
    expect(second?.openedAt).toBe(START + 60_000);
    expect(second?.budgetLeft, '预算重置为 sessionBudget - 1').toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 验收 6–8：三种"不过闸门"
// ---------------------------------------------------------------------------

describe('闸门（验收6、验收7、验收8）', () => {
  it('验收6：静默超过 sessionIdleMs → 自动关闭（idle），不调 LLM', async () => {
    const h = setup({ sessionBudget: 3, sessionIdleMs: 60_000, topicRollMs: 300_000 });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();
    const before = h.judgeCalls.length;

    h.advance(60_000); // 到点：只关 session，不说话也不问模型
    await settle();

    expect(h.snapshot().sessions.closedBy['idle']).toBe(1);
    expect(h.snapshot().sessions.open).toBe(0);
    expect(h.judgeCalls.length, 'idle 关闭不调 LLM').toBe(before);
  });

  it('验收7：同一 session 内两次发言间隔不足 → min-gap，且不消耗预算', async () => {
    const h = setup({ sessionBudget: 2, sessionMinGapMs: 45_000 });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();
    expect(h.session()?.budgetLeft).toBe(1);

    h.advance(5_000); // 远小于 45 秒
    h.observe('u1', '机器人再帮我看看');
    await settle();

    expect(h.snapshot().vetoed['min-gap']).toBe(1);
    expect(h.snapshot().sessions.minGap).toBe(1);
    expect(h.snapshot().spoke, '被挡下的那次不发言').toBe(1);
    expect(h.session()?.budgetLeft, '预算是"说了几句"的账').toBe(1);
  });

  it('验收8：转录自上次评估以来无新增 → 不调 LLM（与 wait 的闸 4 同一实现）', async () => {
    const h = setup({ sessionBudget: 3, topicRollMessages: 30, topicRollMs: 60_000 });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();
    const before = h.judgeCalls.length;

    // 群里从此完全安静：滚动收敛的定时唤醒到点，但转录没有新增
    h.advance(120_000);
    await settle();

    expect(h.judgeCalls.length).toBe(before);
    expect(h.snapshot().skippedUnchanged).toBeGreaterThan(0);
    expect(h.snapshot().sessions.open, '没到 idle 之前 session 还在').toBe(1);
  });

  it('验收10：rate-limit 仍**先于** session 闸门（10 分钟 3 次不被预算放宽）', async () => {
    const h = setup({
      rateLimit10Min: 1,
      sessionBudget: 3,
      sessionMinGapMs: 10_000,
    });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();
    expect(h.snapshot().spoke).toBe(1);

    h.advance(60_000); // 越过最小间隔，但硬限流已经用满
    h.observe('u1', '机器人再帮我看看');
    await settle();

    expect(h.snapshot().vetoed['rate-limit']).toBe(1);
    expect(h.snapshot().sessions.minGap).toBe(0);
    expect(h.snapshot().spoke).toBe(1);
    expect(h.session()?.budgetLeft, '被限流挡下的那次不消耗预算').toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 本地闸的边界：只装滚动收敛，探针免闸
// ---------------------------------------------------------------------------

describe('本地闸的边界（口径修正）', () => {
  it('探针不受本地闸约束：bot 刚开过口的窗口内，90 秒探针照样把没人答的问题接过来', async () => {
    const h = setup({ sessionBudget: 3, questionProbeMs: 90_000, sessionMinGapMs: 45_000 });

    // bot 先主动说一句（活动窗口因此打开 → 之后每条消息都会触发一次消息面判定）
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();
    expect(h.snapshot().spoke).toBe(1);

    // 有人提问：进台账、排 90 秒探针；这条消息自己也会触发一次消息面判定
    h.observe('u2', '有没有人知道 pg 的 vacuum 参数怎么调？');
    await settle();
    const before = h.judgeCalls.length;

    // 群里从此完全安静（转录**没有**新增），探针到点
    h.setPlan({ satisfied: ['scene-3'] });
    h.advance(90_000);
    await settle();

    expect(h.judgeCalls.length, '探针应当照常问一次模型').toBeGreaterThan(before);
    expect(h.snapshot().evaluatedByTrigger['question-probe']).toBe(1);
    expect(h.snapshot().skippedUnchanged, '探针不该被本地闸挡下').toBe(0);
    expect(h.snapshot().spoke, '没人答的问题被接过来了').toBe(2);
  });

  it('滚动收敛仍然受本地闸约束：群里没人说话时不做无谓的重问', async () => {
    const h = setup({ sessionBudget: 3, topicRollMessages: 30, topicRollMs: 60_000 });
    h.setPlan({ satisfied: ['scene-2'] });
    h.observe('u1', ADDRESS);
    await settle();
    const before = h.judgeCalls.length;

    h.advance(120_000);
    await settle();

    expect(h.judgeCalls.length, '转录无新增 → 连 LLM 都不调').toBe(before);
    expect(h.snapshot().skippedUnchanged).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 验收 9：硬上限
// ---------------------------------------------------------------------------

describe('参数与硬上限（验收9）', () => {
  it('验收9：sessionBudget 配成 9 → 按硬上限 5 处理并 warn', async () => {
    const h = setup({ sessionBudget: 9 });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();

    expect(h.snapshot().sessions.budget).toBe(5);
    expect(h.session()?.budgetLeft).toBe(4);
    expect(h.warnings.some((msg) => msg.includes('sessionBudget'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 验收 11–12：账目与残留
// ---------------------------------------------------------------------------

describe('账目与残留（验收11、验收12）', () => {
  it('验收11：opened === closed === Σ closedBy{reason}（预算耗尽**不计入**关闭）', async () => {
    // 限流刻意放宽：本用例只验 session 的账目，别让硬限流先把它们挡住
    const h = setup({
      sessionBudget: 2,
      sessionMinGapMs: 10_000,
      sessionIdleMs: 60_000,
      rateLimit10Min: 50,
      rateLimit1Hour: 50,
    });
    h.setPlan({ satisfied: ['scene-4'] });

    // ① 开 #1 说第 1 句
    h.observe('u1', ADDRESS);
    await settle();

    // ② 模型说换话题：关 #1（topic-changed）+ 开 #2 说一句
    h.advance(10_000);
    h.setPlan({ satisfied: ['scene-4'], session: 'new-topic' });
    h.observe('u1', '机器人换个话题，帮我看看别的');
    await settle();

    // ③ 模型说收口：说一句之后关 #2（llm-closed）
    h.advance(10_000);
    h.setPlan({ satisfied: ['scene-4'], session: 'close' });
    h.observe('u1', '机器人再看看这个');
    await settle();

    // ④ 开 #3 说一句，之后群里安静到 idle 到点 → 关 #3（idle）
    h.advance(10_000);
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', '机器人帮我看看第三个小问题');
    await settle();
    h.advance(60_000);

    const sessions = h.snapshot().sessions;
    const closedBySum = Object.values(sessions.closedBy).reduce((sum, n) => sum + n, 0);
    expect(sessions.opened).toBe(3);
    expect(sessions.closed).toBe(3);
    expect(closedBySum).toBe(sessions.closed);
    // 预算**不再是**关闭原因：它只让会话闭嘴（`budgetExhausted` 那个闸门计数才是它）
    expect(sessions.closedBy['budget-exhausted']).toBeUndefined();
    expect(sessions.closedBy['topic-changed']).toBe(1);
    expect(sessions.closedBy['llm-closed']).toBe(1);
    expect(sessions.closedBy['idle']).toBe(1);
    expect(sessions.open).toBe(0);
    expect(sessions.spent).toBe(0);
    // spokeInSession 的分布：三个会话各说了 1 句
    expect(sessions.spokeInSession['1']).toBe(3);
  });

  it('验收12：旧标识符（每话题一次那套）在 src/ 的代码里不再存在', () => {
    const root = join(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith('.ts')) continue;
        const text = readFileSync(full, 'utf8');
        // 拼接是为了让本文件自己也不含这两个字面量（否则它会把自己扫出来）
        for (const needle of [`topic${'-'}spent`, `maxPer${'Topic'}`]) {
          if (text.includes(needle)) offenders.push(`${full}: ${needle}`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('验收12b：判定输出契约与解析器都带上了 session 字段', async () => {
    const { JUDGE_OUTPUT_CONTRACT, parseSceneVerdicts } = await import(
      '../src/pipeline/proactive/judge/judge.js'
    );
    expect(JUDGE_OUTPUT_CONTRACT).toContain('session');
    const candidates: SceneCandidate[] = [
      { scene: 'scene-4', localConfidence: 0.5, expectedRate: 0.4 },
    ];
    const parsed = parseSceneVerdicts(
      JSON.stringify({
        verdicts: [
          { scene: 'scene-4', satisfied: true, confidence: 0.9, reason: 'x', session: 'close' },
        ],
      }),
      candidates,
    );
    expect(parsed?.[0]?.session).toBe('close');
    // 非法值一律丢弃（不是整条降级）
    const bogus = parseSceneVerdicts(
      JSON.stringify({
        verdicts: [
          { scene: 'scene-4', satisfied: true, confidence: 0.9, reason: 'x', session: 'nope' },
        ],
      }),
      candidates,
    );
    expect(bogus?.[0]?.session).toBeUndefined();
    expect(bogus?.[0]?.satisfied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 边界：判定失败不改变 session 状态
// ---------------------------------------------------------------------------

describe('边界（需求边界表：判定失败）', () => {
  it('判定失败（超时 / 解析）→ 不开、不关 session，也不扣预算，只计失败次数', async () => {
    const h = setup({ sessionBudget: 2 });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();
    expect(h.session()?.budgetLeft).toBe(1);

    h.setJudgeFailure(true);
    h.observe('u1', '机器人再帮我看看');
    await settle();

    // 判定失败没有表达过任何意见 → session 的状态一个字段都不该动
    expect(h.snapshot().spoke).toBe(1);
    expect(h.session()?.budgetLeft, '失败不扣预算').toBe(1);
    expect(h.snapshot().sessions.closed, '失败不关 session').toBe(0);
    expect(h.snapshot().sessions.opened).toBe(1);
    expect(h.snapshot().judgeFailures).toBe(1);

    // 上游恢复后照常按 session 走（预算还剩 1 点、间隔已过）
    h.setJudgeFailure(false);
    h.advance(45_000);
    h.observe('u1', '机器人再帮我看看这个报错');
    await settle();
    expect(h.snapshot().spoke).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 验收 14：已知并接受的覆盖率损失
// ---------------------------------------------------------------------------

describe('边界（验收14）', () => {
  it('验收14：session 期间话题换了（LLM 没给 close）→ 仍按旧 session 走', async () => {
    const h = setup({ sessionBudget: 3, sessionMinGapMs: 45_000 });
    h.setPlan({ satisfied: ['scene-4'] });
    h.observe('u1', ADDRESS);
    await settle();
    const opened = h.session()?.openedAt;

    // 群里换了个完全不相干的话题，模型照旧判"值得"、且**没有**给 close
    h.advance(45_000);
    h.observe('u2', '机器人顺便看下明天的天气');
    await settle();

    // 已知并接受：不识别话题切换，仍按旧 session 走；断言"不崩溃 + 行为一致"
    expect(h.snapshot().sessions.opened, '不会因为话题换了就开新 session').toBe(1);
    expect(h.session()?.openedAt, 'session 还是原来那个').toBe(opened);
    expect(h.snapshot().spoke).toBe(2);
    expect(h.session()?.budgetLeft).toBe(1);
    expect(Object.keys(h.snapshot().sessions.closedBy)).toHaveLength(0);
  });
});
