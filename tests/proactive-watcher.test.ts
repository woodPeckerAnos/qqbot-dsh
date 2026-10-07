/**
 * 主动介入 watcher 单测：`collect → judge → veto → deliver` 全链（离线）。
 *
 * 用手动时钟 + 假判定 + 假适配器，因此可以断言"第几步发生了什么"，
 * 而不是只能看最终有没有说话。覆盖四类不变量：
 *   1. 成本闸：白名单/开关/无候选 → 一次 LLM 都不调；
 *   2. 触发面：消息即时评估、问题挂起后探针、滚动收敛（条数与时间两条路）；
 *   3. 降级：判定失败 → 沉默并计数；连续失败 → 暂停该会话；
 *   4. 投递：dryRun 只记 wouldSend；平台不支持 → 记 deliveryDegraded；成功 → 记账。
 */

import { describe, expect, it } from 'vitest';

import type {
  BotConnector,
  ConversationTarget,
  NormalizedMessage,
  OutgoingMessage,
  ProactiveResult,
  ReplyPolicy,
} from '../src/core/connector.js';
import { createNullLogger } from '../src/logger.js';
import type { SceneCandidate, SceneVerdict } from '../src/pipeline/proactive/contract.js';
import { ProactiveSpeaker } from '../src/pipeline/proactive/deliver/speaker.js';
import type { ProactiveJudge, ProactiveJudgeInput } from '../src/pipeline/proactive/judge/client.js';
import {
  ProactiveWatcher,
  DEFAULT_WATCHER_CONFIG,
  type ProactiveWatcherConfig,
} from '../src/pipeline/proactive/scene/watcher.js';
import { parseInterestPool } from '../src/pipeline/proactive/interests/pool.js';

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

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

interface Harness {
  watcher: ProactiveWatcher;
  /** 手动推进时间 + 触发到期的定时器 */
  advance(ms: number): void;
  observe(senderId: string, text: string, msFromStart?: number): void;
  judgeCalls: ProactiveJudgeInput[];
  delivered: Array<{ target: ConversationTarget; out: OutgoingMessage }>;
  /** 让判定返回的"成立场景" */
  setVerdicts(scenes: string[], options?: { suggestsWait?: boolean }): void;
  /** 让判定失败 */
  setJudgeFailure(fail: boolean): void;
  snapshot(): ReturnType<ProactiveWatcher['snapshot']>;
}

function setup(overrides: Partial<ProactiveWatcherConfig> = {}, options: { proactive?: boolean } = {}): Harness {
  let clock = 1_700_000_000_000;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const judgeCalls: ProactiveJudgeInput[] = [];
  const delivered: Array<{ target: ConversationTarget; out: OutgoingMessage }> = [];
  let satisfied: string[] = [];
  let suggestsWait = false;
  let failing = false;

  const judge: ProactiveJudge = {
    async judge(input) {
      judgeCalls.push(input);
      if (failing) return undefined;
      const verdicts: SceneVerdict[] = input.candidates.map((candidate: SceneCandidate) => ({
        scene: candidate.scene,
        satisfied: satisfied.includes(candidate.scene),
        confidence: satisfied.includes(candidate.scene) ? 0.9 : 0.1,
        reason: satisfied.includes(candidate.scene) ? '判定成立' : '判定不成立',
        ...(suggestsWait ? { suggestsWait: true } : {}),
      }));
      return verdicts;
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
      return options.proactive === false
        ? { ok: false, reason: 'unsupported', retryable: false }
        : { ok: true };
    },
  };

  const speaker = new ProactiveSpeaker({
    connectorFor: () => connector,
    enabled: true,
    dryRun: overrides.dryRun ?? false,
    logger: createNullLogger(),
  });

  const config: ProactiveWatcherConfig = {
    ...DEFAULT_WATCHER_CONFIG,
    enabled: true,
    dryRun: false,
    whitelistGroups: [GROUP_KEY],
    ...overrides,
  };

  const watcher = new ProactiveWatcher({
    config,
    speaker,
    judge,
    interests: parseInterestPool(
      'interests:\n  - {id: plotting, topic: 画图, keywords: [折线图]}',
      'test.yml',
    ),
    logger: createNullLogger(),
    now: () => clock,
    schedule: (fn, delayMs) => {
      const timer = { at: clock + delayMs, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });

  return {
    watcher,
    advance(ms) {
      clock += ms;
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= clock) {
          timer.cancelled = true;
          timer.fn();
        }
      }
    },
    observe(senderId, text) {
      watcher.observe(makeObserved(senderId, text, clock));
    },
    judgeCalls,
    delivered,
    setVerdicts(scenes, opts) {
      satisfied = scenes;
      suggestsWait = opts?.suggestsWait ?? false;
    },
    setJudgeFailure(fail) {
      failing = fail;
    },
    snapshot: () => watcher.snapshot(),
  };
}

function makeObserved(senderId: string, content: string, ts: number): NormalizedMessage {
  return {
    kind: 'group-message',
    target: GROUP_TARGET,
    eventId: `evt-${senderId}-${ts}`,
    msgId: `msg-${senderId}-${ts}`,
    senderId,
    username: senderId,
    content,
    ts,
    raw: {},
  };
}

/** 等一次异步评估收口（kick 是 fire-and-forget）。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// 1. 成本闸
// ---------------------------------------------------------------------------

describe('成本闸：不该花的一次调用都不花', () => {
  it('验收1：白名单为空 / 总开关关 → 连状态都不入', async () => {
    const blocked = setup({ whitelistGroups: [] });
    blocked.observe('u1', '有人吗');
    blocked.setVerdicts(['scene-4']);
    await settle();
    expect(blocked.judgeCalls).toHaveLength(0);
    expect(blocked.snapshot().conversations).toBe(0);

    const off = setup({ enabled: false });
    off.observe('u1', '有人吗');
    await settle();
    expect(off.judgeCalls).toHaveLength(0);
  });

  it('验收2：本地无候选 → 不调判定（省一次调用）', async () => {
    const h = setup();
    h.observe('u1', '今天中午吃什么'); // 没 @、不是问题、没命中兴趣 → 无候选
    await settle();
    expect(h.snapshot().evaluatedByTrigger['message']).toBeUndefined();
    // 滚动定时器到点后会评估一次（那是场景 2/5 的设计入口），这里只断言"消息触发"没花钱
    expect(h.judgeCalls).toHaveLength(0);
  });

  it('验收3：白名单接受会话键与「平台:群号」两种写法', () => {
    expect(setup({ whitelistGroups: [GROUP_KEY] }).watcher.isAllowed(GROUP_KEY)).toBe(true);
    expect(setup({ whitelistGroups: ['onebot:8888'] }).watcher.isAllowed(GROUP_KEY)).toBe(true);
    expect(setup({ whitelistGroups: ['onebot:9999'] }).watcher.isAllowed(GROUP_KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. 触发面
// ---------------------------------------------------------------------------

describe('触发面：三种时机各自工作', () => {
  it('验收4：场景 4（指代）在消息触发下立即评估并投递', async () => {
    const h = setup();
    h.setVerdicts(['scene-4']);
    h.observe('u1', '机器人能帮我把这个表格转成 csv 吗');
    await settle();
    expect(h.snapshot().evaluatedByTrigger['message']).toBe(1);
    expect(h.snapshot().satisfiedByScene['scene-4']).toBe(1);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.target.key).toBe(GROUP_KEY);
    expect(h.snapshot().spoke).toBe(1);
  });

  it('验收5：场景 3（无人应答）挂起 90s 后走探针，不提前打扰', async () => {
    const h = setup({ questionProbeMs: 90_000 });
    h.setVerdicts(['scene-3']);
    h.observe('u1', '有没有人知道这个接口的分页参数怎么传？');
    await settle();
    // 问题刚出现时不判（先给群里 90 秒）
    expect(h.delivered).toHaveLength(0);
    expect(h.snapshot().pendingQuestions).toBe(1);

    h.advance(90_000);
    await settle();
    expect(h.snapshot().evaluatedByTrigger['question-probe']).toBe(1);
    expect(h.delivered).toHaveLength(1);
  });

  it('验收6：滚动收敛——消息数先到（每 N 条一次）', async () => {
    const h = setup({ topicRollMessages: 3, topicRollMs: 600_000 });
    h.setVerdicts(['scene-2']);
    for (let index = 0; index < 3; index += 1) h.observe(`u${index % 2}`, `第 ${index} 句话`);
    await settle();
    // 攒够 3 条立即收敛（不需要等时间那条路）
    expect(h.snapshot().evaluatedByTrigger['topic-roll']).toBe(1);
    expect(h.snapshot().satisfiedByScene['scene-2']).toBe(1);
  });

  it('验收7：滚动收敛只会在"真的没人说话了"之后发生（热聊中不插话）', async () => {
    const h = setup({ topicRollMessages: 30, topicRollMs: 60_000 });
    h.setVerdicts(['scene-2']);
    h.observe('u1', '第一句');
    await settle();
    // 30 条没攒够 → 只有时间那条路
    expect(h.snapshot().evaluatedByTrigger['topic-roll']).toBeUndefined();

    // 到点时若刚有人说话（静默不足 60s），**不评估**，只按剩余时间再看一次
    h.advance(50_000);
    h.observe('u2', '第二句');
    h.advance(50_000); // 距第一条 100s，但距第二条只有 50s
    await settle();
    expect(h.snapshot().evaluatedByTrigger['topic-roll']).toBeUndefined();

    // 真的静下来之后才收敛
    h.advance(60_000);
    await settle();
    expect(h.snapshot().evaluatedByTrigger['topic-roll']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. 降级
// ---------------------------------------------------------------------------

describe('降级：判定失败一律沉默，且不刷 API', () => {
  it('验收8：判定失败 → 不投递、记计数、连续失败后暂停该会话', async () => {
    const h = setup({ maxJudgeFailures: 2 });
    h.setVerdicts(['scene-4']);
    h.setJudgeFailure(true);

    h.observe('u1', '机器人能帮我看看吗');
    await settle();
    expect(h.delivered).toHaveLength(0);
    expect(h.snapshot().judgeFailures).toBe(1);

    h.observe('u1', '机器人在吗，帮我一下');
    await settle();
    expect(h.snapshot().judgeFailures).toBe(2);
    expect(h.snapshot().suspended).toBe(1);

    // 暂停后不再评估（不往坏掉的 API 上刷请求）
    const before = h.judgeCalls.length;
    h.observe('u1', '机器人再帮我一次');
    await settle();
    expect(h.judgeCalls.length).toBe(before);
  });

  it('验收9：平台不支持主动发言 → 记 deliveryDegraded，不抛错', async () => {
    const h = setup({}, { proactive: false });
    h.setVerdicts(['scene-4']);
    h.observe('u1', '机器人帮我转个表');
    await settle();
    expect(h.snapshot().deliveryDegraded['unsupported']).toBe(1);
    expect(h.snapshot().spoke).toBe(0);
  });

  it('验收10：dryRun → 判定照跑、只记 wouldSend、不碰适配器', async () => {
    const h = setup({ dryRun: true });
    h.setVerdicts(['scene-4']);
    h.observe('u1', '机器人帮我看下');
    await settle();
    expect(h.snapshot().wouldSend).toBe(1);
    expect(h.snapshot().spoke).toBe(0);
    expect(h.delivered).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. 否决与额度
// ---------------------------------------------------------------------------

describe('否决层在链条里的位置', () => {
  it('验收11：判定全不成立 → no-scene 计数，不投递', async () => {
    const h = setup();
    h.setVerdicts([]);
    h.observe('u1', '机器人帮我看下');
    await settle();
    expect(h.snapshot().vetoed['no-scene']).toBe(1);
    expect(h.delivered).toHaveLength(0);
  });

  it('验收12：判定 wait 建议 → 排一次重查，不立即发言', async () => {
    // 先让场景 1 成为候选（bot 在这个话题里说过话），否则本地没候选、判定都不跑
    // 探针时间调长：本用例只验证 wait 的那条重查路径，不让问题探针插进来
    const h = setup({ questionProbeMs: 600_000 });
    h.observe('u1', '帮我看看这个报错');
    h.watcher.notifyBotSpoke(GROUP_KEY);
    h.setVerdicts([], { suggestsWait: true });

    h.observe('u2', '我这也报错了，有没有人知道这个怎么解决？');
    await settle();
    expect(h.delivered).toHaveLength(0);
    expect(h.snapshot().vetoed['wait']).toBe(1);
    const calls = h.judgeCalls.length;
    h.advance(30_000);
    await settle();
    expect(h.judgeCalls.length).toBeGreaterThan(calls);
  });

  it('验收13：限流窗口按会话记——发言后同一会话内不再投递', async () => {
    const h = setup({ rateLimit10Min: 1 });
    h.setVerdicts(['scene-4']);
    h.observe('u1', '机器人帮我看下');
    await settle();
    expect(h.delivered).toHaveLength(1);

    h.observe('u1', '机器人再帮我看看');
    await settle();
    expect(h.delivered).toHaveLength(1); // 被 rate-limit 否决
    expect(h.snapshot().vetoed['rate-limit']).toBe(1);
  });

  it('验收14：同一个话题里说过一次就不再重复（每话题一次）', async () => {
    const h = setup({ vetoPolicy: { maxPerTopic: 1 } });
    h.setVerdicts(['scene-4']);
    h.observe('u1', '机器人帮我看下');
    await settle();
    expect(h.delivered).toHaveLength(1);

    h.observe('u2', '机器人也在吗');
    await settle();
    // 同一活动窗口内 bot 已说过 1 次 → topic-spent（即使限流还没到）
    expect(h.snapshot().vetoed['topic-spent']).toBe(1);
  });

  it('验收15：没人理我就停——连续两次主动发言无人回应后，连判定都不跑', async () => {
    const h = setup({ vetoPolicy: { maxUnansweredStreak: 2, maxPerTopic: 5 } });
    // 判定先设好（observe 是 fire-and-forget，设晚了这次评估就拿到旧判定）
    h.setVerdicts(['scene-4']);
    h.observe('u1', '机器人帮我看下这个报错');
    await settle();
    expect(h.snapshot().spoke).toBe(1);
    expect(h.watcher.stateFor(GROUP_KEY).unansweredStreak).toBe(1);

    // 第二次主动发言（群里翻篇后 bot 又说了一次，仍无人接话）
    h.advance(600_000);
    h.watcher.notifyBotSpoke(GROUP_KEY);
    expect(h.watcher.stateFor(GROUP_KEY).unansweredStreak).toBe(2);

    // 保险生效：本地就不再产生候选，**连判定都不跑**
    const before = h.judgeCalls.length;
    h.observe('u2', '机器人能帮我算个数吗');
    await settle();
    expect(h.judgeCalls.length).toBe(before);
    expect(h.snapshot().spoke).toBe(1);
    expect(h.snapshot().vetoed['no-candidate']).toBeGreaterThan(0);
  });
});
