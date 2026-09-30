/**
 * 规则 09-strong-quote-bot：引用 bot 消息标强信号（精确 + 启发式两层）。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'strong-quote-bot',
  stage: 'intake',
  order: 9,
  paramsSpec: { quoteWindowMs: 600_000 },
  evaluate(ctx) {
    // 验收6：非消息触发 → 拦截
    const message = ctx.message;
    if (message === undefined) return { action: 'halt', reason: 'no-message' };
    // 验收4：无引用 → 放行
    const quoted = message.quotedMsgId;
    if (quoted === undefined) return { action: 'pass' };

    // 验收1：精确命中 bot 发言集 → 标强信号
    if (ctx.state.botHasSpoken(quoted)) {
      return { action: 'mark', marks: { strongSignal: 'quote-bot' } };
    }

    // 验收3：引用的是缓冲里的群友消息 → 放行
    if (ctx.state.entries.some((entry) => entry.msgId === quoted)) {
      return { action: 'pass' };
    }

    // 验收2/5：启发式——引的不是近期群友消息，且 bot 在窗口内发言过
    const lastSpoke = ctx.state.botLastSpokeAt;
    const windowMs = Number(ctx.params['quoteWindowMs'] ?? 600_000);
    if (lastSpoke !== undefined && ctx.now - lastSpoke <= windowMs) {
      return { action: 'mark', marks: { strongSignal: 'quote-bot' } };
    }
    return { action: 'pass' };
  },
};
