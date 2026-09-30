/**
 * 规则 05-at-others：@ 了其他成员的消息不评估（但入缓冲做上下文）。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'at-others',
  stage: 'intake',
  order: 5,
  evaluate(ctx) {
    // 验收3：非消息触发 → 拦截（不带 buffer）
    const message = ctx.message;
    if (message === undefined) return { action: 'halt', reason: 'no-message' };
    // 验收1：@ 了别人 → 拦截但入缓冲
    if (message.atOthers) return { action: 'halt', reason: 'at-others', buffer: true };
    // 验收2：放行
    return { action: 'pass' };
  },
};
