/**
 * 规则 31-focus-budget 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

const NOW = 10_000_000;
const DURATIONS = { focusMs: 120_000, fadingMs: 120_000, focusMaxReplies: 2 };

function makeCtx(spokeCount: number): RuleContext {
  const state = new ConversationWatchState('ob11:g123', { maxMessages: 200, maxAgeMs: 3_600_000 });
  for (let i = 0; i < spokeCount; i += 1) {
    state.applyPhaseEvent('spoke', NOW - 60_000 + i * 1000, DURATIONS);
  }
  return {
    message: undefined,
    trigger: 'debounce',
    state,
    marks: { gateDecision: 'speak' },
    params: { focusMs: 120_000, fadingMs: 120_000, focusMaxReplies: 2 },
    now: NOW,
  };
}

describe('31-focus-budget', () => {
  it('验收1：相位 fading（满 2 次发言自动降级）→ halt(fading-no-speak)', () => {
    const verdict = rule.evaluate(makeCtx(2));
    expect(verdict).toEqual({ action: 'halt', reason: 'fading-no-speak' });
  });

  it('验收2：相位 focus 且已发言 1 次（预算未满）→ pass', () => {
    expect(rule.evaluate(makeCtx(1))).toEqual({ action: 'pass' });
  });

  it('验收3：相位 cold → pass', () => {
    expect(rule.evaluate(makeCtx(0))).toEqual({ action: 'pass' });
  });

  it('验收4：focus 相位期满自动回 cold → pass', () => {
    const state = new ConversationWatchState('ob11:g123', { maxMessages: 200, maxAgeMs: 3_600_000 });
    state.applyPhaseEvent('spoke', NOW - 1_000_000, DURATIONS); // 早过 120s 窗口
    const ctx: RuleContext = {
      message: undefined,
      trigger: 'debounce',
      state,
      marks: {},
      params: { focusMs: 120_000, fadingMs: 120_000, focusMaxReplies: 2 },
      now: NOW,
    };
    expect(state.phaseAt(NOW)).toBe('cold');
    expect(rule.evaluate(ctx)).toEqual({ action: 'pass' });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('focus-budget');
    expect(rule.stage).toBe('speak');
    expect(rule.order).toBe(31);
  });
});
