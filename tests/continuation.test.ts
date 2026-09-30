/**
 * Phase 1 续聊（continuation 链）端到端测试：
 *   watcher 级——开窗/晋升/窗口重置/在途合并/冲刷/容量与保鲜纪律；
 *   编排级——晋升消息回投 handleEvent 后走完整 Ingress 管线（含真 offpeak 闸）。
 * 全程离线（注入时钟 + fake promoter/terminal，不触网、不起 DSH）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  BotConnector,
  ConversationTarget,
  NormalizedMessage,
  NormalizedObservedMessage,
  ReplyPolicy,
} from '../src/core/connector.js';
import { RULE_REGISTRY } from '../src/intervention/rules/index.js';
import { TopicWatcher, type InterventionConfig } from '../src/intervention/watcher.js';
import { createNullLogger } from '../src/logger.js';
import { OffpeakGate, type OffpeakGateConfig } from '../src/offpeak/index.js';
import { createOffpeakGateStage } from '../src/pipeline/ingress/offpeak-gate.js';
import type { IngressStage, MessageContext } from '../src/pipeline/ingress/types.js';
import type { Responder } from '../src/pipeline/egress/responder.js';
import { Orchestrator } from '../src/pipeline/orchestrator.js';
import { PipelineStats } from '../src/pipeline/stats.js';

const T0 = 1_800_000_000_000;
const TARGET: ConversationTarget = { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' };

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function makeConfig(overrides: Partial<InterventionConfig> = {}): InterventionConfig {
  return {
    enabled: true,
    dryRun: false,
    whitelistGroups: ['onebot:123'],
    buffer: { maxMessages: 200, maxAgeMs: 72 * 3600 * 1000 },
    rules: {},
    ...overrides,
  };
}

let msgSeq = 0;
function makeObserved(overrides: Partial<NormalizedObservedMessage> = {}): NormalizedObservedMessage {
  msgSeq += 1;
  return {
    kind: 'group-message-observed',
    target: TARGET,
    eventId: `ob11:1000:${msgSeq}`,
    msgId: String(msgSeq),
    senderId: '8888',
    username: '小明',
    content: '那这个方案的缺点呢',
    atOthers: false,
    ts: T0,
    raw: {},
    ...overrides,
  };
}

/** @ 消息（触发 turn 的那种；续聊窗口由它的派发打开） */
function makeAtMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    kind: 'group-at-message',
    target: TARGET,
    eventId: 'ob11:1000:0',
    msgId: '0',
    senderId: '8888',
    username: '小明',
    content: '@bot 这个方案怎么样',
    ts: T0,
    raw: {},
    ...overrides,
  };
}

function makeWatcher(opts: {
  config?: InterventionConfig;
  withPromoter?: boolean;
} = {}) {
  let now = T0;
  const stats = new PipelineStats();
  const promoted: NormalizedMessage[] = [];
  const watcher = new TopicWatcher({
    config: opts.config ?? makeConfig(),
    rules: RULE_REGISTRY,
    stats,
    logger: createNullLogger(),
    now: () => now,
    ...(opts.withPromoter === false
      ? {}
      : {
          promote: (m: NormalizedMessage) => {
            promoted.push(m);
          },
        }),
  });
  return {
    watcher,
    stats,
    promoted,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('续聊晋升（40-promotion-window 端到端）', () => {
  /**
   * 开一个「已完成」的续聊窗口：@ turn 派发（开窗 + inFlight）→ 结束
   * （解除 inFlight）。窗口仍在，此后窗口内的跟进消息直接晋升——
   * turn 在途期间的跟进走 41 号合并队列（见下一个 describe）。
   */
  function openSettledWindow(watcher: TopicWatcher, msg?: NormalizedMessage): void {
    watcher.notifyTurnStarted(msg ?? makeAtMessage());
    watcher.notifyTurnEnded(TARGET.key);
  }

  it('窗口内的跟进消息晋升为正常提问（origin=continuation，id 原样保留）', async () => {
    const { watcher, stats, promoted } = makeWatcher();
    openSettledWindow(watcher);
    const followUp = makeObserved({ content: '缺点呢？' });
    watcher.observe(followUp);
    await settle();

    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({
      kind: 'group-at-message',
      origin: 'continuation',
      eventId: followUp.eventId, // 平台真实 id（Ingress 去重拦重推用）
      msgId: followUp.msgId,
      senderId: '8888',
      content: '缺点呢？',
    });
    expect(stats.continuationsPromoted).toBe(1);
    // 晋升的消息离开 watcher，不再入旁听缓冲
    expect(watcher.snapshot().conversations[0]?.buffered ?? 0).toBe(0);
  });

  it('无窗口（没人 @ 过）→ 不晋升，落入旁听缓冲', async () => {
    const { watcher, promoted } = makeWatcher();
    watcher.observe(makeObserved());
    await settle();
    expect(promoted).toHaveLength(0);
    expect(watcher.snapshot().conversations[0]?.buffered).toBe(1);
  });

  it('窗口过期（默认 120s 后）→ 不晋升', async () => {
    const { watcher, promoted, advance } = makeWatcher();
    openSettledWindow(watcher);
    advance(121_000);
    watcher.observe(makeObserved());
    await settle();
    expect(promoted).toHaveLength(0);
  });

  it('晋升即重置窗口：晋升后 110s 的跟进仍可晋升', async () => {
    const { watcher, promoted, advance } = makeWatcher();
    openSettledWindow(watcher);
    advance(110_000);
    watcher.observe(makeObserved()); // T0+110s 晋升，窗口重置到 T0+230s
    await settle();
    advance(110_000); // T0+220s：超出最初窗口（T0+120s），但在重置后窗口内
    watcher.observe(makeObserved());
    await settle();
    expect(promoted).toHaveLength(2);
  });

  it('@ 了别人的消息不晋升', async () => {
    const { watcher, promoted } = makeWatcher();
    openSettledWindow(watcher);
    watcher.observe(makeObserved({ atOthers: true, content: '@小红 你看' }));
    await settle();
    expect(promoted).toHaveLength(0);
  });

  it('命令形态（/ 开头）不晋升', async () => {
    const { watcher, promoted } = makeWatcher();
    openSettledWindow(watcher);
    watcher.observe(makeObserved({ content: '/listen off' }));
    await settle();
    expect(promoted).toHaveLength(0);
  });

  it('纯媒体占位（[图片]）不晋升', async () => {
    const { watcher, promoted } = makeWatcher();
    openSettledWindow(watcher);
    watcher.observe(makeObserved({ content: '[图片]' }));
    await settle();
    expect(promoted).toHaveLength(0);
  });

  it('同一事件重推不双晋升（晋升即认领 eventId）', async () => {
    const { watcher, stats, promoted } = makeWatcher();
    openSettledWindow(watcher);
    const msg = makeObserved();
    watcher.observe(msg);
    await settle();
    watcher.observe(msg); // 平台重推
    await settle();
    expect(promoted).toHaveLength(1);
    expect(stats.continuationsPromoted).toBe(1);
  });

  it('续聊 turn（origin=continuation）的派发不开新窗；c2c turn 也不开窗', async () => {
    const { watcher, promoted } = makeWatcher();
    openSettledWindow(watcher, makeAtMessage({ origin: 'continuation' }));
    watcher.observe(makeObserved());
    await settle();
    expect(promoted).toHaveLength(0);

    openSettledWindow(
      watcher,
      makeAtMessage({
        kind: 'c2c-message',
        target: { platform: 'onebot', kind: 'c2c', id: '8888', key: 'ob11:u8888' },
      }),
    );
    watcher.observe(makeObserved());
    await settle();
    expect(promoted).toHaveLength(0);
  });

  it('未装配 promoter 时不晋升、不抛错（记日志降级）', async () => {
    const { watcher, stats } = makeWatcher({ withPromoter: false });
    openSettledWindow(watcher);
    watcher.observe(makeObserved());
    await settle();
    expect(stats.continuationsPromoted).toBe(0);
  });
});

describe('在途合并（41-inflight-merge 端到端）', () => {
  it('turn 在途时晋升消息入 pending 队列，结束后冲刷晋升（单条保持原文）', async () => {
    const { watcher, stats, promoted } = makeWatcher();
    watcher.notifyTurnStarted(makeAtMessage()); // inFlight = true（turn 开始）
    watcher.observe(makeObserved({ content: '补充一下' }));
    await settle();

    // 在途：不立即晋升，入队
    expect(promoted).toHaveLength(0);
    expect(stats.continuationsMerged).toBe(1);
    expect(watcher.snapshot().conversations[0]?.pending).toBe(1);

    watcher.notifyTurnEnded(TARGET.key);
    await settle();
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.content).toBe('补充一下'); // 单条不合并不包装
    expect(promoted[0]?.origin).toBe('continuation');
    expect(watcher.snapshot().conversations[0]?.pending ?? 0).toBe(0);
  });

  it('多条 pending 合并为一条（用户连发多条格式）', async () => {
    const { watcher, promoted } = makeWatcher();
    watcher.notifyTurnStarted(makeAtMessage());
    watcher.observe(makeObserved({ content: '第一点' }));
    watcher.observe(makeObserved({ content: '第二点' }));
    await settle();

    watcher.notifyTurnEnded(TARGET.key);
    await settle();
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.content).toBe('「用户连发多条，合并处理：\n1. 第一点\n2. 第二点」');
  });

  it('多发送者的合并行带发送者名，避免丢失归属', async () => {
    const { watcher, promoted } = makeWatcher();
    watcher.notifyTurnStarted(makeAtMessage()); // 小明的窗口
    watcher.notifyTurnStarted(makeAtMessage({ senderId: '9999', username: '小红' })); // 小红的窗口
    watcher.observe(makeObserved({ senderId: '8888', username: '小明', content: '甲' }));
    watcher.observe(makeObserved({ senderId: '9999', username: '小红', content: '乙' }));
    await settle();

    watcher.notifyTurnEnded(TARGET.key);
    await settle();
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.content).toBe('「用户连发多条，合并处理：\n1. [小明] 甲\n2. [小红] 乙」');
  });

  it('容量上限：超限丢最旧并计数（continuationsDropped）', async () => {
    const { watcher, stats, promoted } = makeWatcher({
      config: makeConfig({ rules: { 'inflight-merge': { params: { maxPending: 2 } } } }),
    });
    watcher.notifyTurnStarted(makeAtMessage());
    watcher.observe(makeObserved({ content: '第一条' }));
    watcher.observe(makeObserved({ content: '第二条' }));
    watcher.observe(makeObserved({ content: '第三条' }));
    await settle();

    expect(stats.continuationsMerged).toBe(3);
    expect(stats.continuationsDropped).toBe(1); // 第一条被挤掉

    watcher.notifyTurnEnded(TARGET.key);
    await settle();
    expect(promoted[0]?.content).toBe('「用户连发多条，合并处理：\n1. 第二条\n2. 第三条」');
  });

  it('冲刷时窗口已关的条目作废，不晋升', async () => {
    const { watcher, stats, promoted, advance } = makeWatcher();
    watcher.notifyTurnStarted(makeAtMessage());
    watcher.observe(makeObserved());
    await settle();

    advance(130_000); // turn 跑了 130s，窗口（120s）已过期
    watcher.notifyTurnEnded(TARGET.key);
    await settle();
    expect(promoted).toHaveLength(0);
    expect(stats.continuationsDropped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 编排级：晋升消息回投后走完整 Ingress 管线（含真 offpeak 闸）
// ---------------------------------------------------------------------------

function makeOrchestrator(watcher: TopicWatcher, stats: PipelineStats, stages: IngressStage[]) {
  const terminalCalls: MessageContext[] = [];
  const connector = {
    platform: 'onebot',
    acceptsC2C: false,
    policy: () => ({}) as ReplyPolicy,
  } as unknown as BotConnector;
  const orchestrator = new Orchestrator({
    logger: createNullLogger(),
    connectors: new Map([['onebot', connector]]),
    admins: [],
    stats,
    stages,
    terminal: async (ctx) => {
      terminalCalls.push(ctx);
    },
    createResponder: () => ({ error: async () => {} }) as unknown as Responder,
    turns: { routeSessionEvent: () => {}, routeSessionStatus: () => {} },
    watcher,
    status: () => ({
      inFlight: 0,
      queued: 0,
      offpeak: {
        enabled: false,
        windows: [],
        timeZone: 'Asia/Shanghai',
        modelPattern: 'deepseek',
        weekendsAllDay: true,
        holidaysCount: 0,
        overridden: false,
      },
      intervention: watcher.snapshot(),
    }),
  });
  return { orchestrator, terminalCalls };
}

describe('晋升消息的编排级行为（与 @ 同权）', () => {
  it('晋升消息回投 handleEvent 后完整穿过 Ingress stage 链到达终态', async () => {
    const stats = new PipelineStats();
    const promoted: NormalizedMessage[] = [];
    const watcher = new TopicWatcher({
      config: makeConfig(),
      rules: RULE_REGISTRY,
      stats,
      logger: createNullLogger(),
      now: () => T0,
      promote: (m) => promoted.push(m), // 先接住，再手动回投
    });
    const seenByStages: string[] = [];
    const spyStage: IngressStage = async (ctx, next) => {
      seenByStages.push(`${ctx.message.origin ?? 'user'}:${ctx.message.content}`);
      await next();
    };
    const { orchestrator, terminalCalls } = makeOrchestrator(watcher, stats, [spyStage]);

    watcher.notifyTurnStarted(makeAtMessage());
    watcher.notifyTurnEnded(TARGET.key); // turn 结束、窗口仍开 → 跟进直接晋升
    watcher.observe(makeObserved({ content: '跟进问题' }));
    await settle();
    expect(promoted).toHaveLength(1);

    await orchestrator.handleEvent(promoted[0]!);
    expect(seenByStages).toEqual(['continuation:跟进问题']);
    expect(terminalCalls).toHaveLength(1);
  });

  it('谷时段闸对晋升消息一视同仁（正价时段照样拦截，与 @ 同权）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-cont-offpeak-'));
    try {
      const stats = new PipelineStats();
      const promoted: NormalizedMessage[] = [];
      const watcher = new TopicWatcher({
        config: makeConfig(),
        rules: RULE_REGISTRY,
        stats,
        logger: createNullLogger(),
        now: () => T0,
        promote: (m) => promoted.push(m),
      });
      // 正价时段：无谷价窗口、非周末非节假日的工作日中午
      const gatedDefaults: OffpeakGateConfig = {
        enabled: true,
        windows: [],
        timeZone: 'Asia/Shanghai',
        modelPattern: 'deepseek',
        weekendsAllDay: false,
        holidays: new Set<string>(),
      };
      // 2026-09-29 是周二，12:00 +08:00 不在任何谷价窗口内
      const peakNoon = Date.parse('2026-09-29T12:00:00+08:00');
      const gate = new OffpeakGate({
        defaults: gatedDefaults,
        filePath: join(dir, 'offpeak-override.json'),
        logger: createNullLogger(),
        now: () => peakNoon,
      });
      const offpeakStage = createOffpeakGateStage({
        gate,
        // 只取 dsh.provider/model 两个字段，其余 Config 不需要
        config: { dsh: { provider: 'deepseek', model: 'deepseek-flash' } } as never,
        stats,
        now: () => peakNoon,
      });
      const { orchestrator, terminalCalls } = makeOrchestrator(watcher, stats, [offpeakStage]);

      watcher.notifyTurnStarted(makeAtMessage());
      watcher.notifyTurnEnded(TARGET.key); // turn 结束、窗口仍开 → 跟进直接晋升
      watcher.observe(makeObserved({ content: '跟进问题' }));
      await settle();
      await orchestrator.handleEvent(promoted[0]!);

      expect(terminalCalls).toHaveLength(0); // 被谷时段闸拦下
      expect(stats.gatedOffpeak).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
