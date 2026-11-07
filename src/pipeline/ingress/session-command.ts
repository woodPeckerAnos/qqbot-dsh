import type { SessionActorV2 as SessionActor } from '@qqbot/contracts';
import type { PipelineStats } from '@qqbot/contracts';
import { logInputShortcut } from './types.js';
import type { IngressStage } from '@qqbot/contracts';
/** 整句匹配控制命令，兼容官方 @ 前缀；/reset 是 /new 的别名。 */
export function parseSessionCommand(content: string): 'stop' | 'new' | undefined {
  const text = content
    .trim()
    .replace(/^<@!\d+>\s*/, '')
    .toLowerCase();
  if (text === '/stop') return 'stop';
  if (text === '/new' || text === '/reset') return 'new';
  return undefined;
}
/**
 * 管理员控制命令在时间闸之前直接操作 Actor，不等待执行或发送。
 * 普通成员的自然语言取消由输入身份绑定的 TaskControlBridge 检查权限。
 */
export class SessionCommandRouter {
  constructor(
    private readonly options: { actor: Pick<SessionActor, 'stop' | 'reset'>; stats: PipelineStats }
  ) {}
  stage(): IngressStage {
    return async (context, next) => {
      const command = parseSessionCommand(context.message.content);
      if (!command) return next();
      if (!context.isAdmin) {
        logInputShortcut(context, 'session-command', 'permission-denied');
        await context.responder.error('无权限：/stop 和 /new 仅限管理员（BOT_ADMINS 白名单）。');
        return;
      }
      this.options.stats.record('sessionCommands');
      logInputShortcut(context, 'session-command', `command-${command}`);
      const key = context.message.target.key;
      if (command === 'stop') {
        const count = this.options.actor.stop(key, context.trace);
        await context.responder.error(
          count ? '已停止当前执行的任务，其他排队任务保留。' : '当前没有正在执行的任务。'
        );
      } else {
        this.options.actor.reset(key, context.trace);
        await context.responder.error('已取消全部未完成任务并重置上下文。');
      }
    };
  }
}
