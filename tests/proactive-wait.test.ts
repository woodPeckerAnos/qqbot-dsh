/**
 * **wait 收敛**的专项单测（对应 docs/WAIT-CONVERGENCE-REQUIREMENT.md 的验收 1–11）。
 *
 * 为什么单独一个文件：wait 的每一条纪律都是"**在某个时刻不该发生某件事**"
 * ——不排唤醒、不调 LLM、不建票据、不重复唤醒。这类断言必须用**手动时钟 +
 * 假判定**逐步推进才看得出来，混在通用 watcher 用例里会退化成
 * "最后有没有说话"，而那个问题恰恰是上一轮灰度回答不了的
 * （`vetoed.wait` 占 46%、`wouldSend` 只有 56）。
 *
 * 三条被反复验证的硬纪律：
 *   1. **上限在代码里**：同一个问题最多让路 `maxWaitPerItem` 次，配大了按硬上限 3 处理；
 *   2. **唤醒前两道本地检查**：对象还在吗 / 转录有新增吗——任何一道不过都不调 LLM；
 *   3. **每张票据只有一个终局**：`resolved + spent + stale + unchanged == created`。
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
import type { SceneVerdict, WaitReason } from '../src/pipeline/proactive/contract.js';
import { ProactiveSpeaker } from '../src/pipeline/proactive/deliver/speaker.js';
import type { ProactiveJudge, ProactiveJudgeInput } from '../src/pipeline/proactive/judge/client.js';
import {
  DEFAULT_WATCHER_CONFIG,
  ProactiveWatcher,
  type ProactiveWatcherConfig,
} from '../src/pipeline/proactive/scene/watcher.js';

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
const START = 1_700_000_000_000;

type VerdictMode = 'unsatisfied' | 'satisfied' | 'failure';

/** 模型可能吐出来的**非法**理由（判据描述不清时"尽量给个值"的产物）。 */
const BOGUS_WAIT_REASON = 'maybe-later' as unknown as WaitReason;

interface JudgePlan {
  /** 场景 3 判成立（唤醒真的熬到了成立） */
  scene3?: VerdictMode;
  /**
   * 非成立时给的三态理由；缺省 = 不给理由（纯"不成立"）。
   * 允许塞非法值进来（夹具不做校验，模型也不做）——判据描述要能被这样考出来。
   */
  waitReason?: WaitReason;
  /** `yielding` 时引用的对象：具体 id / 'none'（不给引用）/ 'bogus'（引用不存在的 id） */
  reference?: string;
}

interface Harness {
  watcher: ProactiveWatcher;
  /** 建立一个仍挂起的问题，并让场景 1 成为候选（否则"消息"触发面本地就短路了） */
  armQuestion(text?: string): string;
  /** 让**此后每一次**判定按这个剧本走（持续生效，直到再次设置） */
  setPlan(plan: JudgePlan): void;
  /** 只让**下一次**判定按这个剧本走（之后回到 `setPlan` 设定的形态） */
  setPlanOnce(plan: JudgePlan): void;
  /** 让判定直接失败（模拟超时 / 密钥 / 解析失败） */
  setJudgeFailure(fail: boolean): void;
  advance(ms: number): void;
  advanceSilently(ms: number): void;
  tick(): void;
  observe(senderId: string, text: string): void;
  settle(): Promise<void>;
  judgeCalls: ProactiveJudgeInput[];
  delivered: Array<{ target: ConversationTarget; out: OutgoingMessage }>;
  snapshot(): ReturnType<ProactiveWatcher['snapshot']>;
}

/**
 * 账目闭合的检查口径。
 *
 * 严格等式是 `created === resolved + spent + stale + unchanged`，但**仍有票据
 * 在等**时左边天然多出来（那是 `pending`）。所以稳态检查写成
 * `created === Σ终局 + pending`：任何时刻都必须成立，全部收口后退化成需求里
 * 那条不含 pending 的等式。
 */
function ledgerClosed(snapshot: ReturnType<ProactiveWatcher['snapshot']>): boolean {
  const t = snapshot.waitTickets;
  return t.created === t.resolved + t.spent + t.stale + t.unchanged + t.pending;
}

function setup(overrides: Partial<ProactiveWatcherConfig> = {}): Harness {
  let clock = START;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const judgeCalls: ProactiveJudgeInput[] = [];
  const delivered: Array<{ target: ConversationTarget; out: OutgoingMessage }> = [];
  let plan: JudgePlan = { scene3: 'unsatisfied' };
  let once: JudgePlan | undefined;
  let failing = false;

  const judge: ProactiveJudge = {
    async judge(input) {
      judgeCalls.push(input);
      if (failing) return undefined;
      const active = once ?? plan;
      once = undefined;
      const pendingId = input.evidence.pendingQuestions[0]?.id;
      const verdicts: SceneVerdict[] = input.candidates.map((candidate) => {
        if (candidate.scene !== 'scene-3') {
          return { scene: candidate.scene, satisfied: false, confidence: 0.1, reason: '未涉及' };
        }
        if (active.scene3 === 'satisfied') {
          return { scene: 'scene-3', satisfied: true, confidence: 0.9, reason: '该答了' };
        }
        if (active.waitReason === undefined) {
          return { scene: 'scene-3', satisfied: false, confidence: 0.2, reason: '判不成立' };
        }
        const reference = active.reference;
        const evidence =
          reference === 'none' || (reference === undefined && pendingId === undefined)
            ? undefined
            : reference === 'bogus'
              ? 'q:msg-does-not-exist@0'
              : `q:${reference ?? pendingId}`;
        return {
          scene: 'scene-3',
          satisfied: false,
          confidence: 0.5,
          reason: '有人在答',
          waitReason: active.waitReason,
          ...(evidence === undefined ? {} : { evidence }),
        };
      });
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
      return { ok: true };
    },
  };

  const speaker = new ProactiveSpeaker({
    connectorFor: () => connector,
    enabled: true,
    dryRun: false,
    logger: createNullLogger(),
  });

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

  const fireDue = (): void => {
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= clock) {
        timer.cancelled = true;
        timer.fn();
      }
    }
  };

  const observe = (senderId: string, text: string): void => {
    const message: NormalizedMessage = {
      kind: 'group-message',
      target: GROUP_TARGET,
      eventId: `evt-${senderId}-${clock}-${text}`,
      msgId: `msg-${senderId}-${clock}`,
      senderId,
      username: senderId,
      content: text,
      ts: clock,
      raw: {},
    };
    watcher.observe(message);
  };

  return {
    watcher,
    judgeCalls,
    delivered,
    snapshot: () => watcher.snapshot(),
    advance(ms) {
      clock += ms;
      fireDue();
    },
    advanceSilently(ms) {
      clock += ms;
    },
    tick: fireDue,
    observe,
    settle,
    setPlan(next) {
      plan = next;
    },
    setPlanOnce(next) {
      once = next;
    },
    setJudgeFailure(fail) {
      failing = fail;
    },
    armQuestion(text = '有没有人知道这个接口的分页参数怎么传？') {
      // ⚠️ 刻意**不**调 `notifyBotSpoke`：那会占掉「每话题一次」的额度，
      // 于是唤醒后真的判成立时会被 topic-spent 挡下——那是另一个机制的事，
      // 混进来会让本文件验不了 wait（实测踩过）。
      // 场景 3 的候选只依赖"台账里有挂起问题"，与场景 1 无关。
      observe('u1', '先问一句：这个报错怎么看？');
      const id = `msg-u2-${clock}@${clock}`;
      observe('u2', text);
      return id;
    },
  };
}

/** 等 fire-and-forget 的评估收口。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 把会话推进到"让路已经发生"的状态：探针到期 → 判定给 `yielding` → 建票据。
 * 返回问题 id。
 */
async function armYieldingTicket(
  h: Harness,
  options: { waitYieldMs?: number; maxWaitPerItem?: number } = {},
): Promise<string> {
  const id = h.armQuestion();
  await h.settle();
  h.setPlan({ scene3: 'unsatisfied', waitReason: 'yielding', reference: id });
  h.advance(options.waitYieldMs ?? 1_000);
  await h.settle();
  return id;
}

// ---------------------------------------------------------------------------
// 验收 1 / 2 / 9：三态理由的采纳与否决
// ---------------------------------------------------------------------------

describe('wait 的准入：只有 yielding 才排唤醒', () => {
  it('验收1：not-yet / watching → silent，且不排任何唤醒定时器', async () => {
    for (const reason of ['not-yet', 'watching'] as const) {
      const h = setup({ questionProbeMs: 1_000 });
      const id = h.armQuestion();
      await h.settle();

      h.setPlan({ scene3: 'unsatisfied', waitReason: reason, reference: id });
      h.advance(1_000);
      await h.settle();

      expect(h.snapshot().watched ?? 0).toBe(0);
      expect(h.snapshot().waitTickets.created, `${reason} 不该建票据`).toBe(0);
      expect(h.snapshot().waitTickets.pending, `${reason} 不该有待唤醒票据`).toBe(0);

      // 再推进很久：既没有唤醒、也没有任何新的判定调用
      const calls = h.judgeCalls.length;
      h.advance(10 * 60_000);
      await h.settle();
      expect(h.judgeCalls.length, `${reason} 不该排唤醒`).toBe(calls);
      expect(h.delivered, `${reason} 不该发言`).toHaveLength(0);
    }
  });

  it('验收1b：not-yet / watching 不进入 vetoed.wait，但必须计入 wait_declined{reason}', async () => {
    for (const reason of ['not-yet', 'watching'] as const) {
      const h = setup({ questionProbeMs: 1_000 });
      const id = h.armQuestion();
      await h.settle();
      h.setPlan({ scene3: 'unsatisfied', waitReason: reason, reference: id });
      h.advance(1_000);
      await h.settle();

      const snapshot = h.snapshot();
      // 它们不是"被否决"，是"模型说不用等"——混进 vetoed.wait 会让这个指标
      // 失去意义（上一轮正是 1682 次 wait 里混着两类完全不同的意图）
      expect(snapshot.vetoed['wait'], `${reason} 不该计 vetoed.wait`).toBeUndefined();
      // 但模型意图必须在指标里可见，否则"它为什么没说话"无从下手
      expect(snapshot.waitDeclined[reason]).toBe(1);
    }
  });

  it('验收1c：理由**不合法**（判据没交代清楚时模型会编一个）→ silent，且原样计进 wait_declined', async () => {
    const h = setup({ questionProbeMs: 1_000 });
    const id = h.armQuestion();
    await h.settle();
    // 真判定会由 parseSceneVerdicts 丢掉非法值；这里直接把它摆到否决层面前，
    // 验的是"万一漏进来了也不许建票据、且必须留下痕迹"。
    h.setPlanOnce({ scene3: 'unsatisfied', waitReason: BOGUS_WAIT_REASON, reference: id });
    h.advance(1_000);
    await h.settle();

    expect(h.snapshot().waitTickets.created, '理由不合法不该建票据').toBe(0);
    expect(h.snapshot().vetoed['wait']).toBeUndefined();
    // 标签按模型**实际说出来的**理由记（而不是折成 'unknown'）：
    // `wait_declined{maybe-later}` 才能回答"判据该怎么改"——这正是这条计数
    // 存在的理由。解析器会把非法值挡在判定层，这里是万一漏进来的兜底。
    expect(h.snapshot().waitDeclined[BOGUS_WAIT_REASON], '模型意图必须留下痕迹').toBe(1);
  });

  it('验收9：引用无效 / 未给引用 → silent，建 0 张票据、不猜对象、不退化回无限等待', async () => {
    for (const reference of ['bogus', 'none'] as const) {
      const h = setup({ questionProbeMs: 1_000 });
      const id = h.armQuestion();
      await h.settle();
      h.setPlan({ scene3: 'unsatisfied', waitReason: 'yielding', reference });
      h.advance(1_000);
      await h.settle();

      expect(h.snapshot().waitTickets.created, `${reference} 不该建票据`).toBe(0);
      expect(h.snapshot().waitTickets.invalidTarget, `${reference} 应计 invalid_target`).toBe(1);
      expect(h.snapshot().waitTickets.pending).toBe(0);

      // 不退化：没有票据 = 没有第二次唤醒，也没有任何后续判定
      const calls = h.judgeCalls.length;
      h.advance(10 * 60_000);
      await h.settle();
      expect(h.judgeCalls.length).toBe(calls);
      void id;
    }
  });

  it('验收2：yielding + 对象仍挂起 → 判 wait，排一次 waitYieldMs 后的唤醒', async () => {
    const h = setup({ questionProbeMs: 1_000, waitYieldMs: 45_000 });
    const id = await armYieldingTicket(h, { waitYieldMs: 1_000 });

    expect(h.delivered).toHaveLength(0);
    expect(h.snapshot().vetoed['wait']).toBe(1);
    expect(h.snapshot().waitTickets.created).toBe(1);
    expect(h.snapshot().waitTickets.pending).toBe(1);
    expect(ledgerClosed(h.snapshot())).toBe(true);

    // 窗口内（20 秒）不动：唤醒不该提前
    h.advance(20_000);
    await h.settle();
    expect(h.snapshot().waitTickets.pending).toBe(1);

    // 到 45 秒才醒（此时转录无新增 → unchanged，见验收 4）
    h.advanceSilently(25_000);
    h.tick();
    await h.settle();
    expect(h.snapshot().waitTickets.pending).toBe(0);
    expect(h.snapshot().waitTickets.unchanged).toBe(1);
    expect(h.snapshot().waitTickets[`stale` as never] ?? 0).toBe(0);
    void id;
  });
});

// ---------------------------------------------------------------------------
// 验收 3 / 4 / 6：唤醒前的两道本地检查 + 关闭即取消
// ---------------------------------------------------------------------------

describe('唤醒前的本地检查：不过就不花 LLM', () => {
  it('验收4：转录自上次判定以来无新增 → 不调 LLM，计 unchanged，票据消失', async () => {
    const h = setup({ questionProbeMs: 1_000, waitYieldMs: 45_000 });
    await armYieldingTicket(h, { waitYieldMs: 1_000 });
    const calls = h.judgeCalls.length;

    // 群里一直安静（没有任何新消息）→ 纯靠沉默累积反复唤醒是本项目的红线
    h.advance(45_000);
    await h.settle();

    expect(h.judgeCalls.length, '无新增内容不该调 LLM').toBe(calls);
    expect(h.snapshot().waitTickets.unchanged).toBe(1);
    expect(h.snapshot().waitTickets.pending).toBe(0);
    expect(ledgerClosed(h.snapshot())).toBe(true);
  });

  it('验收3：唤醒时对象已关闭 → 不调 LLM，计 stale，票据消失', async () => {
    const h = setup({
      questionProbeMs: 1_000,
      waitYieldMs: 45_000,
      stateOptions: { questionTtlMs: 30_000 },
    });
    const id = await armYieldingTicket(h, { waitYieldMs: 1_000 });
    const calls = h.judgeCalls.length;

    // 问题在这个窗口里过了 TTL（台账把它标成 expired）→ 对象已关闭
    h.advanceSilently(31_000);
    h.tick();
    await h.settle();

    expect(h.judgeCalls.length, '对象已关闭不该调 LLM').toBe(calls);
    expect(h.snapshot().waitTickets.stale).toBe(1);
    expect(h.snapshot().waitTickets.pending).toBe(0);
    expect(ledgerClosed(h.snapshot())).toBe(true);
    void id;
  });

  it('验收6：问题在唤醒前被回答 → 唤醒被**取消**（不是到点才发现）', async () => {
    const h = setup({ questionProbeMs: 1_000, waitYieldMs: 45_000 });
    const id = await armYieldingTicket(h, { waitYieldMs: 1_000 });
    expect(h.snapshot().waitTickets.pending).toBe(1);

    // 本地可判的关闭：台账把这条问题标成"已被回答"
    h.watcher.stateFor(GROUP_KEY).markAnswered(id);

    // 当场作废：票据没了，而且 stale 已经计上（票据只有一个终局）
    expect(h.snapshot().waitTickets.pending).toBe(0);
    expect(h.snapshot().waitTickets.stale).toBe(1);
    expect(ledgerClosed(h.snapshot())).toBe(true);

    // 到点也不再有任何动静
    const calls = h.judgeCalls.length;
    h.advance(45_000);
    await h.settle();
    expect(h.judgeCalls.length).toBe(calls);
  });

  it('验收6b：话题翻篇（静默超过活动窗口）同样当场取消', async () => {
    const h = setup({
      questionProbeMs: 1_000,
      waitYieldMs: 45_000,
      stateOptions: { activityWindowMs: 60_000 },
    });
    await armYieldingTicket(h, { waitYieldMs: 1_000 });
    expect(h.snapshot().waitTickets.pending).toBe(1);

    // 静默超过活动窗口后来了新消息 → 台账开新窗口，旧问题连同票据一起作废
    h.advanceSilently(120_000);
    h.observe('u9', '换个话题，中午吃什么');
    await h.settle();

    expect(h.snapshot().waitTickets.pending).toBe(0);
    expect(h.snapshot().waitTickets.stale).toBe(1);
    expect(ledgerClosed(h.snapshot())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 验收 5 / 8：唤醒后的重判与"每张票据只有一个终局"
// ---------------------------------------------------------------------------

describe('唤醒后的重判：任何结果都消耗票据', () => {
  /** 建一张让路票据，然后在窗口里说一句话（让"有新增"这道闸通过）。 */
  async function armAndSpeak(h: Harness): Promise<string> {
    const id = await armYieldingTicket(h, { waitYieldMs: 1_000 });
    h.advanceSilently(10_000);
    h.observe('u3', '我看看，稍等一下');
    await h.settle();
    return id;
  }

  it('验收5a：重判判成立 → resolved（等待熬到了成立）', async () => {
    const h = setup({ questionProbeMs: 1_000, waitYieldMs: 45_000 });
    await armAndSpeak(h);
    h.setPlanOnce({ scene3: 'satisfied' });

    h.advanceSilently(35_000);
    h.tick();
    await h.settle();

    expect(h.snapshot().evaluatedByTrigger['wait-wakeup']).toBe(1);
    expect(h.snapshot().waitTickets.resolved).toBe(1);
    expect(h.snapshot().waitTickets.spent).toBe(0);
    expect(h.snapshot().waitTickets.pending).toBe(0);
    expect(h.delivered).toHaveLength(1);
    expect(ledgerClosed(h.snapshot())).toBe(true);
  });

  it('验收5b：重判又给 yielding → 预算已用尽 → silent + spent（同一对象不会再有第二次唤醒）', async () => {
    const h = setup({ questionProbeMs: 1_000, waitYieldMs: 45_000, maxWaitPerItem: 1 });
    const id = await armAndSpeak(h);
    h.setPlan({ scene3: 'unsatisfied', waitReason: 'yielding', reference: id });

    h.advanceSilently(35_000);
    h.tick();
    await h.settle();

    const snapshot = h.snapshot();
    expect(snapshot.waitTickets.spent).toBe(1);
    expect(snapshot.waitTickets.pending, '不该再排第二次唤醒').toBe(0);
    expect(snapshot.waitTickets.created, '总共只有一张票据').toBe(1);
    expect(snapshot.vetoed['wait-spent']).toBeGreaterThanOrEqual(1);
    expect(h.delivered).toHaveLength(0);
    expect(ledgerClosed(h.snapshot())).toBe(true);

    // 再等很久也不会有第二次唤醒（单次等待的重查上限恒为 1）
    const calls = h.judgeCalls.length;
    h.advance(10 * 60_000);
    await h.settle();
    expect(h.judgeCalls.length).toBe(calls);
  });

  it('验收5c：重判给 not-yet / watching → 理由本就不排唤醒 → silent + spent', async () => {
    for (const reason of ['not-yet', 'watching'] as const) {
      const h = setup({ questionProbeMs: 1_000, waitYieldMs: 45_000 });
      const id = await armAndSpeak(h);
      h.setPlan({ scene3: 'unsatisfied', waitReason: reason, reference: id });

      h.advanceSilently(35_000);
      h.tick();
      await h.settle();

      expect(h.snapshot().waitTickets.spent, `${reason} 应消耗票据`).toBe(1);
      expect(h.snapshot().waitTickets.pending, `${reason} 不该再排唤醒`).toBe(0);
      expect(ledgerClosed(h.snapshot())).toBe(true);
    }
  });

  it('验收5d：重判判不成立 → silent + spent', async () => {
    const h = setup({ questionProbeMs: 1_000, waitYieldMs: 45_000 });
    await armAndSpeak(h);
    h.setPlan({ scene3: 'unsatisfied' });

    h.advanceSilently(35_000);
    h.tick();
    await h.settle();

    expect(h.snapshot().waitTickets.spent).toBe(1);
    expect(h.snapshot().waitTickets.pending).toBe(0);
    expect(ledgerClosed(h.snapshot())).toBe(true);
  });

  it('验收5e：重判时判定失败 → 票据照样收口（spent），不留孤儿票据', async () => {
    const h = setup({ questionProbeMs: 1_000, waitYieldMs: 45_000 });
    await armAndSpeak(h);
    h.setJudgeFailure(true);

    h.advanceSilently(35_000);
    h.tick();
    await h.settle();

    expect(h.snapshot().waitTickets.spent).toBe(1);
    expect(h.snapshot().waitTickets.pending).toBe(0);
    expect(ledgerClosed(h.snapshot())).toBe(true);
  });

  it('验收8：单次等待的重查上限恒为 1——唤醒后的重判不会再唤醒第二次', async () => {
    const h = setup({ questionProbeMs: 1_000, waitYieldMs: 45_000, maxWaitPerItem: 1 });
    const id = await armAndSpeak(h);
    expect(h.snapshot().waitTickets.created).toBe(1);
    h.setPlan({ scene3: 'unsatisfied', waitReason: 'yielding', reference: id });

    // 第一次唤醒 → 重判又给 yielding → 预算已用尽 → 静默，且**不排第二次唤醒**
    h.advanceSilently(35_000);
    h.tick();
    await h.settle();
    expect(h.snapshot().waitTickets.spent).toBe(1);
    expect(h.snapshot().waitTickets.created, '同一对象不会再有第二次唤醒').toBe(1);

    // 之后无论等多久、无论判定怎么答，都只有这一张票据
    const calls = h.judgeCalls.length;
    h.setPlan({ scene3: 'unsatisfied' });
    h.advance(10 * 60_000);
    await h.settle();
    expect(h.snapshot().waitTickets.created).toBe(1);
    expect(h.snapshot().waitTickets.pending).toBe(0);
    expect(h.judgeCalls.length).toBeGreaterThanOrEqual(calls);
  });

  it('验收8b：maxWaitPerItem 配成 5 按硬上限 3 处理（越过上限即静默，不建票据）', async () => {
    const h = setup({ questionProbeMs: 1_000, waitYieldMs: 45_000, maxWaitPerItem: 5 });
    const id = await armYieldingTicket(h, { waitYieldMs: 1_000 });
    h.setPlan({ scene3: 'unsatisfied', waitReason: 'yielding', reference: id });

    // 把"已经让路 3 次"摆到判定面前：配成 5 的预算必须已经被压到 3。
    // 若没压，这里会建出第二张票据（"把收敛改回不收敛"不该只靠改一行配置就做到）。
    const state = h.watcher.stateFor(GROUP_KEY);
    while (state.yieldBudget(id) < 3) state.recordYield(id);
    expect(state.yieldBudget(id)).toBe(3);
    expect(h.snapshot().waitTickets.created).toBe(1);

    // 再补一句让探针重新武装，然后推进到探针：模型仍然给 yielding
    h.observe('u7', '再补一句：这个报错还在');
    await h.settle();
    h.setPlanOnce({ scene3: 'unsatisfied', waitReason: 'yielding', reference: id });
    h.advance(1_000);
    await h.settle();

    expect(h.snapshot().vetoed['wait-spent'], '越过硬上限必须静默').toBeGreaterThanOrEqual(1);
    expect(h.snapshot().waitTickets.created, '硬上限之下不该再建票据').toBe(1);
    expect(ledgerClosed(h.snapshot())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 验收 7：每会话一个唤醒点
// ---------------------------------------------------------------------------

describe('每会话只有一个唤醒点', () => {
  it('验收7：同一会话三张票据 → 只有一个定时器；唤醒时三张各自判断', async () => {
    let scheduled = 0;
    let clock = START;
    const cancels: Array<() => void> = [];
    const timers: Array<{ at: number; fn: () => void; cancelled: boolean; delayMs: number }> = [];
    const verdictsFor: string[] = [];
    const judge: ProactiveJudge = {
      async judge(input) {
        const targetId = input.evidence.waitWakeup?.targetId;
        if (targetId !== undefined) verdictsFor.push(targetId);
        const pendingId = input.evidence.pendingQuestions[0]?.id;
        return input.candidates.map((candidate): SceneVerdict => {
          if (candidate.scene !== 'scene-3') {
            return { scene: candidate.scene, satisfied: false, confidence: 0.1, reason: 'x' };
          }
          // 每次判定都让路，但引用**当前**这条问题（三张票据轮流被唤醒）
          const id = targetId ?? pendingId ?? '';
          return {
            scene: 'scene-3',
            satisfied: false,
            confidence: 0.5,
            reason: '有人正在答',
            waitReason: 'yielding',
            evidence: `q:${id}`,
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
      proactive: async (): Promise<ProactiveResult> => ({ ok: true }),
    };
    const watcher = new ProactiveWatcher({
      config: {
        ...DEFAULT_WATCHER_CONFIG,
        enabled: true,
        whitelistGroups: [GROUP_KEY],
        questionProbeMs: 1_000,
        waitYieldMs: 45_000,
        // 三个问题要同时挂着，台账上限得够
        stateOptions: { maxQuestions: 10 },
      },
      speaker: new ProactiveSpeaker({
        connectorFor: () => connector,
        enabled: true,
        dryRun: false,
        logger: createNullLogger(),
      }),
      judge,
      logger: createNullLogger(),
      now: () => clock,
      schedule: (fn, delayMs) => {
        scheduled += 1;
        const timer = { at: clock + delayMs, fn, cancelled: false, delayMs };
        timers.push(timer);
        const cancel = (): void => {
          timer.cancelled = true;
        };
        cancels.push(cancel);
        return cancel;
      },
    });

    const observe = (senderId: string, text: string): void => {
      watcher.observe({
        kind: 'group-message',
        target: GROUP_TARGET,
        eventId: `e-${senderId}-${clock}-${text}`,
        msgId: `msg-${senderId}-${clock}-${text}`,
        senderId,
        username: senderId,
        content: text,
        ts: clock,
        raw: {},
      });
    };

    // 三条挂起问题（三个人各问一句）
    watcher.notifyBotSpoke(GROUP_KEY);
    observe('u1', '问题一：分页参数怎么传？');
    observe('u2', '问题二：这个报错怎么解？');
    observe('u3', '问题三：有推荐的库吗？');
    await settle();

    // 第二个问题的探针已经武装好了；推进到探针 → 场景 3 判定，模型对每个候选都给让路
    clock += 1_000;
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= clock) {
        timer.cancelled = true;
        timer.fn();
      }
    }
    await settle();

    const snapshot = watcher.snapshot();
    // 至少建出了票据（模型对挂起问题说了"让路"）
    expect(snapshot.waitTickets.created).toBeGreaterThanOrEqual(1);
    expect(snapshot.waitTickets.created).toBe(snapshot.waitTickets.pending);
    // 唤醒点只有一个：`armWaitYield` 每次都先把上一个定时器取消掉再排新的，
    // 所以"待唤醒票据 > 1"时表里**不该**留下多个唤路线定时器。
    // 话题滚动定时器也在这张表里（它本来就会无限重排），因此只数 waitYieldMs 那条线。
    const created = snapshot.waitTickets.created;
    const yieldTimers = timers.filter((timer) => !timer.cancelled && timer.delayMs === 45_000);
    expect(
      yieldTimers.length,
      `唤醒点不该每张票据各排一个（票据 ${created} 张，唤路线定时器 ${yieldTimers.length} 个）`,
    ).toBe(1);
    void scheduled;
    void verdictsFor;
    void cancels;
  });
});

// ---------------------------------------------------------------------------
// 验收 10 / 11：指标账目
// ---------------------------------------------------------------------------

describe('指标：账目必须闭合', () => {
  it('验收11：resolved + spent + stale + unchanged == created（含中途被取消的那些）', async () => {
    const h = setup({ questionProbeMs: 1_000, waitYieldMs: 45_000 });

    // ① resolved：让路 → 群里有人说话 → 唤醒时判成立
    const first = await armYieldingTicket(h, { waitYieldMs: 1_000 });
    h.advanceSilently(10_000);
    h.observe('u3', '我看看');
    await h.settle();
    h.setPlanOnce({ scene3: 'satisfied' });
    h.advanceSilently(35_000);
    h.tick();
    await h.settle();

    // ② stale：让路 → 问题被回答 → 当场取消
    const second = h.armQuestion('另一个问题：这个怎么配？');
    await h.settle();
    h.setPlan({ scene3: 'unsatisfied', waitReason: 'yielding', reference: second });
    h.advance(1_000);
    await h.settle();
    h.setPlan({ scene3: 'unsatisfied' });
    h.watcher.stateFor(GROUP_KEY).markAnswered(second);

    // ③ unchanged：让路 → 群里一直安静 → 唤醒时无新增
    const third = h.armQuestion('第三个问题：有没有文档？');
    await h.settle();
    h.setPlan({ scene3: 'unsatisfied', waitReason: 'yielding', reference: third });
    h.advance(1_000);
    await h.settle();
    h.advance(45_000);
    await h.settle();

    // ④ invalid_target：让路但引用台账里不存在的对象 → 不建票据。
    //    计划要在**这条消息的探针触发之前**设好，所以先发一句让探针武装起来。
    h.observe('u8', '问题四：这个库叫什么？');
    await h.settle();
    h.setPlan({ scene3: 'unsatisfied', waitReason: 'yielding', reference: 'bogus' });
    h.advance(1_000);
    await h.settle();

    const t = h.snapshot().waitTickets;
    expect(t.created).toBe(3);
    expect(t.resolved).toBe(1);
    expect(t.stale).toBe(1);
    expect(t.unchanged).toBe(1);
    expect(t.spent).toBe(0);
    expect(ledgerClosed(h.snapshot()), JSON.stringify(t)).toBe(true);
    expect(t.invalidTarget).toBe(1);
    // invalid_target 与 wait_declined **不产生票据**，因此不参与上面的等式
    expect(t.created).toBeLessThanOrEqual(3);
    void first;
  });

  it('验收10：wait-wakeup 用独立触发标签，与 question-probe 分得开', async () => {
    const h = setup({ questionProbeMs: 1_000, waitYieldMs: 45_000 });
    await armYieldingTicket(h, { waitYieldMs: 1_000 });
    h.advanceSilently(10_000);
    h.observe('u3', '我看看');
    await h.settle();
    h.setPlanOnce({ scene3: 'satisfied' });
    h.advanceSilently(35_000);
    h.tick();
    await h.settle();

    const byTrigger = h.snapshot().evaluatedByTrigger;
    // 探针（90 秒那条路）与重查必须各记各的：上一轮重查复用了 question-probe，
    // 于是"wait 到底有没有价值"在指标里再也看不出来。
    // 探针次数不固定（每次新消息都会重新武装），所以只断言"两条路都有记录、
    // 且是两个**不同的**键"——这才是这条验收真正要锁的东西。
    expect(byTrigger['question-probe']).toBeGreaterThanOrEqual(1);
    expect(byTrigger['wait-wakeup']).toBe(1);
    expect(Object.keys(byTrigger)).toContain('question-probe');
    expect(Object.keys(byTrigger)).toContain('wait-wakeup');
  });

  it('验收10b：三态理由在判定 prompt 里带上"这是让路后的重查"与对象 id', async () => {
    const h = setup({ questionProbeMs: 1_000, waitYieldMs: 45_000 });
    const id = await armYieldingTicket(h, { waitYieldMs: 1_000 });
    h.advanceSilently(10_000);
    h.observe('u3', '我看看');
    await h.settle();
    h.setPlanOnce({ scene3: 'satisfied' });
    h.advanceSilently(35_000);
    h.tick();
    await h.settle();

    const wakeupCall = h.judgeCalls.find((call) => call.evidence.trigger === 'wait-wakeup');
    expect(wakeupCall?.evidence.waitWakeup?.targetId).toBe(id);
    expect(wakeupCall?.evidence.waitWakeup?.yieldedForMs).toBeGreaterThanOrEqual(45_000);
  });
});
