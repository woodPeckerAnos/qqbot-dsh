/**
 * 规则 07-rate-limit-precheck 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
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
    message: {
      kind: 'group-message-observed',
      target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
      eventId: 'ob11:1000:1',
      msgId: '1',
      senderId: '8888',
      content: '聊聊',
      atOthers: false,
      ts: NOW,
      raw: {},
    },
    trigger: 'message',
    state,
    marks: {},
    params: { maxPer10Min: 3, maxPerHour: 8 },
    now: NOW,
  };
}

describe('07-rate-limit-precheck', () => {
  it('验收1：近 10 分钟介入 3 次 → halt(rate-limited-10min)', () => {
    const ctx = makeCtx([NOW - 60_000, NOW - 120_000, NOW - 180_000]);
    expect(rule.evaluate(ctx)).toEqual({ action: 'halt', reason: 'rate-limited-10min' });
  });

  it('验收2：10 分钟未满但 1 小时满 → halt(rate-limited-1h)', () => {
    const spokeAts = [NOW - 1_200_000, NOW - 1_500_000, NOW - 1_800_000, NOW - 2_100_000,
      NOW - 2_400_000, NOW - 2_700_000, NOW - 3_000_000, NOW - 3_300_000];
    expect(rule.evaluate(makeCtx(spokeAts))).toEqual({ action: 'halt', reason: 'rate-limited-1h' });
  });

  it('验收3：两窗口都未满 → pass', () => {
    const ctx = makeCtx([NOW - 60_000, NOW - 1_200_000]);
    expect(rule.evaluate(ctx)).toEqual({ action: 'pass' });
  });

  it('验收4：从未介入 → pass', () => {
    expect(rule.evaluate(makeCtx([]))).toEqual({ action: 'pass' });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('rate-limit-precheck');
    expect(rule.stage).toBe('intake');
    expect(rule.order).toBe(7);
  });
});
