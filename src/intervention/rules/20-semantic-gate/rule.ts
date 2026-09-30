/**
 * 规则 20-semantic-gate：这个话题值不值得插话（全链唯一语义判定点）。
 * 需求真相源见同目录 REQUIREMENT.md——其「需求描述」正文即 Gate 判定标准
 * 的来源（params.criteria 是它的逐字投影，方案 §5.6）。
 */

import type { InterventionRule } from '../../contract.js';

/** 判定标准正文（= REQUIREMENT.md「需求描述」的投影；qqbot.yml 可覆盖） */
export const DEFAULT_CRITERIA =
  'speak 的必要条件（宁缺勿滥）：存在无人回答且 bot 能答的问题；需要事实性纠错；' +
  '与 bot 近期任务或明确专长直接相关且有信息增量。silent：闲聊、情绪话题、' +
  '已被群友充分回答、bot 无信息增量、信息不足。wait：话题正在展开、' +
  '再等一会更合适（仅此一种情形给 wait）。';

export const rule: InterventionRule = {
  name: 'semantic-gate',
  stage: 'evaluate',
  order: 20,
  paramsSpec: { contextMessages: 30, waitRetryMs: 30_000, criteria: DEFAULT_CRITERIA },
  async evaluate(ctx) {
    // 验收5：未注入 Gate 能力 → 拦截（fail-closed）
    const gate = ctx.gate;
    if (gate === undefined) return { action: 'halt', reason: 'gate-unavailable' };

    const verdict = await gate.judge({
      transcript: ctx.transcript?.() ?? '',
      stateSummary: ctx.stateSummary?.() ?? '',
      criteria: String(ctx.params['criteria'] ?? DEFAULT_CRITERIA),
    });

    if (verdict.decision === 'silent') {
      // 验收1
      return { action: 'halt', reason: 'gate-silent' };
    }
    if (verdict.decision === 'speak') {
      // 验收2
      return { action: 'mark', marks: { gateDecision: 'speak' } };
    }
    // wait：验收3（首查延迟重查）/ 验收4（重查再 wait 直接拦掉，不无限推迟）
    if (ctx.trigger === 'gate-wait-recheck') {
      return { action: 'halt', reason: 'gate-wait-twice' };
    }
    return {
      action: 'defer',
      ms: Number(ctx.params['waitRetryMs'] ?? 30_000),
      reason: 'gate-wait',
    };
  },
};
