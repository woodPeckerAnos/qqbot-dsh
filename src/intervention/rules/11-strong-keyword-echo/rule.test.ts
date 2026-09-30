/**
 * 规则 11-strong-keyword-echo 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

const NOW = 10_000_000;

function makeCtx(opts: { content?: string; botText?: string; withMessage?: boolean }): RuleContext {
  const state = new ConversationWatchState('ob11:g123', { maxMessages: 200, maxAgeMs: 3_600_000 });
  if (opts.botText !== undefined) state.noteBotSpeech(NOW - 60_000, opts.botText);
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
            content: opts.content ?? '无关话题',
            atOthers: false,
            ts: NOW,
            raw: {},
          },
    trigger: 'message',
    state,
    marks: {},
    params: {},
    now: NOW,
  };
}

describe('11-strong-keyword-echo', () => {
  it('验收1：命中 bot 关键词 → mark(keyword-echo)', () => {
    const verdict = rule.evaluate(
      makeCtx({ botText: '可以用索引优化这条查询', content: '索引优化具体怎么做' }),
    );
    expect(verdict).toEqual({ action: 'mark', marks: { strongSignal: 'keyword-echo' } });
  });

  it('验收2：不含关键词 → pass', () => {
    const verdict = rule.evaluate(makeCtx({ botText: '可以用索引优化', content: '中午吃啥' }));
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收3：bot 关键词集为空 → pass', () => {
    expect(rule.evaluate(makeCtx({ content: '索引' }))).toEqual({ action: 'pass' });
  });

  it('验收4：非消息触发 → halt(no-message)', () => {
    expect(rule.evaluate(makeCtx({ withMessage: false }))).toEqual({
      action: 'halt',
      reason: 'no-message',
    });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('strong-keyword-echo');
    expect(rule.stage).toBe('intake');
    expect(rule.order).toBe(11);
  });
});
