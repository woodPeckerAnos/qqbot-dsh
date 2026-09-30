/**
 * 规则 41-inflight-merge 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import type { NormalizedObservedMessage } from '../../../core/connector.js';
import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

const NOW = 1_000_000;

function makeCtx(opts: { inFlight: boolean; withMessage?: boolean }): RuleContext {
  const state = new ConversationWatchState('ob11:g123', {
    maxMessages: 200,
    maxAgeMs: 72 * 3600 * 1000,
  });
  state.inFlight = opts.inFlight;
  const message: NormalizedObservedMessage = {
    kind: 'group-message-observed',
    target: { platform: 'onebot', kind: 'group', id: '123', key: 'ob11:g123' },
    eventId: 'ob11:1000:1',
    msgId: '1',
    senderId: '8888',
    content: '还有吗',
    atOthers: false,
    ts: NOW,
    raw: {},
  };
  return {
    message: opts.withMessage === false ? undefined : message,
    trigger: 'message',
    state,
    // 模拟上游 40 号规则已标注晋升资格
    marks: { promote: true },
    params: { maxPending: 5, maxAgeMs: 60_000 },
    now: NOW,
  };
}

describe('41-inflight-merge', () => {
  it('验收1：turn 在途 → mark(merge)', () => {
    const verdict = rule.evaluate(makeCtx({ inFlight: true }));
    expect(verdict).toEqual({ action: 'mark', marks: { merge: true } });
  });

  it('验收2：无在途 turn → pass', () => {
    const verdict = rule.evaluate(makeCtx({ inFlight: false }));
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收3：非消息触发 → halt(no-message)', () => {
    const verdict = rule.evaluate(makeCtx({ inFlight: true, withMessage: false }));
    expect(verdict).toEqual({ action: 'halt', reason: 'no-message' });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('inflight-merge');
    expect(rule.stage).toBe('continuation');
    expect(rule.order).toBe(41);
  });
});
