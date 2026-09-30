/**
 * 规则 06-no-text 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

function makeCtx(content: string | undefined): RuleContext {
  return {
    message:
      content === undefined
        ? undefined
        : {
            kind: 'group-message-observed',
            target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
            eventId: 'ob11:1000:1',
            msgId: '1',
            senderId: '8888',
            content,
            atOthers: false,
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

describe('06-no-text', () => {
  it('验收1：纯占位文本 → halt(no-text) 且入缓冲', () => {
    expect(rule.evaluate(makeCtx('[图片]'))).toEqual({
      action: 'halt',
      reason: 'no-text',
      buffer: true,
    });
    expect(rule.evaluate(makeCtx('[图片] [视频]'))).toEqual({
      action: 'halt',
      reason: 'no-text',
      buffer: true,
    });
  });

  it('验收2：占位符之外还有文字 → pass', () => {
    expect(rule.evaluate(makeCtx('[图片] 看这个实现'))).toEqual({ action: 'pass' });
  });

  it('验收3：普通文本 → pass', () => {
    expect(rule.evaluate(makeCtx('这个问题怎么解决'))).toEqual({ action: 'pass' });
  });

  it('验收4：非消息触发 → halt(no-message) 不带 buffer', () => {
    expect(rule.evaluate(makeCtx(undefined))).toEqual({ action: 'halt', reason: 'no-message' });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('no-text');
    expect(rule.stage).toBe('intake');
    expect(rule.order).toBe(6);
  });
});
