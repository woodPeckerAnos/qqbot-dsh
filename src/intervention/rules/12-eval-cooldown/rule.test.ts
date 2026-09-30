/**
 * 规则 12-eval-cooldown 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import { ConversationWatchState } from '../../state.js';
import type { RuleContext, RuleMarks } from '../../contract.js';
import { rule } from './rule.js';

const NOW = 10_000_000;

function makeCtx(opts: { lastEvaluateAgoMs?: number; marks?: RuleMarks }): RuleContext {
  const state = new ConversationWatchState('ob11:g123', { maxMessages: 200, maxAgeMs: 3_600_000 });
  if (opts.lastEvaluateAgoMs !== undefined) state.recordEvaluate(NOW - opts.lastEvaluateAgoMs);
  return {
    message: {
      kind: 'group-message-observed',
      target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
      eventId: 'ob11:1000:1',
      msgId: '1',
      senderId: '8888',
      content: '接着说',
      atOthers: false,
      ts: NOW,
      raw: {},
    },
    trigger: 'message',
    state,
    marks: opts.marks ?? {},
    params: { cooldownMs: 60_000, strongSignalCooldownMs: 15_000 },
    now: NOW,
  };
}

describe('12-eval-cooldown', () => {
  it('验收1：从未评估 → pass', () => {
    expect(rule.evaluate(makeCtx({}))).toEqual({ action: 'pass' });
  });

  it('验收2：无强信号且 30s 前评过 → halt(cooldown)', () => {
    expect(rule.evaluate(makeCtx({ lastEvaluateAgoMs: 30_000 }))).toEqual({
      action: 'halt',
      reason: 'cooldown',
      buffer: true, // 冷却拦截仍入缓冲做上下文
    });
  });

  it('验收3：无强信号且 70s 前评过 → pass', () => {
    expect(rule.evaluate(makeCtx({ lastEvaluateAgoMs: 70_000 }))).toEqual({ action: 'pass' });
  });

  it('验收4：有强信号且 20s 前评过 → pass', () => {
    const verdict = rule.evaluate(
      makeCtx({ lastEvaluateAgoMs: 20_000, marks: { strongSignal: 'quick-reply' } }),
    );
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收5：有强信号且 10s 前评过 → halt(cooldown)', () => {
    const verdict = rule.evaluate(
      makeCtx({ lastEvaluateAgoMs: 10_000, marks: { strongSignal: 'quick-reply' } }),
    );
    expect(verdict).toEqual({ action: 'halt', reason: 'cooldown', buffer: true });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('eval-cooldown');
    expect(rule.stage).toBe('intake');
    expect(rule.order).toBe(12);
  });
});
