/**
 * 规则 32-admission-try 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

const NOW = 10_000_000;

function makeCtx(opts: { inFlight?: boolean; admissionFree?: boolean }): RuleContext {
  const state = new ConversationWatchState('ob11:g123', { maxMessages: 200, maxAgeMs: 3_600_000 });
  state.inFlight = opts.inFlight ?? false;
  return {
    message: undefined,
    trigger: 'debounce',
    state,
    marks: { gateDecision: 'speak' },
    params: {},
    now: NOW,
    ...(opts.admissionFree !== undefined ? { admissionFree: opts.admissionFree } : {}),
  };
}

describe('32-admission-try', () => {
  it('验收1：会话有 turn 在途 → halt(inflight)', () => {
    expect(rule.evaluate(makeCtx({ inFlight: true }))).toEqual({
      action: 'halt',
      reason: 'inflight',
    });
  });

  it('验收2：全局并发满 → halt(busy)', () => {
    expect(rule.evaluate(makeCtx({ admissionFree: false }))).toEqual({
      action: 'halt',
      reason: 'busy',
    });
  });

  it('验收3：都空闲 → pass', () => {
    expect(rule.evaluate(makeCtx({ admissionFree: true }))).toEqual({ action: 'pass' });
  });

  it('验收4：无探针且锁空闲 → pass', () => {
    expect(rule.evaluate(makeCtx({}))).toEqual({ action: 'pass' });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('admission-try');
    expect(rule.stage).toBe('speak');
    expect(rule.order).toBe(32);
  });
});
