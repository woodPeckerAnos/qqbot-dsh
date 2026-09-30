/**
 * 规则 04-duplicate-event 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import type { NormalizedObservedMessage } from '../../../core/connector.js';
import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

function makeMessage(eventId: string): NormalizedObservedMessage {
  return {
    kind: 'group-message-observed',
    target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
    eventId,
    msgId: '1',
    senderId: '8888',
    content: '有人在吗',
    atOthers: false,
    ts: 1_000_000,
    raw: {},
  };
}

function makeCtx(eventId: string, opts: { seen?: boolean; withMessage?: boolean }): RuleContext {
  const state = new ConversationWatchState('ob11:g123', {
    maxMessages: 200,
    maxAgeMs: 72 * 3600 * 1000,
  });
  if (opts.seen === true) state.seen.claim(eventId);
  return {
    message: opts.withMessage === false ? undefined : makeMessage(eventId),
    trigger: 'message',
    state,
    marks: {},
    params: {},
    now: 1_000_000,
  };
}

describe('04-duplicate-event', () => {
  it('验收1：首次到达 → pass', () => {
    const verdict = rule.evaluate(makeCtx('ob11:1000:1', {}));
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收2：同一 eventId 重放 → halt(duplicate)', () => {
    const verdict = rule.evaluate(makeCtx('ob11:1000:1', { seen: true }));
    expect(verdict).toEqual({ action: 'halt', reason: 'duplicate' });
  });

  it('验收3：eventId 为空串不去重 → pass', () => {
    const verdict = rule.evaluate(makeCtx('', { seen: true }));
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收4：无消息上下文 → halt(no-message)', () => {
    const verdict = rule.evaluate(makeCtx('x', { withMessage: false }));
    expect(verdict).toEqual({ action: 'halt', reason: 'no-message' });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('duplicate-event');
    expect(rule.stage).toBe('intake');
    expect(rule.order).toBe(4);
  });
});
