/**
 * 规则 33-night-silence-veto 单测：逐条覆盖 REQUIREMENT.md 的验收标准。
 */

import { describe, expect, it } from 'vitest';

import { ConversationWatchState } from '../../state.js';
import type { RuleContext } from '../../contract.js';
import { rule } from './rule.js';

function makeCtx(overrides: {
  now: number;
  startHour?: number;
  endHour?: number;
  timezoneOffset?: number;
  params?: Record<string, number>;
}): RuleContext {
  const state = new ConversationWatchState('ob11:g1', {
    maxMessages: 200,
    maxAgeMs: 72 * 3600 * 1000,
  });
  const params: Record<string, number> = {
    startHour: overrides.startHour ?? 23,
    endHour: overrides.endHour ?? 8,
    timezoneOffset: overrides.timezoneOffset ?? 8,
    ...(overrides.params ?? {}),
  };
  return {
    message: undefined,
    trigger: 'message',
    state,
    marks: {},
    params,
    now: overrides.now,
  };
}

describe('33-night-silence-veto', () => {
  it('验收1：北京时间 23:00 → halt(night-silence)', async () => {
    const verdict = await rule.evaluate(makeCtx({ now: 1704121200000 }));
    expect(verdict).toEqual({ action: 'halt', reason: 'night-silence' });
  });

  it('验收2：北京时间 07:59 → halt(night-silence)', async () => {
    const verdict = await rule.evaluate(makeCtx({ now: 1704153540000 }));
    expect(verdict).toEqual({ action: 'halt', reason: 'night-silence' });
  });

  it('验收3：北京时间 08:00 → pass（endHour 不含）', async () => {
    const verdict = await rule.evaluate(makeCtx({ now: 1704153600000 }));
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收4：北京时间 22:59 → pass（23:00 前不入窗口）', async () => {
    const verdict = await rule.evaluate(makeCtx({ now: 1704121140000 }));
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收5：北京时间次日 00:00 → halt(night-silence)（跨日窗口）', async () => {
    const verdict = await rule.evaluate(makeCtx({ now: 1704124800000 }));
    expect(verdict).toEqual({ action: 'halt', reason: 'night-silence' });
  });

  it('验收6：北京时间 12:00 → pass', async () => {
    const verdict = await rule.evaluate(makeCtx({ now: 1704081600000 }));
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('验收7：参数可配 startHour=1/endHour=5 → 02:00 halt、06:00 pass', async () => {
    const hit = await rule.evaluate(
      makeCtx({ now: 1704132000000, startHour: 1, endHour: 5 }),
    );
    expect(hit).toEqual({ action: 'halt', reason: 'night-silence' });

    const miss = await rule.evaluate(
      makeCtx({ now: 1704146400000, startHour: 1, endHour: 5 }),
    );
    expect(miss).toEqual({ action: 'pass' });
  });

  it('验收8：起止相等视为空窗口 → 08:00 与 23:00 均 pass', async () => {
    const at8 = await rule.evaluate(
      makeCtx({ now: 1704153600000, startHour: 8, endHour: 8 }),
    );
    expect(at8).toEqual({ action: 'pass' });

    const at23 = await rule.evaluate(
      makeCtx({ now: 1704121200000, startHour: 8, endHour: 8 }),
    );
    expect(at23).toEqual({ action: 'pass' });
  });

  it('验收9：时区偏移可配 → offset=8 halt，offset=0 pass', async () => {
    const withOffset = await rule.evaluate(
      makeCtx({ now: 1704124800000, timezoneOffset: 8 }),
    );
    expect(withOffset).toEqual({ action: 'halt', reason: 'night-silence' });

    const withoutOffset = await rule.evaluate(
      makeCtx({ now: 1704124800000, timezoneOffset: 0 }),
    );
    expect(withoutOffset).toEqual({ action: 'pass' });
  });

  it('验收10：元数据与 reason 形态可离线断言', async () => {
    expect(rule.stage).toBe('speak');
    expect(rule.order).toBe(33);

    const hit = await rule.evaluate(makeCtx({ now: 1704121200000 }));
    expect(hit).toEqual({ action: 'halt', reason: 'night-silence' });
    expect('reason' in hit && hit.reason).toBe('night-silence');

    const miss = await rule.evaluate(makeCtx({ now: 1704081600000 }));
    expect(miss).toEqual({ action: 'pass' });
    expect(miss.action === 'halt').toBe(false);
  });

  it('验收11：纯函数性——重复调用一致，且不修改 ctx.now / 共享状态', async () => {
    const ctx = makeCtx({ now: 1704121200000 });
    const snapshotNow = ctx.now;
    const snapshotParams = { ...ctx.params };

    const first = await rule.evaluate(ctx);
    const second = await rule.evaluate(ctx);
    const third = await rule.evaluate(ctx);

    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(ctx.now).toBe(snapshotNow);
    expect({ ...ctx.params }).toEqual(snapshotParams);
  });

  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('night-silence-veto');
    expect(rule.stage).toBe('speak');
    expect(rule.order).toBe(33);
  });
});