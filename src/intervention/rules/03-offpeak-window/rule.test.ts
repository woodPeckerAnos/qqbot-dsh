/**
 * 规则 03-offpeak-window 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

function makeCtx(opts: { offpeakNow?: boolean; respectOffpeak?: boolean }): RuleContext {
  return {
    message: {
      kind: 'group-message-observed',
      target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
      eventId: 'ob11:1000:1',
      msgId: '1',
      senderId: '8888',
      content: '随便聊聊',
      atOthers: false,
      ts: 1_000_000,
      raw: {},
    },
    trigger: 'message',
    state: new ConversationWatchState('ob11:g123', { maxMessages: 200, maxAgeMs: 3_600_000 }),
    marks: {},
    params: { respectOffpeak: opts.respectOffpeak ?? true },
    now: 1_000_000,
    ...(opts.offpeakNow !== undefined ? { offpeakNow: opts.offpeakNow } : {}),
  };
}

describe('03-offpeak-window', () => {
  it('验收1：正价时段 → halt(peak-hours)', () => {
    expect(rule.evaluate(makeCtx({ offpeakNow: false }))).toEqual({
      action: 'halt',
      reason: 'peak-hours',
    });
  });

  it('验收2：谷时段 → pass', () => {
    expect(rule.evaluate(makeCtx({ offpeakNow: true }))).toEqual({ action: 'pass' });
  });

  it('验收3：respectOffpeak=false → 恒 pass', () => {
    expect(rule.evaluate(makeCtx({ offpeakNow: false, respectOffpeak: false }))).toEqual({
      action: 'pass',
    });
  });

  it('验收4：无探针（undefined）→ pass', () => {
    expect(rule.evaluate(makeCtx({}))).toEqual({ action: 'pass' });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('offpeak-window');
    expect(rule.stage).toBe('intake');
    expect(rule.order).toBe(3);
  });
});
