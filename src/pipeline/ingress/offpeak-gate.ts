/**
 * Ingress stage ③：谷时段闸（DeepSeek 错峰优惠时段之外直接拒答，不调 API）。
 *
 * 位置理由：必须先于「记录」与「准入」——被拦截的消息不写对话记录、
 * 不占并发名额、不碰 DSH 进程，就像它没来过；同时必须在命令路由之后，
 * 否则管理员在峰时段无法发 /offpeak off 关闸。
 *
 * 与 dispatcher 解耦的关键：判定配置来自 OffpeakGate 服务（env 默认 +
 * 运行期覆盖，下一条消息即生效），本 stage 只做"拦截并回复"这一件事。
 */

import type { Config } from '../../config.js';
import { evaluateGate, renderGateNotice, type OffpeakGate } from '../../offpeak/index.js';
import type { PipelineStats } from '../stats.js';
import type { IngressStage } from './types.js';

export function createOffpeakGateStage(deps: {
  gate: OffpeakGate;
  config: Config;
  stats: PipelineStats;
  now?: () => number;
}): IngressStage {
  const now = (): number => deps.now?.() ?? Date.now();
  return async (ctx, next) => {
    const decision = evaluateGate({
      config: deps.gate.effective(),
      provider: deps.config.dsh.provider,
      model: deps.config.dsh.model,
      isAdmin: ctx.isAdmin,
      now: now(),
    });
    if (decision.gated) {
      deps.stats.gatedOffpeak += 1;
      ctx.logger.info('谷时段闸拦截：当前为正价时段，未调用 API', {
        senderId: ctx.message.senderId,
        offpeak: deps.gate.snapshot(),
      });
      await ctx.responder.error(renderGateNotice(deps.gate.effective())).catch(() => {});
      return;
    }
    if (decision.reason === 'admin') {
      ctx.logger.debug('管理员消息，谷时段闸放行', { senderId: ctx.message.senderId });
    }
    await next();
  };
}
