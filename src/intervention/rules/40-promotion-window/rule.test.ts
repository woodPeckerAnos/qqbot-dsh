/**
 * 规则 40-promotion-window 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import type { NormalizedObservedMessage } from '../../../core/connector.js';
import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

const NOW = 1_000_000;

function makeMessage(overrides: Partial<NormalizedObservedMessage> = {}): NormalizedObservedMessage {
  return {
    kind: 'group-message-observed',
    target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
    eventId: 'ob11:1000:1',
    msgId: '1',
    senderId: '8888',
    content: '那这个方案的缺点呢',
    atOthers: false,
    ts: NOW,
    raw: {},
    ...overrides,
  };
}

function makeCtx(opts: {
  message?: NormalizedObservedMessage | false;
  /** 给发送者开一个窗口（截止时刻）；缺省不开 */
  windowUntil?: number;
  /** 预认领 eventId（模拟已处理过） */
  seen?: boolean;
}): RuleContext {
  const state = new ConversationWatchState('ob11:g123', {
    maxMessages: 200,
    maxAgeMs: 72 * 3600 * 1000,
  });
  const message = opts.message === false ? undefined : (opts.message ?? makeMessage());
  if (opts.windowUntil !== undefined && message !== undefined) {
    state.openContinuationWindow(message.senderId, opts.windowUntil);
  }
  if (opts.seen === true && message !== undefined) state.seen.claim(message.eventId);
  return {
    message,
    trigger: 'message',
    state,
    marks: {},
    params: { windowMs: 120_000 },
    now: NOW,
  };
}

describe('40-promotion-window', () => {
  it('验收1：窗口内合格消息 → mark(promote)', () => {
    const verdict = rule.evaluate(makeCtx({ windowUntil: NOW + 60_000 }));
    expect(verdict).toEqual({ action: 'mark', marks: { promote: true } });
  });

  it('验收2：无窗口 → halt(no-window)', () => {
    const verdict = rule.evaluate(makeCtx({}));
    expect(verdict).toEqual({ action: 'halt', reason: 'no-window' });
  });

  it('验收2：窗口已过期 → halt(no-window)', () => {
    const verdict = rule.evaluate(makeCtx({ windowUntil: NOW - 1 }));
    expect(verdict).toEqual({ action: 'halt', reason: 'no-window' });
  });

  it('验收3：重复 eventId → halt(duplicate)', () => {
    const verdict = rule.evaluate(makeCtx({ windowUntil: NOW + 60_000, seen: true }));
    expect(verdict).toEqual({ action: 'halt', reason: 'duplicate' });
  });

  it('验收4：@ 了其他成员 → halt(at-others)', () => {
    const verdict = rule.evaluate(
      makeCtx({ windowUntil: NOW + 60_000, message: makeMessage({ atOthers: true }) }),
    );
    expect(verdict).toEqual({ action: 'halt', reason: 'at-others' });
  });

  it('验收5：命令形态 → halt(command)', () => {
    const verdict = rule.evaluate(
      makeCtx({ windowUntil: NOW + 60_000, message: makeMessage({ content: '/listen off' }) }),
    );
    expect(verdict).toEqual({ action: 'halt', reason: 'command' });
  });

  it('验收6：纯媒体占位 → halt(no-text)', () => {
    const verdict = rule.evaluate(
      makeCtx({ windowUntil: NOW + 60_000, message: makeMessage({ content: '[图片]' }) }),
    );
    expect(verdict).toEqual({ action: 'halt', reason: 'no-text' });
  });

  it('验收7：非消息触发 → halt(no-message)', () => {
    const verdict = rule.evaluate(makeCtx({ message: false }));
    expect(verdict).toEqual({ action: 'halt', reason: 'no-message' });
  });

  it('判定顺序：无窗口优先于重复与 @别人（trace 直指根因）', () => {
    const verdict = rule.evaluate(
      makeCtx({
        seen: true,
        message: makeMessage({ atOthers: true }),
      }),
    );
    expect(verdict).toEqual({ action: 'halt', reason: 'no-window' });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('promotion-window');
    expect(rule.stage).toBe('continuation');
    expect(rule.order).toBe(40);
  });
});
