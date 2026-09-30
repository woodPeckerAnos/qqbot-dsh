/**
 * 规则 31-focus-budget：FOCUS 相位内的发言预算否决。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'focus-budget',
  stage: 'speak',
  order: 31,
  paramsSpec: { focusMs: 120_000, fadingMs: 120_000, focusMaxReplies: 2 },
  evaluate(ctx) {
    const phase = ctx.state.phaseAt(ctx.now);
    // 验收1：FADING 降级期不再主动插话
    if (phase === 'fading') return { action: 'halt', reason: 'fading-no-speak' };
    // 验收2：FOCUS 预算用完 → 否决
    if (
      phase === 'focus' &&
      ctx.state.focusSpokeCountAt(ctx.now) >= Number(ctx.params['focusMaxReplies'] ?? 2)
    ) {
      return { action: 'halt', reason: 'focus-exhausted' };
    }
    // 验收3/4：放行
    return { action: 'pass' };
  },
};
