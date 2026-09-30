/**
 * 规则 03-offpeak-window：正价时段不评估介入（省 Gate 成本）。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'offpeak-window',
  stage: 'intake',
  order: 3,
  paramsSpec: { respectOffpeak: true },
  evaluate(ctx) {
    // 验收3：管理员显式放行 → 恒放行
    if (ctx.params['respectOffpeak'] === false) return { action: 'pass' };
    // 验收1：探针确认正价 → 拦截
    if (ctx.offpeakNow === false) return { action: 'halt', reason: 'peak-hours' };
    // 验收2/4：谷时段或探针缺位 → 放行
    return { action: 'pass' };
  },
};
