/**
 * 规则 32-admission-try：准入可行性的预检否决（原子 try 归 runner）。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'admission-try',
  stage: 'speak',
  order: 32,
  evaluate(ctx) {
    // 验收1：会话锁被占 → 否决（介入绝不排队）
    if (ctx.state.inFlight) return { action: 'halt', reason: 'inflight' };
    // 验收2：全局并发满 → 否决
    if (ctx.admissionFree === false) return { action: 'halt', reason: 'busy' };
    // 验收3/4：放行
    return { action: 'pass' };
  },
};
