/**
 * Ingress stage ⑤：准入（唯一的包裹型 stage）。
 *
 * 两个并发机制在此收口，下游（TurnRunner）在两者之内执行：
 *   - 全局并发闸门（Semaphore）：有界，满了就礼貌拒绝而不是无限排队——
 *     排队没有意义，被动回复窗口有限，排到时消息早已发不出去；
 *   - 每会话串行（KeyedMutex）：同一群/同一人同时只跑一条，
 *     避免事件流交错（这是全系统唯一一处每会话串行，main.ts 不再有
 *     自己的串行链）。
 *
 * 兜底语义：下游抛出任何未预期错误，在这里转成 failed 计数 + 一条
 * 错误回复，promise 不向外抛（Orchestrator 的"永不抛错"契约由此兑现）。
 */

import { KeyedMutex, Semaphore } from '../concurrency.js';
import type { PipelineStats } from '../stats.js';
import type { IngressStage } from './types.js';

export class AdmissionGate {
  private readonly semaphore: Semaphore;
  private readonly conversationLock = new KeyedMutex();

  constructor(
    private readonly deps: {
      maxConcurrentTurns: number;
      stats: PipelineStats;
    },
  ) {
    this.semaphore = new Semaphore(deps.maxConcurrentTurns);
  }

  /** 在途 turn 数（health 快照与优雅退出 drain 用） */
  get inUse(): number {
    return this.semaphore.inUse;
  }

  /** 排队数（当前策略是满员直接拒绝，正常恒为 0；留作防御性观测） */
  get queued(): number {
    return this.semaphore.queued;
  }

  stage(): IngressStage {
    return async (ctx, next) => {
      const { stats } = this.deps;

      if (this.semaphore.inUse >= this.deps.maxConcurrentTurns) {
        stats.rejectedBusy += 1;
        ctx.logger.warn('并发已满，礼貌拒绝本次提问', {
          inUse: this.semaphore.inUse,
          max: this.deps.maxConcurrentTurns,
        });
        await ctx.responder
          .error('我现在同时在处理的请求太多，暂时忙不过来。请稍后再发一次。')
          .catch(() => {});
        return;
      }

      const release = await this.semaphore.acquire();
      try {
        await this.conversationLock.run(ctx.message.target.key, next);
      } catch (error) {
        stats.failed += 1;
        ctx.logger.error('处理提问时发生未预期错误', {
          error: error instanceof Error ? error.message : String(error),
        });
        await ctx.responder
          .error('处理你的请求时出错了，我已经记录到日志。')
          .catch(() => {});
      } finally {
        release();
      }
    };
  }
}
