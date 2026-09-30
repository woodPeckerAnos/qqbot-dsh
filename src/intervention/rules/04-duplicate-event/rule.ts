/**
 * 规则 04-duplicate-event：框架重放的重复事件只入缓冲一次。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'duplicate-event',
  stage: 'intake',
  order: 4,
  evaluate(ctx) {
    // 验收4：无消息上下文 → fail-closed
    const message = ctx.message;
    if (message === undefined) return { action: 'halt', reason: 'no-message' };
    // 验收3：空 eventId 不去重（无法判定，按首次处理）
    if (message.eventId === '') return { action: 'pass' };
    // 验收2：已被 runner 记录过 → 拦截
    if (ctx.state.hasSeen(message.eventId)) {
      return { action: 'halt', reason: 'duplicate' };
    }
    // 验收1：首次 → 放行（记录由 runner 在入缓冲时完成）
    return { action: 'pass' };
  },
};
