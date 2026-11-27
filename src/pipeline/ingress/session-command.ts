import type { PipelineStats, TraceContext } from '@qqbot/contracts';
import { logInputShortcut } from './types.js';
import type { IngressStage } from '@qqbot/contracts';
import type { MessagePart } from '@qqbot/contracts';
/** 整句匹配控制命令，兼容官方 @ 前缀；/reset 是 /new 的别名。 */
export function parseSessionCommand(
  content: string,
  parts?: readonly MessagePart[]
): 'stop' | 'new' | undefined {
  const topLevel = parts?.filter((part) => part.type !== 'quote');
  if (topLevel?.some((part) => part.type !== 'text')) return undefined;
  const text = (
    !parts?.length
      ? content
      : (topLevel ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('')
  )
    .trim()
    .replace(/^<@!\d+>\s*/, '')
    .toLowerCase();
  if (text === '/stop') return 'stop';
  if (text === '/new' || text === '/reset') return 'new';
  return undefined;
}
/** 控制命令在当前输入的身份范围内直接操作 Actor，不等待执行或发送。 */
type SessionActorControl = {
  stop(sessionKey: string, initiator?: TraceContext, senderId?: string): number;
  reset(sessionKey: string, initiator?: TraceContext): number;
};
/**
 * `/stop` 对所有成员开放，但普通成员只停止自己发起的 Task 与本会话主动 Task；
 * 管理员停止整个会话。`/new` 仍只允许管理员（会重置上下文）。
 * 普通成员的自然语言取消由输入身份绑定的 TaskControlBridge 检查权限。
 */
export class SessionCommandRouter {
  constructor(private readonly options: { actor: SessionActorControl; stats: PipelineStats }) {}
  stage(): IngressStage {
    return async (context, next) => {
      const command = parseSessionCommand(context.message.content, context.message.parts);
      if (!command) return next();
      if (command === 'new' && !context.isAdmin) {
        logInputShortcut(context, 'session-command', 'permission-denied');
        await context.responder.error('无权限：/new 仅限管理员（BOT_ADMINS 白名单）。');
        return;
      }
      this.options.stats.record('sessionCommands');
      logInputShortcut(context, 'session-command', `command-${command}`);
      const key = context.message.target.key;
      if (command === 'stop') {
        await this.stop(context, key);
        return;
      }
      this.options.actor.reset(key, context.trace);
      await context.responder.error('已取消全部未完成任务并重置上下文。');
    };
  }
  private async stop(context: Parameters<IngressStage>[0], key: string): Promise<void> {
    const count = context.isAdmin
      ? this.options.actor.stop(key, context.trace)
      : this.options.actor.stop(key, context.trace, context.message.senderId);
    let notice: string;
    if (context.isAdmin)
      notice = count ? '已停止当前执行的任务，其他排队任务保留。' : '当前没有正在执行的任务。';
    else
      notice = count
        ? '已停止你发起的任务和本会话的主动任务，其他排队任务保留。'
        : '当前没有你可停止的任务。';
    await context.responder.error(notice);
  }
}
