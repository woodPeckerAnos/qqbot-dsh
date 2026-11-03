/**
 * Ingress stage ①：事件去重。
 *
 * 位置理由：最前。重复投递（平台重推、网关重连后的重放）直接丢弃，
 * 不触发任何下游副作用（命令、闸、记录、名额）。
 *
 * eventId 为空时回退用 msgId——两种 id 都带平台命名空间，去重表全局共用。
 */
import type { SeenStore } from '@qqbot/contracts';
import type { PipelineStats } from '@qqbot/contracts';
import { logInputShortcut } from './types.js';
import type { IngressStage } from '@qqbot/contracts';

export function createDedupeStage(deps: { seen: SeenStore; stats: PipelineStats }): IngressStage {
  return async (ctx, next) => {
    const eventKey = ctx.message.eventId !== '' ? ctx.message.eventId : ctx.message.msgId;
    const result = deps.seen.claimResult(eventKey);
    if (!result.ok)
      ctx.logger.warn('去重持久化降级', {
        code: result.error.code,
        errorId: ctx.logger.cause(result.error.cause, 'persistence'),
      });
    const claimed = result.ok ? result.value : deps.seen.claimVolatile(eventKey);
    if (!claimed) {
      deps.stats.record('deduplicated', 1);
      logInputShortcut(ctx, 'dedupe', 'duplicate-event');
      return;
    }
    await next();
  };
}
