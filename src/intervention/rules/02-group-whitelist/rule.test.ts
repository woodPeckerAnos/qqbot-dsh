/**
 * 规则 02-group-whitelist 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import type { NormalizedObservedMessage } from '../../../core/connector.js';
import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

function makeMessage(groupId: string): NormalizedObservedMessage {
  return {
    kind: 'group-message-observed',
    target: {
      platform: 'onebot',
      kind: 'group',
      id: groupId,
      key: `ob11:g${groupId}`,
    },
    eventId: `ob11:1000:1`,
    msgId: '1',
    senderId: '8888',
    content: '有人在吗',
    atOthers: false,
    ts: 1_000_000,
    raw: {},
  };
}

function makeCtx(overrides: {
  groups?: string;
  runtimeEnabled?: boolean;
  withMessage?: boolean;
}): RuleContext {
  const state = new ConversationWatchState('ob11:g123', {
    maxMessages: 200,
    maxAgeMs: 72 * 3600 * 1000,
  });
  if (overrides.runtimeEnabled !== undefined) {
    state.runtimeEnabled = overrides.runtimeEnabled;
  }
  return {
    message: overrides.withMessage === false ? undefined : makeMessage('123'),
    trigger: 'message',
    state,
    marks: {},
    params: { groups: overrides.groups ?? '' },
    now: 1_000_000,
  };
}

describe('02-group-whitelist', () => {
  it('验收1：白名单含会话键形式 → pass', () => {
    const verdict = rule.evaluate(makeCtx({ groups: 'ob11:g123,ob11:g456' }));
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收2：白名单含 平台:群号 形式 → pass', () => {
    const verdict = rule.evaluate(makeCtx({ groups: 'onebot:123' }));
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收3：群不在白名单且未热开启 → halt(not-whitelisted)', () => {
    const verdict = rule.evaluate(makeCtx({ groups: 'onebot:999' }));
    expect(verdict).toEqual({ action: 'halt', reason: 'not-whitelisted' });
  });

  it('验收4：不在白名单但被 /listen on → pass', () => {
    const verdict = rule.evaluate(
      makeCtx({ groups: '', runtimeEnabled: true }),
    );
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收5：无消息上下文 → halt(no-message)', () => {
    const verdict = rule.evaluate(makeCtx({ withMessage: false }));
    expect(verdict).toEqual({ action: 'halt', reason: 'no-message' });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('group-whitelist');
    expect(rule.stage).toBe('intake');
    expect(rule.order).toBe(2);
  });
});
