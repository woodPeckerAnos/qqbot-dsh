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
      /** try 路径（介入 turn）没有 MessageContext，错误只能落这里 */
      logger?: { error(msg: string, meta?: Record<string, unknown>): void };
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

  /** 全局并发是否还有名额（介入层 speak 链 32 号规则的探测位） */
  get hasFreeSlot(): boolean {
    return this.semaphore.inUse < this.deps.maxConcurrentTurns;
  }

  /**
   * 介入专用的 try 语义（方案 §9.5）：全局并发满或该会话锁被占 → 立即
   * 返回 false，绝不排队（排到时话题早已翻篇）。成功拿到则在
   * 「名额 + 会话锁」内执行 fn 并返回 true。错误处理与 stage() 一致
   * （兜底记日志、不外抛），但介入路径没有 Responder 回执语义——
   * 静默失败即可。
   */
  async tryRunExclusive(key: string, fn: () => Promise<void>): Promise<boolean> {
    const release = this.semaphore.tryAcquire();
    if (release === undefined) return false;
    try {
      return await this.conversationLock.tryRun(key, async () => {
        try {
          await fn();
        } catch (error) {
          this.deps.stats.failed += 1;
          // 与 stage() 的兜底一致：介入 turn 的未预期错误只记日志
          // （没有用户在场，不需要错误回复）
          this.deps.logger?.error('介入 turn 发生未预期错误', {
            conversation: key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    } finally {
      release();
    }
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
