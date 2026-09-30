/**
 * 规则 41-inflight-merge：turn 在途时晋升转入 pending 合并队列。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'inflight-merge',
  stage: 'continuation',
  order: 41,
  paramsSpec: { maxPending: 5, maxAgeMs: 60_000 },
  evaluate(ctx) {
    // 验收3：非消息触发 → 拦截
    if (ctx.message === undefined) return { action: 'halt', reason: 'no-message' };

    // 验收2：无在途 turn → 放行（runner 直接晋升回投）
    if (!ctx.state.inFlight) return { action: 'pass' };

    // 验收1：在途 → 标注转入 pending 合并队列（入队/淘汰/冲刷归 runner，
    // 容量与保鲜期取本规则的 params 生效值）
    return { action: 'mark', marks: { merge: true } };
  },
};
