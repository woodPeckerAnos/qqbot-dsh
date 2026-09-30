/**
 * 规则 10-strong-open-question 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import type { NormalizedObservedMessage } from '../../../core/connector.js';
import { ConversationWatchState } from '../../state.js';
import type { RuleContext, RuleTrigger } from '../../contract.js';
import { rule } from './rule.js';

const NOW = 10_000_000;

function makeMessage(content: string, ts = NOW): NormalizedObservedMessage {
  return {
    kind: 'group-message-observed',
    target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
    eventId: `ob11:1000:${ts}`,
    msgId: String(ts),
    senderId: '8888',
    content,
    atOthers: false,
    ts,
    raw: {},
  };
}

function makeCtx(opts: {
  content?: string;
  trigger?: RuleTrigger;
  /** 重查时预置的缓冲条目（在问句之后到达的消息） */
  laterEntries?: Array<{ senderId: string; text: string }>;
  withMessage?: boolean;
}): RuleContext {
  const state = new ConversationWatchState('ob11:g123', { maxMessages: 200, maxAgeMs: 3_600_000 });
  const message = opts.content === undefined ? undefined : makeMessage(opts.content);
  if (opts.trigger === 'answer-window' && message !== undefined) {
    state.pushEntry(message, NOW); // 问句自己已在缓冲
    for (const [i, entry] of (opts.laterEntries ?? []).entries()) {
      state.pushEntry(
        { ...makeMessage(entry.text, NOW + (i + 1) * 1000), senderId: entry.senderId },
        NOW + (i + 1) * 1000,
      );
    }
  }
  return {
    message: opts.withMessage === false ? undefined : message,
    trigger: opts.trigger ?? 'message',
    state,
    marks: {},
    params: { answerWindowMs: 90_000 },
    now: NOW + 90_000,
  };
}

describe('10-strong-open-question', () => {
  it('验收1：首过问句 → defer(answer-window)', () => {
    const verdict = rule.evaluate(makeCtx({ content: '这个怎么部署？' }));
    expect(verdict).toEqual({ action: 'defer', ms: 90_000, reason: 'answer-window' });
  });

  it('验收2：首过非问句 → pass', () => {
    expect(rule.evaluate(makeCtx({ content: '今天天气不错' }))).toEqual({ action: 'pass' });
  });

  it('验收3：重查时已有他人应答 → halt(answered)', () => {
    const verdict = rule.evaluate(
      makeCtx({
        content: '有人在吗？',
        trigger: 'answer-window',
        laterEntries: [{ senderId: '9999', text: '我在' }],
      }),
    );
    expect(verdict).toEqual({ action: 'halt', reason: 'answered' });
  });

  it('验收4：重查时无人应答 → mark(open-question)', () => {
    const verdict = rule.evaluate(
      makeCtx({
        content: '有人在吗？',
        trigger: 'answer-window',
        laterEntries: [{ senderId: '8888', text: '还是自己追问' }],
      }),
    );
    expect(verdict).toEqual({ action: 'mark', marks: { strongSignal: 'open-question' } });
  });

  it('验收5：非消息触发且无消息 → halt(no-message)', () => {
    expect(rule.evaluate(makeCtx({ withMessage: false, trigger: 'debounce' }))).toEqual({
      action: 'halt',
      reason: 'no-message',
    });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('strong-open-question');
    expect(rule.stage).toBe('intake');
    expect(rule.order).toBe(10);
  });
});
