/**
 * 谷时段闸：DeepSeek 错峰优惠时段之外，在编排层直接拒答，不调用模型 API。
 *
 * DeepSeek 官方计费规则（2026-09-19《API 峰谷时间说明》）：
 *   - 工作日：仅谷时段窗口（默认 00:30–08:30）按谷价；
 *   - 周六、周日：全天谷价（2026-08-23 起，含调休上班的周末——它们仍是周六/日）；
 *   - 中国法定节假日（放假调休期间）：全天谷价——需要日历表，
 *     内置国务院办公厅《关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7 号），
 *     跨年数据由 env（QQ_OFFPEAK_HOLIDAYS）或管理员 /offpeak holiday 命令追加。
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

/**
 * 官方节假日历（2026 年，含调休休息日）。
 * 来源：国务院办公厅《关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7 号，
 * 2025-11-04 发布）。按 DeepSeek 规则，放假调休期间全天按空闲时段计费。
 * 周末日期列在其中无害（周末本就全天谷价），列全是为了与官方通知逐条对应、便于核对。
 */
export const CN_HOLIDAYS_2026: readonly string[] = [
  // 元旦：1月1日（周四）至3日（周六）
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节：2月15日至23日（2月14日周六、2月28日周六上班）
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节：4月4日至6日
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节：5月1日至5日（5月9日周六上班）
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节：6月19日至21日
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节：9月25日至27日
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节：10月1日至7日（9月20日周日、10月10日周六上班）
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 校验 YYYY-MM-DD 是真实存在的日期（拒绝 2026-02-30 之类）。 */
export function isValidDateString(text: string): boolean {
  const match = DATE_RE.exec(text.trim());
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function datePartsInTimeZone(ts: number, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ts));
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    if (part.type === 'month') month = Number(part.value);
    if (part.type === 'day') day = Number(part.value);
  }
  return { year, month, day };
}

/** 某时刻在指定时区里的日历日期（YYYY-MM-DD）。 */
export function dateStringInTimeZone(ts: number, timeZone: string): string {
  const { year, month, day } = datePartsInTimeZone(ts, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 某时刻在指定时区里是否为周六/周日。 */
export function isWeekendInTimeZone(ts: number, timeZone: string): boolean {
  const { year, month, day } = datePartsInTimeZone(ts, timeZone);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
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
  /** 周六、周日全天谷价（DeepSeek 2026-08-23 起规则，自动覆盖调休上班的周末） */
  weekendsAllDay: boolean;
  /** 全天谷价的日期表（YYYY-MM-DD）：内置官方节假日 + env/管理员追加 */
  holidays: ReadonlySet<string>;
}

export type GateReason =
  | 'admin'
  | 'disabled'
  | 'model-mismatch'
  | 'weekend'
  | 'holiday'
  | 'in-window'
  | 'peak-hours';

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
  // 节假日与周末全天谷价，先于时间窗口判定（官方规则见文件头注释）
  const date = dateStringInTimeZone(args.now, config.timeZone);
  if (config.holidays.has(date)) return { gated: false, reason: 'holiday' };
  if (config.weekendsAllDay && isWeekendInTimeZone(args.now, config.timeZone)) {
    return { gated: false, reason: 'weekend' };
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
  /** 在默认节假日表上追加的日期（YYYY-MM-DD） */
  holidaysAdd?: string[];
  /** 从默认节假日表里移除的日期（YYYY-MM-DD） */
  holidaysDel?: string[];
  updatedBy: string;
  updatedAt: number;
}

/** /metrics 里暴露的闸状态快照。 */
export interface OffpeakSnapshot {
  enabled: boolean;
  window: string;
  timeZone: string;
  modelPattern: string;
  weekendsAllDay: boolean;
  /** 生效的节假日表覆盖到哪天（取最大日期，便于发现"数据过期"） */
  holidaysCount: number;
  holidaysCoverageUntil?: string;
  overridden: boolean;
  updatedBy?: string;
  updatedAt?: number;
}

/** 覆盖文件的磁盘格式（窗口存可读的 HH:MM，便于人工排查）。 */
interface OverrideFile {
  enabled?: boolean;
  window?: { start: string; end: string };
  holidaysAdd?: string[];
  holidaysDel?: string[];
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
    let holidays = base.holidays;
    if ((override.holidaysAdd?.length ?? 0) > 0 || (override.holidaysDel?.length ?? 0) > 0) {
      const merged = new Set(base.holidays);
      for (const date of override.holidaysAdd ?? []) merged.add(date);
      for (const date of override.holidaysDel ?? []) merged.delete(date);
      holidays = merged;
    }
    return {
      enabled: override.enabled ?? base.enabled,
      window: override.window ?? base.window,
      timeZone: base.timeZone,
      modelPattern: base.modelPattern,
      weekendsAllDay: base.weekendsAllDay,
      holidays,
    };
  }

  snapshot(): OffpeakSnapshot {
    const effective = this.effective();
    const override = this.override;
    const sorted = [...effective.holidays].sort();
    return {
      enabled: effective.enabled,
      window: `${formatMinutes(effective.window.startMin)}–${formatMinutes(effective.window.endMin)}`,
      timeZone: effective.timeZone,
      modelPattern: effective.modelPattern,
      weekendsAllDay: effective.weekendsAllDay,
      holidaysCount: sorted.length,
      ...(sorted.length > 0 ? { holidaysCoverageUntil: sorted[sorted.length - 1] } : {}),
      overridden: override !== undefined,
      ...(override !== undefined ? { updatedBy: override.updatedBy, updatedAt: override.updatedAt } : {}),
    };
  }

  /** 追加一个全天谷价日期。日期非法抛 OffpeakConfigError。 */
  addHoliday(date: string, actor: string): OffpeakGateConfig {
    const normalized = date.trim();
    if (!isValidDateString(normalized)) {
      throw new OffpeakConfigError(`日期必须是真实存在的 YYYY-MM-DD，收到 ${JSON.stringify(date)}`);
    }
    const add = (this.override?.holidaysAdd ?? []).filter((item) => item !== normalized);
    const del = (this.override?.holidaysDel ?? []).filter((item) => item !== normalized);
    add.push(normalized);
    this.override = {
      ...this.override,
      holidaysAdd: [...add].sort(),
      holidaysDel: [...del].sort(),
      updatedBy: actor,
      updatedAt: this.now(),
    };
    this.persist();
    return this.effective();
  }

  /** 移除一个全天谷价日期（从默认表与追加表中同时剔除）。 */
  delHoliday(date: string, actor: string): OffpeakGateConfig {
    const normalized = date.trim();
    if (!isValidDateString(normalized)) {
      throw new OffpeakConfigError(`日期必须是真实存在的 YYYY-MM-DD，收到 ${JSON.stringify(date)}`);
    }
    const add = (this.override?.holidaysAdd ?? []).filter((item) => item !== normalized);
    const del = (this.override?.holidaysDel ?? []).filter((item) => item !== normalized);
    del.push(normalized);
    this.override = {
      ...this.override,
      holidaysAdd: [...add].sort(),
      holidaysDel: [...del].sort(),
      updatedBy: actor,
      updatedAt: this.now(),
    };
    this.persist();
    return this.effective();
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
      if (Array.isArray(parsed.holidaysAdd)) {
        override.holidaysAdd = parsed.holidaysAdd.filter(
          (item): item is string => typeof item === 'string' && isValidDateString(item),
        );
      }
      if (Array.isArray(parsed.holidaysDel)) {
        override.holidaysDel = parsed.holidaysDel.filter(
          (item): item is string => typeof item === 'string' && isValidDateString(item),
        );
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
            ...((override.holidaysAdd?.length ?? 0) > 0 ? { holidaysAdd: override.holidaysAdd } : {}),
            ...((override.holidaysDel?.length ?? 0) > 0 ? { holidaysDel: override.holidaysDel } : {}),
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
  | { action: 'holiday-add'; date: string }
  | { action: 'holiday-del'; date: string }
  | { action: 'holiday-list' }
  | { action: 'reset' }
  | { action: 'invalid'; detail: string };

export const OFFPEAK_COMMAND_USAGE =
  '用法：/offpeak status | whoami | on | off | window 00:30-08:30 | holiday list | holiday add 2027-01-01 | holiday del 2027-01-01 | reset（仅管理员可变更）';

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
  return (
    command.action === 'set-enabled' ||
    command.action === 'set-window' ||
    command.action === 'holiday-add' ||
    command.action === 'holiday-del' ||
    command.action === 'reset'
  );
}

/** 拦截时给用户的提示文案（窗口从生效配置渲染，不写死）。 */
export function renderGateNotice(config: OffpeakGateConfig): string {
  const window = `${formatMinutes(config.window.startMin)}–${formatMinutes(config.window.endMin)}`;
  const extra = config.weekendsAllDay ? '；周六、周日与法定节假日全天为谷时段' : '';
  return (
    `当前为 DeepSeek 正价时段，为控制消耗暂不处理请求。` +
    `工作日谷时段为 ${window}（${config.timeZone}）${extra}，请稍后再发一次。`
  );
}
