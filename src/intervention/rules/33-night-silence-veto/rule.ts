/**
 * 规则 33-night-silence-veto：夜间静默否决。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

/** 把 epoch 毫秒换算成指定时区的「当日毫秒偏移」（0 ≤ x < 86400000）。 */
function localMsOfDay(nowMs: number, timezoneOffset: number): number {
  const shifted = nowMs + timezoneOffset * 3_600_000;
  return ((shifted % 86_400_000) + 86_400_000) % 86_400_000;
}

export const rule: InterventionRule = {
  name: 'night-silence-veto',
  stage: 'speak',
  order: 33,
  paramsSpec: { startHour: 23, endHour: 8, timezoneOffset: 8 },
  evaluate(ctx) {
    const startHour = ctx.params['startHour'];
    const endHour = ctx.params['endHour'];
    const timezoneOffset = ctx.params['timezoneOffset'];

    // fail-closed 的前提是参数可用；参数缺失/非法时无法判定 → 拦截。
    if (
      typeof startHour !== 'number' ||
      typeof endHour !== 'number' ||
      typeof timezoneOffset !== 'number' ||
      !Number.isFinite(startHour) ||
      !Number.isFinite(endHour) ||
      !Number.isFinite(timezoneOffset)
    ) {
      return { action: 'halt', reason: 'night-silence' };
    }

    const rawNow = ctx.now as unknown;
    let nowMs: number;
    if (rawNow instanceof Date) {
      nowMs = rawNow.getTime();
    } else if (typeof rawNow === 'number') {
      nowMs = rawNow;
    } else {
      return { action: 'halt', reason: 'night-silence' };
    }

    if (!Number.isFinite(nowMs)) {
      return { action: 'halt', reason: 'night-silence' };
    }

    const localHour = Math.floor(localMsOfDay(nowMs, timezoneOffset) / 3_600_000);

    // 验收8：起止相等 → 空窗口，永不命中。
    if (startHour === endHour) {
      return { action: 'pass' };
    }

    const hit =
      startHour < endHour
        ? localHour >= startHour && localHour < endHour
        : localHour >= startHour || localHour < endHour;

    // 验收1/2/5/7/9：命中夜间窗口 → 否决。
    if (hit) {
      return { action: 'halt', reason: 'night-silence' };
    }
    // 验收3/4/6：未命中 → 放行。
    return { action: 'pass' };
  },
};