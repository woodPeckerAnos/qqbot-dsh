/**
 * 规则 12-eval-cooldown：Gate 冷却期内不重复评估。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'eval-cooldown',
  stage: 'intake',
  order: 12,
  paramsSpec: { cooldownMs: 60_000, strongSignalCooldownMs: 15_000 },
  evaluate(ctx) {
    // 验收1：从未评估 → 放行
    const last = ctx.state.lastEvaluateAt;
    if (last === undefined) return { action: 'pass' };
    // 强信号由上游 08–11 号规则先行标注（本规则在其后执行，读得到 marks）
    const hasStrongSignal = ctx.marks.strongSignal !== undefined;
    const cooldown = hasStrongSignal
      ? Number(ctx.params['strongSignalCooldownMs'] ?? 15_000)
      : Number(ctx.params['cooldownMs'] ?? 60_000);
    // 验收2/5：冷却期内 → 拦截（但入缓冲做上下文——冷却丢的是评估不是语境）
    if (ctx.now - last < cooldown) {
      return { action: 'halt', reason: 'cooldown', buffer: true };
    }
    // 验收3/4：放行
    return { action: 'pass' };
  },
};
