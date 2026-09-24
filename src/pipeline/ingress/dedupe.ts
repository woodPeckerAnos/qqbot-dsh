/**
 * Ingress stage ①：事件去重。
 *
 * 位置理由：最前。重复投递（平台重推、网关重连后的重放）直接丢弃，
 * 不触发任何下游副作用（命令、闸、记录、名额）。
 *
 * eventId 为空时回退用 msgId——两种 id 都带平台命名空间，去重表全局共用。
 */

import type { SeenStore } from '../../store/seen.js';
import type { PipelineStats } from '../stats.js';
import type { IngressStage } from './types.js';

export function createDedupeStage(deps: { seen: SeenStore; stats: PipelineStats }): IngressStage {
  return async (ctx, next) => {
    const eventKey = ctx.message.eventId !== '' ? ctx.message.eventId : ctx.message.msgId;
    if (!deps.seen.claim(eventKey)) {
      deps.stats.deduplicated += 1;
      ctx.logger.debug('丢弃重复事件', { eventId: eventKey });
      return;
    }
    await next();
  };
}
