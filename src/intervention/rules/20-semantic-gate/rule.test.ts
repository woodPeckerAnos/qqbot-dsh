/**
 * 规则 20-semantic-gate 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import { ConversationWatchState } from '../../state.js';
import type { GateClient, GateVerdict, RuleContext, RuleTrigger } from '../../contract.js';
import { rule } from './rule.js';

const NOW = 10_000_000;

function fakeGate(verdict: GateVerdict): GateClient & { calls: number } {
  return {
    calls: 0,
    async judge() {
      this.calls += 1;
      return verdict;
    },
  };
}

function makeCtx(opts: { verdict?: GateVerdict; trigger?: RuleTrigger }): RuleContext {
  return {
    message: undefined,
    trigger: opts.trigger ?? 'debounce',
    state: new ConversationWatchState('ob11:g123', { maxMessages: 200, maxAgeMs: 3_600_000 }),
    marks: {},
    params: { contextMessages: 30, waitRetryMs: 30_000, criteria: '测试判定标准' },
    now: NOW,
    ...(opts.verdict !== undefined ? { gate: fakeGate(opts.verdict) } : {}),
    transcript: () => '<群聊转录>…</群聊转录>',
    stateSummary: () => '<bot状态>…</bot状态>',
  };
}

describe('20-semantic-gate', () => {
  it('验收1：Gate 判 silent → halt(gate-silent)', async () => {
    const verdict = await rule.evaluate(makeCtx({ verdict: { decision: 'silent', reason: '闲聊' } }));
    expect(verdict).toEqual({ action: 'halt', reason: 'gate-silent' });
  });

  it('验收2：Gate 判 speak → mark(gateDecision=speak)', async () => {
    const verdict = await rule.evaluate(makeCtx({ verdict: { decision: 'speak', reason: '无人回答' } }));
    expect(verdict).toEqual({ action: 'mark', marks: { gateDecision: 'speak' } });
  });

  it('验收3：Gate 判 wait（首查）→ defer(30s, gate-wait)', async () => {
    const verdict = await rule.evaluate(makeCtx({ verdict: { decision: 'wait', reason: '展开中' } }));
    expect(verdict).toEqual({ action: 'defer', ms: 30_000, reason: 'gate-wait' });
  });

  it('验收4：Gate 判 wait（重查）→ halt(gate-wait-twice)', async () => {
    const verdict = await rule.evaluate(
      makeCtx({ verdict: { decision: 'wait', reason: '还在展开' }, trigger: 'gate-wait-recheck' }),
    );
    expect(verdict).toEqual({ action: 'halt', reason: 'gate-wait-twice' });
  });

  it('验收5：未注入 gate → halt(gate-unavailable)', async () => {
    const verdict = await rule.evaluate(makeCtx({}));
    expect(verdict).toEqual({ action: 'halt', reason: 'gate-unavailable' });
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('semantic-gate');
    expect(rule.stage).toBe('evaluate');
    expect(rule.order).toBe(20);
  });
});
