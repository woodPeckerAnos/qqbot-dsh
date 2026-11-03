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
export type PersonaCommand =
  | {
      kind: 'list';
    }
  | {
      kind: 'set';
      name: string;
    }
  | {
      kind: 'clear';
    };
/** 解析 /persona 命令；不是 /persona 形态时返回 undefined（放行给后续 stage）。 */
export type parsePersonaCommand = (content: string) => PersonaCommand | undefined;
export interface PersonaCommandRouter {
  stage(): IngressStage;
}
export type createPersonaCommandRouterFactory = (deps: {
  personas: PersonaStore;
  stats: PipelineStats;
}) => PersonaCommandRouter;
