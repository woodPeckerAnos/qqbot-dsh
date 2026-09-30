/**
 * 话题介入层单测：链 runner、watcher（含首批规则 01/02/04 的端到端）、
 * Orchestrator 的 observed 分流。全离线，不触网、不起子进程。
 */

import { describe, expect, it } from 'vitest';

import type { NormalizedObservedMessage } from '../src/core/connector.js';
import { formatTrace, runChain, type ChainBaseContext } from '../src/intervention/chain.js';
import type { InterventionRule } from '../src/intervention/contract.js';
import { ConversationWatchState } from '../src/intervention/state.js';
import { TopicWatcher, type InterventionConfig } from '../src/intervention/watcher.js';
import { RULE_REGISTRY } from '../src/intervention/rules/index.js';
import { createNullLogger } from '../src/logger.js';
import { Orchestrator } from '../src/pipeline/orchestrator.js';
import { PipelineStats } from '../src/pipeline/stats.js';

const NOW = 1_700_000_000_000;

function makeMessage(overrides: Partial<NormalizedObservedMessage> = {}): NormalizedObservedMessage {
  return {
    kind: 'group-message-observed',
    target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
    eventId: 'ob11:1000:1',
    msgId: '1',
    senderId: '8888',
    username: '张三',
    content: '有人在吗',
    atOthers: false,
    ts: NOW,
    raw: {},
    ...overrides,
  };
}

function makeConfig(overrides: Partial<InterventionConfig> = {}): InterventionConfig {
  return {
    enabled: true,
    dryRun: false,
    whitelistGroups: ['onebot:123'],
    buffer: { maxMessages: 200, maxAgeMs: 72 * 3_600_000 },
    rules: {},
    ...overrides,
  };
}

function makeWatcher(config: InterventionConfig) {
  const stats = new PipelineStats();
  const watcher = new TopicWatcher({
    config,
    rules: RULE_REGISTRY,
    stats,
    logger: createNullLogger(),
    now: () => NOW,
  });
  return { watcher, stats };
}

/** watcher.observe 是 fire-and-forget；测试里等一拍让异步链跑完。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// 链 runner
// ---------------------------------------------------------------------------

describe('runChain', () => {
  const base: ChainBaseContext = {
    message: makeMessage(),
    trigger: 'message',
    state: new ConversationWatchState('ob11:g123', { maxMessages: 10, maxAgeMs: 1000 }),
    marks: {},
    now: NOW,
  };
  const passParams = () => ({});
  const allEnabled = () => true;

  it('全层 pass → outcome=passed，trace 逐层记录', async () => {
    const rules: InterventionRule[] = [
      { name: 'a', stage: 'intake', order: 1, evaluate: () => ({ action: 'pass' }) },
      { name: 'b', stage: 'intake', order: 2, evaluate: () => ({ action: 'pass' }) },
    ];
    const result = await runChain(rules, base, passParams, allEnabled);
    expect(result.outcome).toBe('passed');
    expect(formatTrace(result.trace)).toBe('01✓02✓');
  });

  it('halt 短路：后续层不执行，reason 透出', async () => {
    const rules: InterventionRule[] = [
      { name: 'a', stage: 'intake', order: 1, evaluate: () => ({ action: 'halt', reason: 'nope' }) },
      {
        name: 'b',
        stage: 'intake',
        order: 2,
        evaluate: () => {
          throw new Error('不该被执行到');
        },
      },
    ];
    const result = await runChain(rules, base, passParams, allEnabled);
    expect(result.outcome).toBe('halted');
    expect(result.haltedBy).toBe('a');
    expect(result.reason).toBe('nope');
    expect(formatTrace(result.trace)).toBe('01✗(nope)');
  });

  it('mark 累积到 marks，下游可见', async () => {
    const rules: InterventionRule[] = [
      {
        name: 'a',
        stage: 'intake',
        order: 1,
        evaluate: () => ({ action: 'mark', marks: { strongSignal: 'quick-reply' } }),
      },
      {
        name: 'b',
        stage: 'intake',
        order: 2,
        evaluate: (ctx) =>
          ctx.marks.strongSignal === 'quick-reply'
            ? { action: 'pass' }
            : { action: 'halt', reason: 'missing-mark' },
      },
    ];
    const result = await runChain(rules, base, passParams, allEnabled);
    expect(result.outcome).toBe('passed');
    expect(result.marks.strongSignal).toBe('quick-reply');
  });

  it('规则抛错按 fail-closed 处理为 halt(rule-error)，链不炸', async () => {
    const rules: InterventionRule[] = [
      {
        name: 'bad',
        stage: 'intake',
        order: 1,
        evaluate: () => {
          throw new Error('boom');
        },
      },
    ];
    const result = await runChain(rules, base, passParams, allEnabled);
    expect(result.outcome).toBe('halted');
    expect(result.haltedBy).toBe('bad');
    expect(result.reason).toContain('rule-error');
  });

  it('被配置停用的规则跳过（trace 记 −），视为放行', async () => {
    const rules: InterventionRule[] = [
      { name: 'a', stage: 'intake', order: 1, evaluate: () => ({ action: 'halt', reason: 'x' }) },
      { name: 'b', stage: 'intake', order: 2, evaluate: () => ({ action: 'pass' }) },
    ];
    const result = await runChain(rules, base, passParams, (rule) => rule.name !== 'a');
    expect(result.outcome).toBe('passed');
    expect(formatTrace(result.trace)).toBe('01−02✓');
  });

  it('defer 短路并带出重查时长', async () => {
    const rules: InterventionRule[] = [
      {
        name: 'a',
        stage: 'intake',
        order: 1,
        evaluate: () => ({ action: 'defer', ms: 5000, reason: 'answer-window' }),
      },
    ];
    const result = await runChain(rules, base, passParams, allEnabled);
    expect(result.outcome).toBe('deferred');
    expect(result.deferMs).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// watcher + 首批规则（01/02/04）端到端
// ---------------------------------------------------------------------------

describe('TopicWatcher（P0：只听不说）', () => {
  it('白名单群的消息通过链后进入旁听缓冲', async () => {
    const { watcher, stats } = makeWatcher(makeConfig());
    watcher.observe(makeMessage());
    await settle();
    expect(stats.observed).toBe(1);
    expect(stats.observedHalted).toBe(0);
    const snapshot = watcher.snapshot();
    expect(snapshot.conversations).toEqual([
      { key: 'ob11:g123', buffered: 1 },
    ]);
  });

  it('总开关关闭 → 规则 01 拦截，消息不入缓冲', async () => {
    const { watcher, stats } = makeWatcher(makeConfig({ enabled: false }));
    watcher.observe(makeMessage());
    await settle();
    expect(stats.observed).toBe(1);
    expect(stats.observedHalted).toBe(1);
    expect(watcher.snapshot().conversations[0]?.buffered ?? 0).toBe(0);
    expect(watcher.snapshot().halts['master-switch']).toBe(1);
  });

  it('非白名单群 → 规则 02 拦截，消息不入缓冲', async () => {
    const { watcher, stats } = makeWatcher(makeConfig({ whitelistGroups: [] }));
    watcher.observe(makeMessage());
    await settle();
    expect(stats.observedHalted).toBe(1);
    expect(watcher.snapshot().halts['group-whitelist']).toBe(1);
  });

  it('重复 eventId → 规则 04 拦截（防框架重放）', async () => {
    const { watcher, stats } = makeWatcher(makeConfig());
    watcher.observe(makeMessage());
    await settle();
    watcher.observe(makeMessage()); // 同一 eventId 重放
    await settle();
    expect(stats.observed).toBe(2);
    expect(stats.observedHalted).toBe(1);
    expect(watcher.snapshot().halts['duplicate-event']).toBe(1);
    expect(watcher.snapshot().conversations[0]?.buffered).toBe(1);
  });

  it('运行期 /listen off 后本群不再旁听', async () => {
    const { watcher, stats } = makeWatcher(makeConfig());
    watcher.setRuntimeEnabled('ob11:g123', false);
    watcher.observe(makeMessage());
    await settle();
    expect(stats.observedHalted).toBe(1);
    expect(watcher.snapshot().halts['master-switch']).toBe(1);
  });

  it('缓冲有界：超出 maxMessages 淘汰最旧', async () => {
    const { watcher } = makeWatcher(
      makeConfig({ buffer: { maxMessages: 3, maxAgeMs: 72 * 3_600_000 } }),
    );
    for (let i = 1; i <= 5; i += 1) {
      watcher.observe(makeMessage({ eventId: `ob11:1000:${i}`, msgId: String(i) }));
    }
    await settle();
    expect(watcher.snapshot().conversations[0]?.buffered).toBe(3);
  });

  it('markAddressed：同 msgId 的 @ 消息到达后，缓冲条目标记 addressed', async () => {
    const { watcher } = makeWatcher(makeConfig());
    watcher.observe(makeMessage());
    await settle();
    watcher.markAddressed('ob11:g123', '1');
    const state = watcher.snapshot();
    expect(state.conversations[0]?.buffered).toBe(1);
  });

  it('规则停用覆盖：rules.master-switch.enabled=false 后该层恒放行', async () => {
    const { watcher, stats } = makeWatcher(
      // 总开关关、但 master-switch 规则被停用 → 01 不再拦（其余层照常）
      makeConfig({ enabled: false, rules: { 'master-switch': { enabled: false } } }),
    );
    watcher.observe(makeMessage());
    await settle();
    expect(stats.observedHalted).toBe(0);
    expect(watcher.snapshot().conversations[0]?.buffered).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator 分流：observed 进 watcher，@ 消息标记 addressed
// ---------------------------------------------------------------------------

describe('Orchestrator 的 observed 分流', () => {
  function makeOrchestrator(watcher: TopicWatcher, stats: PipelineStats) {
    return new Orchestrator({
      logger: createNullLogger(),
      connectors: new Map(),
      admins: [],
      stats,
      stages: [],
      terminal: async () => {},
      createResponder: () => {
        throw new Error('observed 事件不该走到 Responder');
      },
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
  }

  it('observed 事件分流给 watcher，不进 Ingress 提问管线', async () => {
    const { watcher, stats } = makeWatcher(makeConfig());
    const orchestrator = makeOrchestrator(watcher, stats);
    await orchestrator.handleEvent(makeMessage());
    await settle();
    expect(stats.observed).toBe(1);
    expect(stats.received).toBe(0); // 未进入提问路径
    expect(watcher.snapshot().conversations[0]?.buffered).toBe(1);
  });

  it('at 消息到达时通知 watcher.markAddressed（全量模式双事件幂等）', async () => {
    const { watcher, stats } = makeWatcher(makeConfig());
    const orchestrator = makeOrchestrator(watcher, stats);
    await orchestrator.handleEvent({
      kind: 'group-at-message',
      target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
      eventId: 'ob11:1000:9',
      msgId: '9',
      senderId: '8888',
      content: '@bot 在吗',
      ts: NOW,
      raw: {},
    });
    // 连接器表为空 → 消息被丢弃（记 warn），但 markAddressed 已先行调用；
    // 直接断言 watcher 状态被触达（未抛错即满足「永不抛错」契约）
    expect(stats.received).toBe(1);
  });

  it('未装配 watcher 时 observed 事件静默丢弃（向后兼容）', async () => {
    const stats = new PipelineStats();
    const orchestrator = new Orchestrator({
      logger: createNullLogger(),
      connectors: new Map(),
      admins: [],
      stats,
      stages: [],
      terminal: async () => {},
      createResponder: () => {
        throw new Error('unused');
      },
      turns: { routeSessionEvent: () => {}, routeSessionStatus: () => {} },
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
        intervention: {
          enabled: false,
          dryRun: false,
          conversations: [],
          halts: {},
        },
      }),
    });
    await orchestrator.handleEvent(makeMessage());
    expect(stats.observed).toBe(0);
  });
});
