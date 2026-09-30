/**
 * 规则 06-no-text：纯媒体/占位消息不评估（但入缓冲做上下文）。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

/** 全文只由 `[xxx]` 占位段构成（一段或多段） */
const PURE_PLACEHOLDER = /^\s*(\[[^\]]{1,8}\]\s*)+$/;

export const rule: InterventionRule = {
  name: 'no-text',
  stage: 'intake',
  order: 6,
  evaluate(ctx) {
    // 验收4：非消息触发 → 拦截（不带 buffer）
    const message = ctx.message;
    if (message === undefined) return { action: 'halt', reason: 'no-message' };
    // 验收1：纯占位 → 拦截但入缓冲
    if (PURE_PLACEHOLDER.test(message.content)) {
      return { action: 'halt', reason: 'no-text', buffer: true };
    }
    // 验收2/3：有实际文字 → 放行
    return { action: 'pass' };
  },
};
