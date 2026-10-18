/**
 * Ingress stage：预设风格前台命令（/persona）。
 *
 * 位置与 /stop、/new 同级（去重之后、谷时段闸之前）：风格切换是控制面操作，
 * 不写对话记录、不占并发名额、不进会话锁，峰时段也必须可用。
 *
 * 命令形态（整句匹配，兼容官方平台的 `<@!id> /persona` 形态）：
 *   /persona            列出可用预设与当前选择
 *   /persona <名>       切换本会话的人设（下一个 turn 生效，无需重启）
 *   /persona off        恢复全局默认人设
 *
 * 权限：仅管理员（BOT_ADMINS）。切换人设改变的是**整个会话**的答复风格，
 * 对普通群成员开放等于任何人都能改写这个群的 bot 行为。
 */

import type { PersonaStore } from '../../store/personas.js';
import type { PipelineStats } from '../stats.js';
import type { IngressStage } from './types.js';

export type PersonaCommand = { kind: 'list' } | { kind: 'set'; name: string } | { kind: 'clear' };

/** 解析 /persona 命令；不是 /persona 形态时返回 undefined（放行给后续 stage）。 */
export function parsePersonaCommand(content: string): PersonaCommand | undefined {
  let text = content.trim();
  const mention = /^<@!\d+>/.exec(text);
  if (mention !== null) text = text.slice(mention[0].length).trim();
  if (!text.toLowerCase().startsWith('/persona')) return undefined;
  const rest = text.slice('/persona'.length).trim();
  if (rest === '') return { kind: 'list' };
  // 多词参数不是合法预设名：回 usage 而不是静默按第一个词处理
  if (/\s/.test(rest)) return { kind: 'list' };
  const name = rest.toLowerCase();
  if (name === 'off' || name === 'default') return { kind: 'clear' };
  return { kind: 'set', name };
}

export class PersonaCommandRouter {
  constructor(
    private readonly deps: {
      personas: PersonaStore;
      stats: PipelineStats;
    },
  ) {}

  stage(): IngressStage {
    return async (ctx, next) => {
      const command = parsePersonaCommand(ctx.message.content);
      if (command === undefined) {
        await next();
        return;
      }
      if (!ctx.isAdmin) {
        ctx.logger.warn('非管理员尝试人设切换命令，已拒绝', {
          senderId: ctx.message.senderId,
          platform: ctx.message.target.platform,
        });
        await ctx.responder
          .error('无权限：/persona 仅限管理员（BOT_ADMINS 白名单）。')
          .catch(() => {});
        return;
      }

      this.deps.stats.sessionCommands += 1;
      const key = ctx.message.target.key;
      const { personas } = this.deps;

      if (command.kind === 'list') {
        const presets = personas.listPresets();
        const current = personas.current(key);
        const lines = [
          `当前会话风格：${current ?? '默认（全局人设）'}`,
          presets.length > 0
            ? `可用预设：${presets.join('、')}`
            : '预设目录里没有可用预设（dsh-profile/personas/*.md）',
          '切换：/persona <预设名>；恢复默认：/persona off。新风格从下一条消息生效，无需重启。',
        ];
        await ctx.responder.error(lines.join('\n')).catch(() => {});
        return;
      }

      if (command.kind === 'clear') {
        const { hadSelection } = personas.clear(key);
        await ctx.responder
          .error(hadSelection ? '已恢复默认人设，下一条消息生效。' : '本会话本来就是默认人设。')
          .catch(() => {});
        return;
      }

      const result = personas.apply(key, command.name);
      if (result.ok) {
        await ctx.responder
          .error(`已切换到人设「${result.name}」，下一条消息生效。`)
          .catch(() => {});
        return;
      }
      const presets = personas.listPresets();
      await ctx.responder
        .error(
          `切换失败：${result.detail}` +
            (presets.length > 0 ? `\n可用预设：${presets.join('、')}` : ''),
        )
        .catch(() => {});
    };
  }
}
