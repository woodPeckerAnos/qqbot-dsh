/**
 * 规则 01-master-switch 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

function makeCtx(overrides: {
  enabled?: boolean;
  runtimeEnabled?: boolean;
}): RuleContext {
  const state = new ConversationWatchState('ob11:g1', {
    maxMessages: 200,
    maxAgeMs: 72 * 3600 * 1000,
  });
  if (overrides.runtimeEnabled !== undefined) {
    state.runtimeEnabled = overrides.runtimeEnabled;
  }
  return {
    message: undefined,
    trigger: 'message',
    state,
    marks: {},
    params: { enabled: overrides.enabled ?? true },
    now: 1_000_000,
  };
}

describe('01-master-switch', () => {
  it('验收1：总开关关闭 → halt(master-disabled)', () => {
    const verdict = rule.evaluate(makeCtx({ enabled: false }));
    expect(verdict).toEqual({ action: 'halt', reason: 'master-disabled' });
  });

  it('验收2：本群被 /listen off → halt(group-disabled)', () => {
    const verdict = rule.evaluate(makeCtx({ runtimeEnabled: false }));
    expect(verdict).toEqual({ action: 'halt', reason: 'group-disabled' });
  });

  it('验收3：总开关开、群开关未设置 → pass', () => {
    const verdict = rule.evaluate(makeCtx({}));
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收4：总开关开、本群 /listen on → pass', () => {
    const verdict = rule.evaluate(makeCtx({ runtimeEnabled: true }));
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('master-switch');
    expect(rule.stage).toBe('intake');
    expect(rule.order).toBe(1);
  });
});
