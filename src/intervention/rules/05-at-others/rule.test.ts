/**
 * 规则 05-at-others 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

function makeCtx(opts: { atOthers: boolean; withMessage?: boolean }): RuleContext {
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
            content: '@小红 你看这个',
            atOthers: opts.atOthers,
            ts: 1_000_000,
            raw: {},
          },
    trigger: 'message',
    state: new ConversationWatchState('ob11:g123', { maxMessages: 200, maxAgeMs: 3_600_000 }),
    marks: {},
    params: {},
    now: 1_000_000,
  };
}

describe('05-at-others', () => {
  it('验收1：@ 了别人 → halt(at-others) 且入缓冲', () => {
    expect(rule.evaluate(makeCtx({ atOthers: true }))).toEqual({
      action: 'halt',
      reason: 'at-others',
      buffer: true,
    });
  });

  it('验收2：未 @ 别人 → pass', () => {
    expect(rule.evaluate(makeCtx({ atOthers: false }))).toEqual({ action: 'pass' });
  });

  it('验收3：非消息触发 → halt(no-message) 不带 buffer', () => {
    expect(rule.evaluate(makeCtx({ atOthers: false, withMessage: false }))).toEqual({
      action: 'halt',
      reason: 'no-message',
    });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('at-others');
    expect(rule.stage).toBe('intake');
    expect(rule.order).toBe(5);
  });
});
