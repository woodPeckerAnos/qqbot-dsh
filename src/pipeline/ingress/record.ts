/**
 * Ingress stage ④：记录用户消息到对话记录（供重启后冷启动回放）。
 *
 * 位置理由：在闸之后——被拦截的消息不进对话记录，避免伪造的 turn
 * 混进会话历史污染回放；在准入之前——消息先落盘再排队，崩溃也不丢。
 */

import type { ConversationStore } from '../../store/conversations.js';
import type { IngressStage } from './types.js';

export function createRecordStage(deps: { conversations: ConversationStore }): IngressStage {
  return async (ctx, next) => {
    deps.conversations.append(ctx.message.target.key, {
      role: 'user',
      speaker: ctx.message.username ?? ctx.message.senderId,
      text: ctx.message.content,
      ts: ctx.message.ts,
    });
    await next();
  };
}
