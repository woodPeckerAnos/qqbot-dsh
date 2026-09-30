/**
 * 规则 10-strong-open-question：问句挂答案窗口，无人应答才标强信号。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

/** 疑问词表（宁宽勿漏：误标只是多一次 Gate 判定） */
const QUESTION_WORDS = /吗|呢|怎么|为什么|哪|谁|啥|如何|有没有|能否|可否|是不是/;

function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  return /[？?]\s*$/.test(trimmed) || QUESTION_WORDS.test(trimmed);
}

export const rule: InterventionRule = {
  name: 'strong-open-question',
  stage: 'intake',
  order: 10,
  paramsSpec: { answerWindowMs: 90_000 },
  evaluate(ctx) {
    // 验收5：无消息 → 拦截
    const message = ctx.message;
    if (message === undefined) return { action: 'halt', reason: 'no-message' };

    if (ctx.trigger === 'answer-window') {
      // 验收3：窗口内有其他发送者的应答 → 作废
      const answered = ctx.state.entries.some(
        (entry) => entry.ts > message.ts && entry.senderId !== message.senderId,
      );
      if (answered) return { action: 'halt', reason: 'answered' };
      // 验收4：无人应答 → 标强信号
      return { action: 'mark', marks: { strongSignal: 'open-question' } };
    }

    // 验收1/2：首过——问句挂窗口，非问句放行
    if (isQuestion(message.content)) {
      return {
        action: 'defer',
        ms: Number(ctx.params['answerWindowMs'] ?? 90_000),
        reason: 'answer-window',
      };
    }
    return { action: 'pass' };
  },
};
