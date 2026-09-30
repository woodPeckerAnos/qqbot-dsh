/**
 * 规则 13-sampling-debounce 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import { ConversationWatchState } from '../../state.js';
import type { RuleContext, RuleMarks } from '../../contract.js';
import { rule } from './rule.js';

const NOW = 10_000_000;
const DURATIONS = { focusMs: 120_000, fadingMs: 120_000, focusMaxReplies: 2 };

function makeCtx(opts: { unevaluated?: number; marks?: RuleMarks; fading?: boolean }): RuleContext {
  const state = new ConversationWatchState('ob11:g123', { maxMessages: 200, maxAgeMs: 3_600_000 });
  state.unevaluatedCount = opts.unevaluated ?? 0;
  if (opts.fading === true) {
    state.applyPhaseEvent('rate-limit-hit', NOW - 1000, DURATIONS); // 强制 fading
  }
  return {
    message: {
      kind: 'group-message-observed',
      target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
      eventId: 'ob11:1000:1',
      msgId: '1',
      senderId: '8888',
      content: '一条消息',
      atOthers: false,
      ts: NOW,
      raw: {},
    },
    trigger: 'message',
    state,
    marks: opts.marks ?? {},
    params: { evaluateEvery: 6, silenceDebounceMs: 20_000 },
    now: NOW,
  };
}

describe('13-sampling-debounce', () => {
  it('验收1：已有强信号 → pass（立即评估语义由 runner 读 strongSignal）', () => {
    const verdict = rule.evaluate(makeCtx({ marks: { strongSignal: 'quick-reply' } }));
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收2：计数达标（6/6）→ mark(samplingHit)', () => {
    expect(rule.evaluate(makeCtx({ unevaluated: 6 }))).toEqual({
      action: 'mark',
      marks: { samplingHit: true },
    });
  });

  it('验收3：计数未达标（3/6）→ pass 且无 samplingHit', () => {
    expect(rule.evaluate(makeCtx({ unevaluated: 3 }))).toEqual({ action: 'pass' });
  });

  it('验收4：FADING 相位阈值减半（3 ≥ 6/2）→ mark(samplingHit)', () => {
    expect(rule.evaluate(makeCtx({ unevaluated: 3, fading: true }))).toEqual({
      action: 'mark',
      marks: { samplingHit: true },
    });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('sampling-debounce');
    expect(rule.stage).toBe('intake');
    expect(rule.order).toBe(13);
  });
});
