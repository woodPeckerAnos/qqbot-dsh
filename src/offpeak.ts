/**
 * 谷时段闸：DeepSeek 错峰优惠时段之外，在编排层直接拒答，不调用模型 API。
 *
 * 为什么放在桥接层而不是 dsh plugin：
 *   - 决策依据（模型身份、时间策略）全部在桥接层配置里；
 *   - 在这里拦截可以不写对话记录、不占并发名额、不碰 DSH 进程，
 *     也不会把伪造的 turn 混进会话历史污染后续回放；
 *   - 判定是纯函数，可以直接进离线单测。
 *
 * 配置分三层，优先级从高到低：
 *   运行期覆盖（管理员 /offpeak 命令，持久化到 stateDir）
 *     > env 默认值（QQ_OFFPEAK_*，启动时读）
 *     > 代码内置默认
 *
 * 管理员（QQ_ADMIN_OPENIDS 白名单）任何时段都不被拦截，且可以通过
 * QQ 消息热切换闸配置，下一条消息即生效。
 */

import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// 时间窗口
// ---------------------------------------------------------------------------

/** 一天中的分钟数窗口，支持跨零点（如 22:00–06:00）。区间为 [start, end)。 */
export interface OffpeakWindow {
  startMin: number;
  endMin: number;
}

export class OffpeakConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffpeakConfigError';
  }
}

const HH_MM = /^(\d{1,2}):(\d{2})$/;

/** 解析 "HH:MM" 为一天中的分钟数；非法输入抛 OffpeakConfigError。 */
export function parseTimeHHMM(text: string): number {
  const match = HH_MM.exec(text.trim());
  if (match === null) {
    throw new OffpeakConfigError(`时间格式必须是 HH:MM（如 00:30），收到 ${JSON.stringify(text)}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new OffpeakConfigError(`时间超出范围（小时 0-23，分钟 0-59）：${JSON.stringify(text)}`);
  }
  return hour * 60 + minute;
}

export function formatMinutes(totalMin: number): string {
  const hour = Math.floor(totalMin / 60);
  const minute = totalMin % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 校验时区名是否被当前 ICU 认识（配置错误要在启动期爆出来）。 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** 某时刻在指定时区里是一天中的第几分钟。 */
export function minutesInTimeZone(ts: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'hour') hour = Number(part.value) % 24;
    if (part.type === 'minute') minute = Number(part.value);
  }
  return hour * 60 + minute;
}

/** 窗口判定：[start, end)，支持跨零点窗口。 */
export function isInOffpeakWindow(minute: number, window: OffpeakWindow): boolean {
  if (window.startMin === window.endMin) return false; // 空窗口 = 永不命中（配置层已禁止，这里防御）
  if (window.startMin < window.endMin) {
    return minute >= window.startMin && minute < window.endMin;
  }
  return minute >= window.startMin || minute < window.endMin;
}

// ---------------------------------------------------------------------------
// 闸判定
// ---------------------------------------------------------------------------

export interface OffpeakGateConfig {
  enabled: boolean;
  window: OffpeakWindow;
  timeZone: string;
  /** 命中判定：`<provider>/<model>` 包含该子串（大小写不敏感）时视为 DeepSeek 计费模型 */
  modelPattern: string;
}

export type GateReason = 'admin' | 'disabled' | 'model-mismatch' | 'in-window' | 'peak-hours';

export interface GateDecision {
  gated: boolean;
  reason: GateReason;
}

export function evaluateGate(args: {
  config: OffpeakGateConfig;
  provider: string;
  model: string;
  isAdmin: boolean;
  now: number;
}): GateDecision {
  const { config } = args;
  if (args.isAdmin) return { gated: false, reason: 'admin' };
  if (!config.enabled) return { gated: false, reason: 'disabled' };
  const target = `${args.provider}/${args.model}`.toLowerCase();
  if (!target.includes(config.modelPattern.toLowerCase())) {
    return { gated: false, reason: 'model-mismatch' };
  }
  const minute = minutesInTimeZone(args.now, config.timeZone);
  if (isInOffpeakWindow(minute, config.window)) return { gated: false, reason: 'in-window' };
  return { gated: true, reason: 'peak-hours' };
}

// ---------------------------------------------------------------------------
// 运行期覆盖（热切换）+ 持久化
// ---------------------------------------------------------------------------

export interface OffpeakOverride {
  enabled?: boolean;
  window?: OffpeakWindow;
  updatedBy: string;
  updatedAt: number;
}

/** /metrics 里暴露的闸状态快照。 */
export interface OffpeakSnapshot {
  enabled: boolean;
  window: string;
  timeZone: string;
  modelPattern: string;
  overridden: boolean;
  updatedBy?: string;
  updatedAt?: number;
}

/** 覆盖文件的磁盘格式（窗口存可读的 HH:MM，便于人工排查）。 */
interface OverrideFile {
  enabled?: boolean;
  window?: { start: string; end: string };
  updatedBy?: string;
  updatedAt?: number;
}

export class OffpeakGate {
  private override: OffpeakOverride | undefined;

  constructor(
    private readonly options: {
      defaults: OffpeakGateConfig;
      filePath: string;
      logger: Logger;
      now?: () => number;
    },
  ) {
    this.override = this.load();
  }

  /** 当前生效配置 = env 默认 + 运行期覆盖。每次调用现算，改完下条消息即生效。 */
  effective(): OffpeakGateConfig {
    const base = this.options.defaults;
    const override = this.override;
    if (override === undefined) return base;
    return {
      enabled: override.enabled ?? base.enabled,
      window: override.window ?? base.window,
      timeZone: base.timeZone,
      modelPattern: base.modelPattern,
    };
  }

  snapshot(): OffpeakSnapshot {
    const effective = this.effective();
    const override = this.override;
    return {
      enabled: effective.enabled,
      window: `${formatMinutes(effective.window.startMin)}–${formatMinutes(effective.window.endMin)}`,
      timeZone: effective.timeZone,
      modelPattern: effective.modelPattern,
      overridden: override !== undefined,
      ...(override !== undefined ? { updatedBy: override.updatedBy, updatedAt: override.updatedAt } : {}),
    };
  }

  setEnabled(enabled: boolean, actor: string): OffpeakGateConfig {
    this.override = { ...this.override, enabled, updatedBy: actor, updatedAt: this.now() };
    this.persist();
    return this.effective();
  }

  /** startText/endText 非法时抛 OffpeakConfigError，由调用方转成用户可见的回复。 */
  setWindow(startText: string, endText: string, actor: string): OffpeakGateConfig {
    const window: OffpeakWindow = {
      startMin: parseTimeHHMM(startText),
      endMin: parseTimeHHMM(endText),
    };
    if (window.startMin === window.endMin) {
      throw new OffpeakConfigError('窗口起止时间不能相同（那会是一个空窗口）');
    }
    this.override = { ...this.override, window, updatedBy: actor, updatedAt: this.now() };
    this.persist();
    return this.effective();
  }

  clearOverride(actor: string): void {
    this.override = undefined;
    this.persist();
    this.options.logger.info('谷时段闸覆盖已清除，恢复 env 默认', { actor });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** 加载持久化的覆盖。文件损坏不是致命错误：告警后回落到 env 默认。 */
  private load(): OffpeakOverride | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.options.filePath, 'utf8');
    } catch {
      return undefined; // 文件不存在是常态（首次启动）
    }
    try {
      const parsed = JSON.parse(raw) as OverrideFile;
      const override: OffpeakOverride = {
        updatedBy: parsed.updatedBy ?? 'unknown',
        updatedAt: parsed.updatedAt ?? 0,
      };
      if (typeof parsed.enabled === 'boolean') override.enabled = parsed.enabled;
      if (parsed.window !== undefined) {
        override.window = {
          startMin: parseTimeHHMM(parsed.window.start),
          endMin: parseTimeHHMM(parsed.window.end),
        };
      }
      this.options.logger.info('已加载谷时段闸的运行期覆盖', {
        file: this.options.filePath,
        ...override,
      });
      return override;
    } catch (error) {
      this.options.logger.warn('谷时段闸覆盖文件损坏，忽略并回落到 env 默认', {
        file: this.options.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** 原子写覆盖文件：先写临时文件再 rename，避免进程崩溃留下半个 JSON。 */
  private persist(): void {
    const override = this.override;
    const file: OverrideFile =
      override === undefined
        ? {}
        : {
            updatedBy: override.updatedBy,
            updatedAt: override.updatedAt,
            ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
            ...(override.window !== undefined
              ? {
                  window: {
                    start: formatMinutes(override.window.startMin),
                    end: formatMinutes(override.window.endMin),
                  },
                }
              : {}),
          };
    try {
      mkdirSync(dirname(this.options.filePath), { recursive: true });
      const tmp = `${this.options.filePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.options.filePath);
    } catch (error) {
      // 持久化失败不阻断本次切换（内存里已生效），但必须告警：重启后会丢。
      this.options.logger.warn('谷时段闸覆盖持久化失败，重启后将回落到 env 默认', {
        file: this.options.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 管理员命令（/offpeak ...）
// ---------------------------------------------------------------------------

export type OffpeakCommand =
  | { action: 'status' }
  | { action: 'whoami' }
  | { action: 'set-enabled'; enabled: boolean }
  | { action: 'set-window'; start: string; end: string }
  | { action: 'reset' }
  | { action: 'invalid'; detail: string };

export const OFFPEAK_COMMAND_USAGE =
  '用法：/offpeak status | whoami | on | off | window 00:30-08:30 | reset（on/off/window/reset 仅管理员可用）';

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
    case 'window': {
      const joined = rest.join(' ');
      const range = /^(\S+?)\s*[-~–—]\s*(\S+)$/.exec(joined);
      const [, start, end] = range ?? [];
      if (start === undefined || end === undefined) {
        return { action: 'invalid', detail: `window 需要形如 "00:30-08:30" 的参数，收到 ${JSON.stringify(joined)}` };
      }
      return { action: 'set-window', start, end };
    }
    default:
      return { action: 'invalid', detail: `未知子命令 ${JSON.stringify(sub)}` };
  }
}

/** 需要管理员权限的子命令。status / whoami 对所有人开放（不消耗 API）。 */
export function commandNeedsAdmin(command: OffpeakCommand): boolean {
  return command.action === 'set-enabled' || command.action === 'set-window' || command.action === 'reset';
}

/** 拦截时给用户的提示文案（窗口从生效配置渲染，不写死）。 */
export function renderGateNotice(config: OffpeakGateConfig): string {
  const window = `${formatMinutes(config.window.startMin)}–${formatMinutes(config.window.endMin)}`;
  return (
    `当前为 DeepSeek 正价时段，为控制消耗暂不处理请求。` +
    `谷时段为 ${window}（${config.timeZone}），请在谷时段再发一次。`
  );
}
