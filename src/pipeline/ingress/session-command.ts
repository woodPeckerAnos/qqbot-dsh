/**
 * Ingress stage：会话控制命令（/stop、/new）。
 *
 * 位置理由：去重之后、谷时段闸之前（与 /offpeak 命令同级）——
 * 控制命令必须永远可用：峰时段被闸拦住时管理员也要能 /stop 一个失控任务；
 * 命令不写对话记录、不占并发名额、不进会话锁（/stop 的意义恰恰是在锁被
 * 长任务占住时也能立刻生效）。
 *
 * 权限：两个命令都只限管理员（BOT_ADMINS）。它们都会回收 runtime 进程——
 * /stop 终止在途 turn 与其承载的后台子代理，/new 丢弃整个会话上下文——
 * 对普通群成员开放等于把"打断别人任务"的权力交给任何人。
 *
 * 命令群聊形态：`/stop`、`/new`（整句匹配，前后空白忽略；带参数一律不识别）。
 */

import type { RuntimePool } from '../../dsh/pool.js';
import type { PipelineStats } from '../stats.js';
import type { TurnRunner } from '../turn-runner.js';
import type { IngressStage } from './types.js';

type SessionCommand = 'stop' | 'new';

/** 整句匹配 /stop、/new（兼容官方平台的 `<@!id> /stop` 形态）；别名 /reset 视作 /new。 */
export function parseSessionCommand(content: string): SessionCommand | undefined {
  let text = content.trim();
  const mention = /^<@!\d+>/.exec(text);
  if (mention !== null) text = text.slice(mention[0].length).trim();
  text = text.toLowerCase();
  if (text === '/stop') return 'stop';
  if (text === '/new' || text === '/reset') return 'new';
  return undefined;
}

export class SessionCommandRouter {
  constructor(
    private readonly deps: {
      pool: RuntimePool;
      turns: TurnRunner;
      stats: PipelineStats;
    },
  ) {}

  stage(): IngressStage {
    return async (ctx, next) => {
      const command = parseSessionCommand(ctx.message.content);
      if (command === undefined) {
        await next();
        return;
      }
      if (!ctx.isAdmin) {
        ctx.logger.warn('非管理员尝试会话控制命令，已拒绝', {
          senderId: ctx.message.senderId,
          platform: ctx.message.target.platform,
          command,
        });
        await ctx.responder
          .error('无权限：/stop 和 /new 仅限管理员（BOT_ADMINS 白名单）。')
          .catch(() => {});
        return;
      }

      this.deps.stats.sessionCommands += 1;
      const key = ctx.message.target.key;

      if (command === 'stop') {
        const aborted = this.deps.turns.abortConversation(key);
        await ctx.responder
          .error(
            aborted
              ? '已强制中断当前任务（进行中的后台子代理也一并终止）。'
              : '当前没有进行中的任务。',
          )
          .catch(() => {});
        return;
      }

      // /new：标记下一条消息开启新话题（跳过冷启动回放），并回收 runtime
      // 丢弃内存中的旧上下文。若此刻有在途 turn，一并按"中断"收尾——否则被
      // 杀掉进程的 runTurn 会一直挂到超时。对话记录保留（排障用），只是不再
      // 注入 prompt。
      this.deps.turns.markFreshStart(key);
      this.deps.turns.abortConversation(key);
      await ctx.responder
        .error('已重置本会话上下文：下一条消息将开启全新会话，不再携带之前的话题。')
        .catch(() => {});
    };
  }
}
