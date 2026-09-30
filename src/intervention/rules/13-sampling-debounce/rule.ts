/**
 * 规则 13-sampling-debounce：intake 终局，决定评估时机。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'sampling-debounce',
  stage: 'intake',
  order: 13,
  paramsSpec: { evaluateEvery: 6, silenceDebounceMs: 20_000 },
  evaluate(ctx) {
    // 验收1：强信号已标注 → 放行（runner 见 strongSignal 立即评估）
    if (ctx.marks.strongSignal !== undefined) return { action: 'pass' };

    // 验收4：FADING 相位阈值减半（最小 1）
    const base = Number(ctx.params['evaluateEvery'] ?? 6);
    const threshold =
      ctx.state.phaseAt(ctx.now) === 'fading' ? Math.max(1, Math.floor(base / 2)) : base;

    // 验收2/3：计数达标 → 标 samplingHit
    if (ctx.state.unevaluatedCount >= threshold) {
      return { action: 'mark', marks: { samplingHit: true } };
    }
    return { action: 'pass' };
  },
};
