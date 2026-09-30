/**
 * 规则 01-master-switch：总开关与本群开关。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'master-switch',
  stage: 'intake',
  order: 1,
  paramsSpec: { enabled: true },
  evaluate(ctx) {
    // 验收1：总开关关闭 → 拦截
    if (ctx.params['enabled'] === false) {
      return { action: 'halt', reason: 'master-disabled' };
    }
    // 验收2：本群被 /listen off → 拦截
    if (ctx.state.runtimeEnabled === false) {
      return { action: 'halt', reason: 'group-disabled' };
    }
    // 验收3/4：放行
    return { action: 'pass' };
  },
};
