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
      const key = ctx.message.target.key;

      // 顺序约束：先等**会话锁**，再占**全局并发名额**。旧顺序相反，效果是
      // 排队等同会话锁的消息白占一个全局名额——一个跑长任务的群可以把全局
      // 名额耗光，让别的群的新消息被误拒。
      if (this.conversationLock.isBusy(key)) {
        // 忙时提示：让用户知道消息没丢（在完成前不会回复别的），并给出 /stop 出口。
        // 只占一条回复配额；发不出去（窗口/配额）不阻塞排队。
        stats.busyNoticed += 1;
        await ctx.responder
          .error('上一条消息还在处理中，你这条会在它完成后自动处理，不用重发。等不及的话管理员可以发 /stop 强制中断。')
          .catch(() => {});
      }
      const releaseLock = await this.conversationLock.acquire(key);
      try {
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
          await next();
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
      } finally {
        releaseLock();
      }
    };
  }
}
