/**
 * 主动发言出口单测（离线、不触网、不用真适配器）。
 *
 * 锁的是**契约**，不是措辞：
 *   - 两个平台的差异只体现在返回值里，外层逻辑一条路径；
 *   - 六种降级原因各自的优先级与短路顺序；
 *   - 永不抛错（适配器抛错也兜住）；
 *   - 每次发言/降级都进记账（否则官方通道会静默成"bot 坏了"）。
 */

import { describe, expect, it } from 'vitest';

import type {
  BotConnector,
  ConversationTarget,
  OutgoingMessage,
  ProactiveResult,
  ReplyPolicy,
} from '../src/core/connector.js';
import { createNullLogger } from '../src/logger.js';
import {
  PROACTIVE_DEGRADE_ORDER,
  ProactiveSpeaker,
  isSent,
  type ProactiveDegradeReason,
  type ProactiveMetrics,
  type ProactiveTrigger,
} from '../src/pipeline/proactive/speaker.js';

const TARGET: ConversationTarget = {
  platform: 'onebot',
  kind: 'group',
  id: '123456',
  key: 'ob11:g123456',
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

interface Recorded {
  calls: Array<{ target: ConversationTarget; out: OutgoingMessage }>;
  metrics: { sent: ProactiveTrigger[]; degraded: Array<[ProactiveDegradeReason, ProactiveTrigger]> };
}

/** 假适配器：`impl` 决定"平台能力"，undefined 表示缺省（未实现 proactive）。 */
function makeConnector(
  recorded: Recorded,
  impl?: (target: ConversationTarget, out: OutgoingMessage) => Promise<ProactiveResult>,
): BotConnector {
  const connector: BotConnector = {
    platform: 'onebot',
    acceptsC2C: true,
    start: async () => {},
    stop: async () => {},
    on: () => () => {},
    health: () => ({ connected: true, state: 'test' }),
    policy: () => POLICY,
    reply: async () => {},
  };
  if (impl !== undefined) {
    connector.proactive = async (target, out) => {
      recorded.calls.push({ target, out });
      return impl(target, out);
    };
  }
  return connector;
}

type ProactiveImpl = (
  target: ConversationTarget,
  out: OutgoingMessage,
) => Promise<ProactiveResult>;

/**
 * 统一的测试装配：一个 recorder 同时记"适配器被调用"与"记账"，避免两套记录各记一半。
 *   - `impl` = undefined → 适配器**不实现** proactive（缺省语义）
 *   - `connector` = null  → 找不到连接器
 */
function setup(
  impl: ProactiveImpl | undefined,
  { enabled = true, noConnector = false }: { enabled?: boolean; noConnector?: boolean } = {},
): { speaker: ProactiveSpeaker; recorded: Recorded } {
  const recorded: Recorded = { calls: [], metrics: { sent: [], degraded: [] } };
  const metrics: ProactiveMetrics = {
    sent: (trigger) => recorded.metrics.sent.push(trigger),
    degraded: (reason, trigger) => recorded.metrics.degraded.push([reason, trigger]),
  };
  const connector = noConnector ? undefined : makeConnector(recorded, impl);
  const speaker = new ProactiveSpeaker({
    connectorFor: () => connector,
    enabled,
    metrics,
    logger: createNullLogger(),
  });
  return { speaker, recorded };
}

const CONTENT: OutgoingMessage = { text: '这是一条主动发言' };

describe('主动发言出口：平台能力差异只体现在返回值', () => {
  it('验收1：OneBot 能力就绪 → 送达，并把目标与内容原样交给适配器', async () => {
    const { speaker, recorded } = setup(async () => ({ ok: true }));
    const outcome = await speaker.deliver({
      target: TARGET,
      content: CONTENT,
      trigger: 'intervention:scene-3',
      reason: '问题挂起 11 分钟无人应答',
    });
    expect(outcome).toEqual({ status: 'sent', trigger: 'intervention:scene-3' });
    expect(isSent(outcome)).toBe(true);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]?.target.key).toBe('ob11:g123456');
    expect(recorded.metrics.sent).toEqual(['intervention:scene-3']);
    expect(recorded.metrics.degraded).toEqual([]);
  });

  it('验收2：官方通道 do nothing（unsupported）→ 外层只记一次降级，不抛错、不重试', async () => {
    const { speaker, recorded } = setup(async () => ({
      ok: false,
      reason: 'unsupported',
      detail: '官方通道不提供主动推送',
      retryable: false,
    }));
    const outcome = await speaker.deliver({
      target: TARGET,
      content: CONTENT,
      trigger: 'intervention:scene-5',
    });
    expect(outcome).toEqual({
      status: 'degraded',
      trigger: 'intervention:scene-5',
      reason: 'unsupported',
      detail: '官方通道不提供主动推送',
      retryable: false,
    });
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.metrics.degraded).toEqual([['unsupported', 'intervention:scene-5']]);
    expect(recorded.metrics.sent).toEqual([]);
  });

  it('验收3：适配器未实现 proactive（缺省）与显式 unsupported 等价', async () => {
    const { speaker, recorded } = setup(undefined);
    expect(speaker.capability(TARGET)).toBe('unsupported');
    const outcome = await speaker.deliver({ target: TARGET, content: CONTENT, trigger: 'manual' });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'unsupported', retryable: false });
    expect(recorded.calls).toHaveLength(0);
  });
});

describe('主动发言出口：降级顺序与记账', () => {
  it('验收4：总开关关闭时连适配器都不调用（disabled 短路）', async () => {
    const { speaker, recorded } = setup(async () => ({ ok: true }), { enabled: false });
    const outcome = await speaker.deliver({ target: TARGET, content: CONTENT, trigger: 'manual' });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'disabled' });
    expect(recorded.calls).toHaveLength(0);
    expect(recorded.metrics.degraded).toEqual([['disabled', 'manual']]);
  });

  it('验收5：空内容不发（empty 优先于任何平台调用）', async () => {
    const { speaker, recorded } = setup(async () => ({ ok: true }));
    const blank = await speaker.deliver({
      target: TARGET,
      content: { text: '   ' },
      trigger: 'manual',
    });
    expect(blank).toMatchObject({ status: 'degraded', reason: 'empty' });
    // 有附件时不算空
    const withFile = await speaker.deliver({
      target: TARGET,
      content: {
        text: '',
        attachments: [{ kind: 'image', absPath: '/tmp/x.png', fileName: 'x.png', sizeBytes: 1 }],
      },
      trigger: 'manual',
    });
    expect(withFile).toMatchObject({ status: 'sent' });
    expect(recorded.calls).toHaveLength(1);
  });

  it('验收6：额度与限频原因原样透传，且都算降级（不重试）', async () => {
    for (const reason of ['quota', 'rate-limit'] as const) {
      const { speaker, recorded } = setup(async () => ({
        ok: false,
        reason,
        retryable: false,
      }));
      const outcome = await speaker.deliver({
        target: TARGET,
        content: CONTENT,
        trigger: 'intervention:scene-1',
      });
      expect(outcome).toMatchObject({ status: 'degraded', reason });
      expect(recorded.metrics.degraded).toEqual([[reason, 'intervention:scene-1']]);
    }
  });

  it('验收7：适配器抛错也被兜住（永不抛错），按 error 降级且标记可重试', async () => {
    const { speaker, recorded } = setup(async () => {
      throw new Error('websocket closed');
    });
    const outcome = await speaker.deliver({
      target: TARGET,
      content: CONTENT,
      trigger: 'intervention:scene-2',
    });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'error', retryable: true });
    expect(recorded.metrics.degraded).toEqual([['error', 'intervention:scene-2']]);
  });

  it('验收8：找不到连接器按 error 降级；capability 能区分三种状态', async () => {
    const { speaker, recorded } = setup(undefined, { noConnector: true });
    expect(speaker.capability(TARGET)).toBe('no-connector');
    const outcome = await speaker.deliver({ target: TARGET, content: CONTENT, trigger: 'manual' });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'error' });

    const ready = setup(async () => ({ ok: true }));
    expect(ready.speaker.capability(TARGET)).toBe('ready');
    expect(recorded.metrics.sent).toEqual([]);
  });

  it('验收9：降级原因清单是有序的且覆盖全部六种（/metrics 输出顺序的真相源）', () => {
    expect([...PROACTIVE_DEGRADE_ORDER]).toEqual([
      'disabled',
      'unsupported',
      'quota',
      'rate-limit',
      'error',
      'empty',
    ]);
    expect(new Set(PROACTIVE_DEGRADE_ORDER).size).toBe(PROACTIVE_DEGRADE_ORDER.length);
  });
});
