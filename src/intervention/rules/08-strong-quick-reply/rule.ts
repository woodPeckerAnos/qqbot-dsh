/**
 * 规则 08-strong-quick-reply：bot 发言后 30s 内的消息标强信号。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'strong-quick-reply',
  stage: 'intake',
  order: 8,
  paramsSpec: { quickResponseMs: 30_000 },
  evaluate(ctx) {
    // 验收4：非消息触发 → 拦截
    if (ctx.message === undefined) return { action: 'halt', reason: 'no-message' };
    const lastSpoke = ctx.state.botLastSpokeAt;
    const windowMs = Number(ctx.params['quickResponseMs'] ?? 30_000);
    // 验收1：快速回应窗口内 → 标强信号
    if (lastSpoke !== undefined && ctx.now - lastSpoke <= windowMs) {
      return { action: 'mark', marks: { strongSignal: 'quick-reply' } };
    }
    // 验收2/3：放行
    return { action: 'pass' };
  },
};
