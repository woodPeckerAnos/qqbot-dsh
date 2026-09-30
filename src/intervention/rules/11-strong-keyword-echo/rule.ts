/**
 * 规则 11-strong-keyword-echo：命中 bot 发言关键词标强信号。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'strong-keyword-echo',
  stage: 'intake',
  order: 11,
  evaluate(ctx) {
    // 验收4：非消息触发 → 拦截
    const message = ctx.message;
    if (message === undefined) return { action: 'halt', reason: 'no-message' };
    // 验收1/3：命中关键词 → 标强信号；空集 → 放行
    for (const keyword of ctx.state.botKeywords) {
      if (keyword !== '' && message.content.includes(keyword)) {
        return { action: 'mark', marks: { strongSignal: 'keyword-echo' } };
      }
    }
    // 验收2：放行
    return { action: 'pass' };
  },
};
