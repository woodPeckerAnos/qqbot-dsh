/**
 * 规则 07-rate-limit-precheck：达硬限流的群不再评估（省 Gate 成本）。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

const TEN_MIN_MS = 600_000;
const HOUR_MS = 3_600_000;

export const rule: InterventionRule = {
  name: 'rate-limit-precheck',
  stage: 'intake',
  order: 7,
  paramsSpec: { maxPer10Min: 3, maxPerHour: 8 },
  evaluate(ctx) {
    const maxPer10Min = Number(ctx.params['maxPer10Min'] ?? 3);
    const maxPerHour = Number(ctx.params['maxPerHour'] ?? 8);
    // 验收1：10 分钟窗口满 → 拦截
    if (ctx.state.countSpokeSince(ctx.now - TEN_MIN_MS) >= maxPer10Min) {
      return { action: 'halt', reason: 'rate-limited-10min' };
    }
    // 验收2：1 小时窗口满 → 拦截
    if (ctx.state.countSpokeSince(ctx.now - HOUR_MS) >= maxPerHour) {
      return { action: 'halt', reason: 'rate-limited-1h' };
    }
    // 验收3/4：放行
    return { action: 'pass' };
  },
};
