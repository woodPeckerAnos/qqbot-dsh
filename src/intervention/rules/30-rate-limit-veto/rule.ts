/**
 * 规则 30-rate-limit-veto：发言前的硬限流终检（双闸之一）。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

const TEN_MIN_MS = 600_000;
const HOUR_MS = 3_600_000;

export const rule: InterventionRule = {
  name: 'rate-limit-veto',
  stage: 'speak',
  order: 30,
  paramsSpec: { maxPer10Min: 3, maxPerHour: 8 },
  evaluate(ctx) {
    // 验收1：10 分钟窗口满 → 否决
    if (ctx.state.countSpokeSince(ctx.now - TEN_MIN_MS) >= Number(ctx.params['maxPer10Min'] ?? 3)) {
      return { action: 'halt', reason: 'rate-limited-10min' };
    }
    // 验收2：1 小时窗口满 → 否决
    if (ctx.state.countSpokeSince(ctx.now - HOUR_MS) >= Number(ctx.params['maxPerHour'] ?? 8)) {
      return { action: 'halt', reason: 'rate-limited-1h' };
    }
    // 验收3/4：放行
    return { action: 'pass' };
  },
};
