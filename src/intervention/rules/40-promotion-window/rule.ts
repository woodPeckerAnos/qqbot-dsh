/**
 * 规则 40-promotion-window：续聊窗口内的晋升资格判定。
 * 需求真相源见同目录 REQUIREMENT.md；判定标准与其「判定」一节一一对应。
 */

import type { InterventionRule } from '../../contract.js';

/** 纯媒体占位（无实际文本）：[图片] / [语音] / [视频] / [文件] 等 */
const PURE_MEDIA_PLACEHOLDER = /^\s*(\[[^\]]{1,8}\]\s*)+$/;

export const rule: InterventionRule = {
  name: 'promotion-window',
  stage: 'continuation',
  order: 40,
  paramsSpec: { windowMs: 120_000 },
  evaluate(ctx) {
    // 验收7：非消息触发 → 拦截
    const message = ctx.message;
    if (message === undefined) return { action: 'halt', reason: 'no-message' };

    // 验收2：无窗口或窗口已过期 → 拦截
    const until = ctx.state.continuationWindowUntil(message.senderId);
    if (until === undefined || ctx.now > until) {
      return { action: 'halt', reason: 'no-window' };
    }

    // 验收3：重复事件 → 拦截（runner 在晋升/入队/入缓冲时认领 eventId）
    if (ctx.state.hasSeen(message.eventId)) {
      return { action: 'halt', reason: 'duplicate' };
    }

    // 验收4：@ 了其他成员 → 拦截（那是群员之间的对话，不是跟 bot 说）
    if (message.atOthers) return { action: 'halt', reason: 'at-others' };

    // 验收5：命令形态 → 拦截（命令路由是 @ 路径的职责，续聊不接管）
    if (/^\s*\//.test(message.content)) return { action: 'halt', reason: 'command' };

    // 验收6：纯媒体占位 → 拦截（没有可续聊的文本内容）
    if (PURE_MEDIA_PLACEHOLDER.test(message.content)) {
      return { action: 'halt', reason: 'no-text' };
    }

    // 验收1：全过 → 显式标注晋升资格（晋升的执行归 runner）
    return { action: 'mark', marks: { promote: true } };
  },
};
