/**
 * 规则 02-group-whitelist：只有显式授权的群才被旁听。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'group-whitelist',
  stage: 'intake',
  order: 2,
  paramsSpec: { groups: '' },
  evaluate(ctx) {
    // 验收4：本群被 /listen on 热开启 → 放行（不查静态白名单）
    if (ctx.state.runtimeEnabled === true) return { action: 'pass' };

    // 验收5：无消息上下文 → fail-closed
    const message = ctx.message;
    if (message === undefined) return { action: 'halt', reason: 'no-message' };

    const groups = String(ctx.params['groups'] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');

    // 验收1/2：两种条目形式都接受——会话键（ob11:g123）或 平台:群号（onebot:123）
    const { target } = message;
    if (groups.includes(target.key) || groups.includes(`${target.platform}:${target.id}`)) {
      return { action: 'pass' };
    }
    // 验收3：不在白名单 → 拦截
    return { action: 'halt', reason: 'not-whitelisted' };
  },
};
