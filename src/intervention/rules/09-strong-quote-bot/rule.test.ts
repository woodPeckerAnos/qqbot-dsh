/**
 * 规则 09-strong-quote-bot 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import type { NormalizedObservedMessage } from '../../../core/connector.js';
import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

const NOW = 10_000_000;

function makeCtx(opts: {
  quotedMsgId?: string;
  withMessage?: boolean;
  /** 缓冲里已有的一条群友消息 msgId（引用它 = 引群友） */
  bufferedMsgId?: string;
  botSpokeAgoMs?: number;
  botMsgIds?: string[];
}): RuleContext {
  const state = new ConversationWatchState('ob11:g123', { maxMessages: 200, maxAgeMs: 3_600_000 });
  if (opts.bufferedMsgId !== undefined) {
    state.pushEntry(
      {
        kind: 'group-message-observed',
        target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
        eventId: 'ob11:1000:99',
        msgId: opts.bufferedMsgId,
        senderId: '7777',
        content: '群友发言',
        atOthers: false,
        ts: NOW - 1000,
        raw: {},
      },
      NOW - 1000,
    );
  }
  if (opts.botSpokeAgoMs !== undefined) {
    state.noteBotSpeech(NOW - opts.botSpokeAgoMs, 'bot 发言', opts.botMsgIds ?? []);
  }
  const message: NormalizedObservedMessage = {
    kind: 'group-message-observed',
    target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
    eventId: 'ob11:1000:1',
    msgId: '1',
    senderId: '8888',
    content: '引用回复',
    atOthers: false,
    ts: NOW,
    raw: {},
    ...(opts.quotedMsgId !== undefined ? { quotedMsgId: opts.quotedMsgId } : {}),
  };
  return {
    message: opts.withMessage === false ? undefined : message,
    trigger: 'message',
    state,
    marks: {},
    params: { quoteWindowMs: 600_000 },
    now: NOW,
  };
}

describe('09-strong-quote-bot', () => {
  it('验收1：精确命中 bot 发言集 → mark(quote-bot)', () => {
    const verdict = rule.evaluate(
      makeCtx({ quotedMsgId: 'bot-msg-1', botSpokeAgoMs: 300_000_000, botMsgIds: ['bot-msg-1'] }),
    );
    expect(verdict).toEqual({ action: 'mark', marks: { strongSignal: 'quote-bot' } });
  });

  it('验收2：引用不在缓冲且 bot 近期发言过 → mark(quote-bot)', () => {
    const verdict = rule.evaluate(makeCtx({ quotedMsgId: 'unknown', botSpokeAgoMs: 300_000 }));
    expect(verdict).toEqual({ action: 'mark', marks: { strongSignal: 'quote-bot' } });
  });

  it('验收3：引用的是缓冲里的群友消息 → pass', () => {
    const verdict = rule.evaluate(
      makeCtx({ quotedMsgId: '42', bufferedMsgId: '42', botSpokeAgoMs: 10_000 }),
    );
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收4：无引用 → pass', () => {
    expect(rule.evaluate(makeCtx({}))).toEqual({ action: 'pass' });
  });

  it('验收5：引用不在缓冲但 bot 从未发言 → pass', () => {
    expect(rule.evaluate(makeCtx({ quotedMsgId: 'unknown' }))).toEqual({ action: 'pass' });
  });

  it('验收6：非消息触发 → halt(no-message)', () => {
    expect(rule.evaluate(makeCtx({ withMessage: false }))).toEqual({
      action: 'halt',
      reason: 'no-message',
    });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('strong-quote-bot');
    expect(rule.stage).toBe('intake');
    expect(rule.order).toBe(9);
  });
});
