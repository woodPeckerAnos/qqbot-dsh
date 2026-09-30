/**
 * 规则 30-rate-limit-veto 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

const NOW = 10_000_000;
const DURATIONS = { focusMs: 120_000, fadingMs: 120_000, focusMaxReplies: 2 };

function makeCtx(spokeAts: number[]): RuleContext {
  const state = new ConversationWatchState('ob11:g123', { maxMessages: 200, maxAgeMs: 3_600_000 });
  for (const ts of spokeAts) state.applyPhaseEvent('spoke', ts, DURATIONS);
  return {
    message: undefined,
    trigger: 'debounce',
    state,
    marks: { gateDecision: 'speak' },
    params: { maxPer10Min: 3, maxPerHour: 8 },
    now: NOW,
  };
}

describe('30-rate-limit-veto', () => {
  it('验收1：近 10 分钟已介入 3 次 → halt(rate-limited-10min)', () => {
    const ctx = makeCtx([NOW - 60_000, NOW - 120_000, NOW - 180_000]);
    expect(rule.evaluate(ctx)).toEqual({ action: 'halt', reason: 'rate-limited-10min' });
  });

  it('验收2：近 1 小时已介入 8 次（10 分钟未满）→ halt(rate-limited-1h)', () => {
    const spokeAts = [NOW - 1_200_000, NOW - 1_500_000, NOW - 1_800_000, NOW - 2_100_000,
      NOW - 2_400_000, NOW - 2_700_000, NOW - 3_000_000, NOW - 3_300_000];
    expect(rule.evaluate(makeCtx(spokeAts))).toEqual({ action: 'halt', reason: 'rate-limited-1h' });
  });

  it('验收3：两窗口都未满 → pass', () => {
    expect(rule.evaluate(makeCtx([NOW - 30_000]))).toEqual({ action: 'pass' });
  });

  it('验收4：从未介入 → pass', () => {
    expect(rule.evaluate(makeCtx([]))).toEqual({ action: 'pass' });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('rate-limit-veto');
    expect(rule.stage).toBe('speak');
    expect(rule.order).toBe(30);
  });
});
