/**
 * /offpeak 管理员命令：解析与文案。
 *
 * 这里只负责把消息文本解析成结构化的 OffpeakCommand 以及渲染用户可见的
 * 提示文案；命令的执行（权限检查、调用 OffpeakGate、回执）在 ingress 的
 * offpeak-command stage 里。
 */

import type { OffpeakGateConfig } from './gate.js';
import { formatWindows } from './windows.js';

export type OffpeakCommand =
  | { action: 'status' }
  | { action: 'whoami' }
  | { action: 'set-enabled'; enabled: boolean }
  | { action: 'set-windows'; spec: string }
  | { action: 'holiday-add'; date: string }
  | { action: 'holiday-del'; date: string }
  | { action: 'holiday-list' }
  | { action: 'reset' }
  | { action: 'invalid'; detail: string };

export const OFFPEAK_COMMAND_USAGE =
  '用法：/offpeak status | whoami | on | off | window 00:00-09:00,12:00-14:00,18:00-24:00 | holiday list | holiday add 2027-01-01 | holiday del 2027-01-01 | reset（仅管理员可变更）';

/**
 * 解析 /offpeak 命令。返回 undefined 表示这不是命令（按普通消息处理）。
 *
 * 群聊 @机器人 时 content 可能带 `<@!...>` mention 前缀，先剥掉再匹配。
 */
export function parseOffpeakCommand(content: string): OffpeakCommand | undefined {
  let text = content.trim();
  const mention = /^<@!\d+>/.exec(text);
  if (mention !== null) text = text.slice(mention[0].length).trim();

  const match = /^\/offpeak(?:\s+(.*))?$/is.exec(text);
  if (match === null) return undefined;

  const args = (match[1] ?? '').trim();
  if (args === '' || args === 'status') return { action: 'status' };

  const [sub = '', ...rest] = args.split(/\s+/);
  switch (sub.toLowerCase()) {
    case 'whoami':
      return { action: 'whoami' };
    case 'on':
      return { action: 'set-enabled', enabled: true };
    case 'off':
      return { action: 'set-enabled', enabled: false };
    case 'reset':
      return { action: 'reset' };
    case 'holiday': {
      const [op, date] = rest;
      if (op === undefined || op.toLowerCase() === 'list') return { action: 'holiday-list' };
      if ((op.toLowerCase() === 'add' || op.toLowerCase() === 'del') && date !== undefined) {
        return { action: op.toLowerCase() === 'add' ? 'holiday-add' : 'holiday-del', date };
      }
      return {
        action: 'invalid',
        detail: 'holiday 需要形如 "holiday add 2027-01-01" / "holiday del 2027-01-01" / "holiday list" 的参数',
      };
    }
    case 'window': {
      // 多窗口：逗号或空白分隔（如 `00:00-09:00,12:00-14:00,18:00-24:00`）。
      // 这里只把原始串透传，真正的解析与校验在 windows.ts 的 parseWindowsSpec
      // 里做，失败由调用方转成"设置失败：<原因>"的用户可见回复。
      const spec = rest.join(' ').trim();
      if (spec === '') {
        return {
          action: 'invalid',
          detail: 'window 需要形如 "00:00-09:00,12:00-14:00,18:00-24:00" 的参数（多个窗口用逗号分隔）',
        };
      }
      return { action: 'set-windows', spec };
    }
    default:
      return { action: 'invalid', detail: `未知子命令 ${JSON.stringify(sub)}` };
  }
}

/** 需要管理员权限的子命令。status / whoami 对所有人开放（不消耗 API）。 */
export function commandNeedsAdmin(command: OffpeakCommand): boolean {
  return (
    command.action === 'set-enabled' ||
    command.action === 'set-windows' ||
    command.action === 'holiday-add' ||
    command.action === 'holiday-del' ||
    command.action === 'reset'
  );
}

/** 拦截时给用户的提示文案（窗口从生效配置渲染，不写死）。 */
export function renderGateNotice(config: OffpeakGateConfig): string {
  const windows = formatWindows(config.windows);
  const extra = config.weekendsAllDay ? '；周六、周日与法定节假日全天为谷时段' : '';
  return (
    `当前为 DeepSeek 正价时段，为控制消耗暂不处理请求。` +
    `工作日谷时段为 ${windows}（${config.timeZone}）${extra}。`
  );
}
