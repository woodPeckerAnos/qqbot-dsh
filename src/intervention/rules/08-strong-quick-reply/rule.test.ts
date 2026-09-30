/**
 * 规则 08-strong-quick-reply 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

const NOW = 10_000_000;

function makeCtx(opts: { botSpokeAgoMs?: number; withMessage?: boolean }): RuleContext {
  const state = new ConversationWatchState('ob11:g123', { maxMessages: 200, maxAgeMs: 3_600_000 });
  if (opts.botSpokeAgoMs !== undefined) {
    state.noteBotSpeech(NOW - opts.botSpokeAgoMs, '刚才的回答');
  }
  return {
    message:
      opts.withMessage === false
        ? undefined
        : {
            kind: 'group-message-observed',
            target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
            eventId: 'ob11:1000:1',
            msgId: '1',
            senderId: '8888',
            content: '原来如此',
            atOthers: false,
            ts: NOW,
            raw: {},
          },
    trigger: 'message',
    state,
    marks: {},
    params: { quickResponseMs: 30_000 },
    now: NOW,
  };
}

describe('08-strong-quick-reply', () => {
  it('验收1：bot 20s 前发言 → mark(quick-reply)', () => {
    expect(rule.evaluate(makeCtx({ botSpokeAgoMs: 20_000 }))).toEqual({
      action: 'mark',
      marks: { strongSignal: 'quick-reply' },
    });
  });

  it('验收2：bot 40s 前发言 → pass', () => {
    expect(rule.evaluate(makeCtx({ botSpokeAgoMs: 40_000 }))).toEqual({ action: 'pass' });
  });

  it('验收3：bot 从未发言 → pass', () => {
    expect(rule.evaluate(makeCtx({}))).toEqual({ action: 'pass' });
  });

  it('验收4：非消息触发 → halt(no-message)', () => {
    expect(rule.evaluate(makeCtx({ botSpokeAgoMs: 5_000, withMessage: false }))).toEqual({
      action: 'halt',
      reason: 'no-message',
    });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('strong-quick-reply');
    expect(rule.stage).toBe('intake');
    expect(rule.order).toBe(8);
  });
});
