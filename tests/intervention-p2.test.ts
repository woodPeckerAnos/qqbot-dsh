/**
 * Phase 2 端到端：intake → evaluate → speak 全链路调度。
 * 注入手动时钟（now + schedule）与 fake gate/speak，全程离线。
 */

import { describe, expect, it } from 'vitest';

import type { ConversationTarget, NormalizedMessage, NormalizedObservedMessage } from '../src/core/connector.js';
import type { GateClient, GateVerdict } from '../src/intervention/contract.js';
import { RULE_REGISTRY } from '../src/intervention/rules/index.js';
import { TopicWatcher, type InterventionConfig } from '../src/intervention/watcher.js';
import { createNullLogger } from '../src/logger.js';
import { PipelineStats } from '../src/pipeline/stats.js';

const T0 = 1_800_000_000_000;
const TARGET: ConversationTarget = { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' };
const settle = async (): Promise<void> => {
  // 链是一长串 await（13 层 intake + evaluate + speak），微任务可能几十拍；
  // setImmediate 每拍都会先排空微任务队列，几拍必收敛。
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

interface ScheduledTask {
  fn: () => void;
  delayMs: number;
  cancelled: boolean;
}

function makeConfig(overrides: Partial<InterventionConfig> = {}): InterventionConfig {
  return {
    enabled: true,
    dryRun: false,
    whitelistGroups: ['onebot:123'],
    buffer: { maxMessages: 200, maxAgeMs: 72 * 3600 * 1000 },
    gate: { apiBase: '', model: 'stub', timeoutMs: 1000, maxConcurrent: 2 },
    rules: {},
    ...overrides,
  };
}

function makeWatcher(opts: {
  config?: InterventionConfig;
  verdicts?: GateVerdict[]; // 每次 judge 按序出队；耗尽后按最后一个
  speakOk?: boolean;
  offpeakNow?: boolean;
  admissionFree?: boolean;
  withGate?: boolean;
  withSpeak?: boolean;
} = {}) {
  let now = T0;
  const stats = new PipelineStats();
  const tasks: ScheduledTask[] = [];
  const judgeCalls: Array<{ transcript: string; stateSummary: string }> = [];
  const verdicts = [...(opts.verdicts ?? [{ decision: 'silent', reason: '闲聊' } as GateVerdict])];
  const gate: GateClient = {
    judge: async (input) => {
      judgeCalls.push({ transcript: input.transcript, stateSummary: input.stateSummary });
      return verdicts.length > 1 ? verdicts.shift()! : verdicts[0]!;
    },
  };
  const spoken: NormalizedMessage[] = [];
  const watcher = new TopicWatcher({
    config: opts.config ?? makeConfig(),
    rules: RULE_REGISTRY,
    stats,
    logger: createNullLogger(),
    now: () => now,
    schedule: (fn, delayMs) => {
      const task: ScheduledTask = { fn, delayMs, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    ...(opts.withGate === false ? {} : { gate }),
    ...(opts.withSpeak === false
      ? {}
      : {
          speak: async (m: NormalizedMessage) => {
            spoken.push(m);
            return opts.speakOk ?? true;
          },
        }),
    ...(opts.offpeakNow !== undefined ? { offpeakNow: () => opts.offpeakNow! } : {}),
    ...(opts.admissionFree !== undefined ? { admissionFree: () => opts.admissionFree! } : {}),
  });
  return {
    watcher,
    stats,
    judgeCalls,
    spoken,
    tasks,
    advance: (ms: number) => {
      now += ms;
    },
    /** 触发未取消的定时任务（手动时钟；可按时延过滤以隔离特定定时器） */
    fireTimers: (filter?: (task: ScheduledTask) => boolean) => {
      const remaining: ScheduledTask[] = [];
      for (const task of tasks.splice(0)) {
        if (!task.cancelled && (filter === undefined || filter(task))) task.fn();
        else remaining.push(task);
      }
      tasks.push(...remaining);
    },
  };
}

let seq = 0;
function makeMsg(overrides: Partial<NormalizedObservedMessage> = {}): NormalizedObservedMessage {
  seq += 1;
  return {
    kind: 'group-message-observed',
    target: TARGET,
    eventId: `ob11:1000:${seq}`,
    msgId: String(seq),
    senderId: '8888',
    username: '小明',
    content: '接着聊',
    ts: T0 + seq, // 每条晚 1ms：答案窗口的「其后有应答」判定依赖严格时序
    raw: {},
    ...overrides,
  };
}

describe('Phase 2：intake → evaluate → speak 全链路', () => {
  it('强信号 → 立即评估 → Gate speak → 合成介入 turn 投递（相位 cold→focus）', async () => {
    const { watcher, stats, judgeCalls, spoken } = makeWatcher({
      verdicts: [{ decision: 'speak', reason: '无人回答' }],
    });
    // bot 刚发言过 → 09 号规则给下一条消息标强信号（立即评估路径）
    watcher.notifyBotSpoke(TARGET.key, '这是 bot 刚才的回答');
    watcher.observe(makeMsg({ content: '原来如此，受教了' }));
    await settle();

    expect(judgeCalls).toHaveLength(1);
    expect(judgeCalls[0]!.transcript).toContain('<群聊转录');
    expect(judgeCalls[0]!.transcript).toContain('原来如此，受教了');
    expect(judgeCalls[0]!.stateSummary).toContain('<bot状态>');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ kind: 'group-at-message', origin: 'intervention' });
    expect(spoken[0]!.content).toContain('自主介入，不是用户委托的任务');
    expect(stats.gateCalls).toBe(1);
    expect(stats.interventionsSent).toBe(1);
    expect(watcher.snapshot().conversations[0]?.phase).toBe('focus');
  });

  it('Gate silent → 不发言，拦截计数记账', async () => {
    const { watcher, stats, spoken } = makeWatcher({
      verdicts: [{ decision: 'silent', reason: '闲聊' }],
    });
    watcher.notifyBotSpoke(TARGET.key, '刚才的回答');
    watcher.observe(makeMsg());
    await settle();
    expect(spoken).toHaveLength(0);
    expect(stats.gateCalls).toBe(1);
    expect(stats.interventionsSent).toBe(0);
    expect(watcher.snapshot().halts['semantic-gate']).toBe(1);
  });

  it('Gate wait → 30s 后重查一次；再 wait → 放弃', async () => {
    const { watcher, stats, judgeCalls, spoken, advance, fireTimers } = makeWatcher({
      verdicts: [
        { decision: 'wait', reason: '展开中' },
        { decision: 'wait', reason: '还在展开' },
      ],
    });
    watcher.notifyBotSpoke(TARGET.key, '刚才的回答');
    watcher.observe(makeMsg());
    await settle();
    expect(judgeCalls).toHaveLength(1);

    advance(30_000);
    fireTimers(); // gate-wait 重查
    await settle();
    expect(judgeCalls).toHaveLength(2);
    expect(spoken).toHaveLength(0); // 第二次仍 wait → halt(gate-wait-twice)
    expect(stats.interventionsSent).toBe(0);
  });

  it('采样达标（≥6 条）→ 无强信号也评估', async () => {
    const { watcher, judgeCalls } = makeWatcher({
      verdicts: [{ decision: 'silent', reason: '闲聊' }],
    });
    // 逐条 settle：observe 的链是异步的，并发灌入会让采样计数产生竞态
    for (let i = 0; i < 7; i += 1) {
      watcher.observe(makeMsg({ senderId: `u${i}` }));
      await settle();
    }
    expect(judgeCalls).toHaveLength(1); // 第 7 条到达时缓冲已有 6 条 → 触发采样评估
  });

  it('普通消息只入缓冲，静默 20s 后去抖评估', async () => {
    const { watcher, judgeCalls, fireTimers } = makeWatcher({
      verdicts: [{ decision: 'silent', reason: '闲聊' }],
    });
    watcher.observe(makeMsg());
    await settle();
    expect(judgeCalls).toHaveLength(0); // 未评估
    fireTimers(); // 去抖定时器到期
    await settle();
    expect(judgeCalls).toHaveLength(1);
  });

  it('开放问句：defer 90s；无人应答 → 重查标强信号进评估', async () => {
    const { watcher, judgeCalls, advance, fireTimers } = makeWatcher({
      verdicts: [{ decision: 'silent', reason: 'bot 也答不上' }],
    });
    watcher.observe(makeMsg({ content: '这个怎么部署？', senderId: 'asker' }));
    await settle();
    expect(judgeCalls).toHaveLength(0); // 挂答案窗口，未评估

    advance(90_000);
    fireTimers(); // 答案窗口到期重查
    await settle();
    expect(judgeCalls).toHaveLength(1);
  });

  it('开放问句：窗口内有人应答 → 重查作废不评估', async () => {
    const { watcher, judgeCalls, advance, fireTimers } = makeWatcher();
    watcher.observe(makeMsg({ content: '这个怎么部署？', senderId: 'asker' }));
    await settle();
    // 窗口内另一个人应答（普通消息，入缓冲）
    watcher.observe(makeMsg({ content: '看这个文档就行', senderId: 'helper' }));
    await settle();
    advance(90_000);
    fireTimers((t) => t.delayMs === 90_000); // 只触发答案窗口，隔离去抖评估
    await settle();
    expect(judgeCalls).toHaveLength(0);
    expect(watcher.snapshot().halts['strong-open-question']).toBe(1); // answered
  });

  it('@ 别人的消息：入缓冲做上下文但不评估（halt buffer:true）', async () => {
    const { watcher, judgeCalls } = makeWatcher();
    watcher.observe(makeMsg({ atOthers: true, content: '@小红 你看' }));
    await settle();
    expect(judgeCalls).toHaveLength(0);
    expect(watcher.snapshot().conversations[0]?.buffered).toBe(1);
  });

  it('dryRun：判定应发言但不投递', async () => {
    const { watcher, stats, spoken } = makeWatcher({
      config: makeConfig({ dryRun: true }),
      verdicts: [{ decision: 'speak', reason: '无人回答' }],
    });
    watcher.notifyBotSpoke(TARGET.key, '刚才的回答');
    watcher.observe(makeMsg());
    await settle();
    expect(spoken).toHaveLength(0);
    expect(stats.interventionsDryRun).toBe(1);
    expect(stats.interventionsSent).toBe(0);
  });

  it('准入 try 被拒（投递口返回 false）→ 放弃计数，绝不排队', async () => {
    const { watcher, stats, spoken } = makeWatcher({
      verdicts: [{ decision: 'speak', reason: '无人回答' }],
      speakOk: false,
    });
    watcher.notifyBotSpoke(TARGET.key, '刚才的回答');
    watcher.observe(makeMsg());
    await settle();
    expect(spoken).toHaveLength(1); // 投递口被调用了
    expect(stats.interventionsSent).toBe(0);
    expect(stats.interventionsDroppedBusy).toBe(1);
  });

  it('相位联动：两次介入后降 FADING，fading 内 31 号规则否决发言', async () => {
    const { watcher, stats, spoken, advance } = makeWatcher({
      verdicts: [{ decision: 'speak', reason: '该说' }],
    });
    watcher.notifyBotSpoke(TARGET.key, '刚才的回答');
    // 第一次介入（cold → focus）
    watcher.observe(makeMsg({ content: '接着说一' }));
    await settle();
    advance(20_000); // 越过强信号冷却（15s）
    // 第二次介入（focus，第 2 次满额 → fading）
    watcher.notifyBotSpoke(TARGET.key, '第一次介入的回答');
    watcher.observe(makeMsg({ content: '接着说二' }));
    await settle();
    expect(stats.interventionsSent).toBe(2);
    expect(watcher.snapshot().conversations[0]?.phase).toBe('fading');

    // 第三次：Gate 仍判 speak，但 speak 链 31 号否决
    advance(20_000);
    watcher.notifyBotSpoke(TARGET.key, '第二次介入的回答');
    watcher.observe(makeMsg({ content: '接着说三' }));
    await settle();
    expect(stats.interventionsSent).toBe(2);
    expect(watcher.snapshot().halts['focus-budget']).toBe(1);
  });

  it('硬限流：10 分钟 3 次介入后，07 号预检直接拦掉评估（省 Gate 成本）', async () => {
    const { watcher, stats, judgeCalls, advance } = makeWatcher({
      verdicts: [{ decision: 'speak', reason: '该说' }],
      config: makeConfig({
        rules: { 'focus-budget': { params: { focusMaxReplies: 99 } } }, // 摘掉相位预算，单独看限流
      }),
    });
    watcher.notifyBotSpoke(TARGET.key, '刚才的回答');
    for (let i = 0; i < 3; i += 1) {
      if (i > 0) advance(20_000); // 越过强信号冷却
      watcher.notifyBotSpoke(TARGET.key, `第 ${i} 次回答`);
      watcher.observe(makeMsg({ content: `第 ${i + 1} 次该介入的话题` }));
      await settle();
    }
    expect(stats.interventionsSent).toBe(3);

    // 第 4 次：intake 07 号规则拦截，Gate 根本不被调用
    const callsBefore = judgeCalls.length;
    advance(20_000);
    watcher.notifyBotSpoke(TARGET.key, '第 3 次回答');
    watcher.observe(makeMsg({ content: '第 4 次话题' }));
    await settle();
    expect(judgeCalls).toHaveLength(callsBefore);
    expect(watcher.snapshot().halts['rate-limit-precheck']).toBe(1);
    // 相位被强制降 fading（迁移表联动）
    expect(watcher.snapshot().conversations[0]?.phase).toBe('fading');
  });

  it('正价时段：03 号规则拦截评估（offpeakNow=false）', async () => {
    const { watcher, judgeCalls } = makeWatcher({
      verdicts: [{ decision: 'speak', reason: '该说' }],
      offpeakNow: false,
    });
    watcher.notifyBotSpoke(TARGET.key, '刚才的回答');
    watcher.observe(makeMsg());
    await settle();
    expect(judgeCalls).toHaveLength(0);
    expect(watcher.snapshot().halts['offpeak-window']).toBe(1);
  });

  it('未装配 gate → 20 号规则 fail-closed（gate-unavailable），不发言', async () => {
    const { watcher, stats, spoken } = makeWatcher({ withGate: false });
    watcher.notifyBotSpoke(TARGET.key, '刚才的回答');
    watcher.observe(makeMsg());
    await settle();
    expect(spoken).toHaveLength(0);
    expect(stats.interventionsSent).toBe(0);
    expect(watcher.snapshot().halts['semantic-gate']).toBe(1); // gate-unavailable
  });
});

// ---------------------------------------------------------------------------
// AdmissionGate try 语义（方案 §9.5：介入绝不排队）
// ---------------------------------------------------------------------------

import { AdmissionGate } from '../src/pipeline/ingress/admission.js';

describe('AdmissionGate.tryRunExclusive（介入绝不排队）', () => {
  it('名额与锁都空闲 → 执行并返回 true', async () => {
    const gate = new AdmissionGate({ maxConcurrentTurns: 1, stats: new PipelineStats() });
    let ran = false;
    const ok = await gate.tryRunExclusive('k1', async () => {
      ran = true;
    });
    expect(ok).toBe(true);
    expect(ran).toBe(true);
  });

  it('会话锁被占 → 立即 false，fn 不执行（不排队）', async () => {
    const gate = new AdmissionGate({ maxConcurrentTurns: 2, stats: new PipelineStats() });
    let releaseFirst!: () => void;
    const first = gate.tryRunExclusive(
      'k1',
      () => new Promise<void>((resolve) => (releaseFirst = resolve)),
    );
    await new Promise((r) => setImmediate(r)); // 让 first 的 fn 真正起跑（拿到锁）
    let secondRan = false;
    const second = await gate.tryRunExclusive('k1', async () => {
      secondRan = true;
    });
    expect(second).toBe(false);
    expect(secondRan).toBe(false);
    releaseFirst();
    expect(await first).toBe(true);
  });

  it('全局并发满 → 立即 false（即使别的会话空闲）', async () => {
    const gate = new AdmissionGate({ maxConcurrentTurns: 1, stats: new PipelineStats() });
    let releaseFirst!: () => void;
    const first = gate.tryRunExclusive(
      'k1',
      () => new Promise<void>((resolve) => (releaseFirst = resolve)),
    );
    await new Promise((r) => setImmediate(r)); // 让 first 先占住全局名额
    const second = await gate.tryRunExclusive('k2', async () => {});
    expect(second).toBe(false);
    releaseFirst();
    expect(await first).toBe(true);
  });

  it('fn 抛错被吸收（记 failed 计数，不外抛）', async () => {
    const stats = new PipelineStats();
    const gate = new AdmissionGate({ maxConcurrentTurns: 1, stats });
    const ok = await gate.tryRunExclusive('k1', async () => {
      throw new Error('boom');
    });
    expect(ok).toBe(true); // 名额与锁确实拿到了
    expect(stats.failed).toBe(1);
  });
});
