/**
 * 谷时段闸：DeepSeek 错峰优惠时段之外，在编排层直接拒答，不调用模型 API。
 *
 * DeepSeek 官方计费规则（2026-09-19《API 峰谷时间说明》）：
 *   - 工作日：仅谷时段窗口内按谷价。**一天内有多个谷时段窗口**，默认
 *     北京时间 00:00–09:00、12:00–14:00、18:00–24:00（三个窗口之外是正价）；
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

/**
 * 一天中的分钟数窗口，区间为 `[startMin, endMin)`。
 *
 * - 支持跨零点（如 `22:00–06:00`，此时 `startMin > endMin`）；
 * - `endMin` 允许取 {@link DAY_MINUTES}，表示 `24:00`（当天结束）。
 */
export interface OffpeakWindow {
  startMin: number;
  endMin: number;
}

/** 一天的总分钟数。`endMin` 取该值等价于写 `24:00`。 */
export const DAY_MINUTES = 24 * 60;

export class OffpeakConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffpeakConfigError';
  }
}

const HH_MM = /^(\d{1,2}):(\d{2})$/;

/** 解析 "HH:MM" 为一天中的分钟数；非法输入抛 OffpeakConfigError。 */
export function parseTimeHHMM(text: string): number {
  return parseMinute(text, false);
}

/**
 * `parseTimeHHMM` 的内部实现。
 * @param allowEndOfDay 是否接受 `24:00`（= {@link DAY_MINUTES}）。仅窗口的**结束**时间允许，
 *   开始时间写 24:00 是无意义的（那等于空窗口），一律拒绝。
 */
function parseMinute(text: string, allowEndOfDay: boolean): number {
  const trimmed = text.trim();
  if (allowEndOfDay && trimmed === '24:00') return DAY_MINUTES;
  const match = HH_MM.exec(trimmed);
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

/** 窗口的显示串，如 `00:00–09:00`（连接符用 en dash）。 */
export function formatWindow(window: OffpeakWindow): string {
  return `${formatMinutes(window.startMin)}–${formatMinutes(window.endMin)}`;
}

/** 窗口列表的显示串，如 `00:00–09:00、12:00–14:00、18:00–24:00`。 */
export function formatWindows(windows: readonly OffpeakWindow[]): string {
  return windows.map(formatWindow).join('、');
}

/** 单个窗口的书写形式：`HH:MM-HH:MM`，连接符接受 - ~ – — 四种，两侧空白随意。 */
const WINDOW_RANGE_RE = /^(\S+?)\s*[-~–—]\s*(\S+)$/;

/**
 * 把窗口列表串切成单个窗口的书写形式。
 *
 * 先按逗号（中英文）切；若某段本身不是合法窗口（说明它是用空白分隔的多个窗口，
 * 如 `00:00-09:00 12:00-14:00`），再按空白切开。这样下面三种写法都认：
 *   `00:00-09:00,12:00-14:00`
 *   `23:00 – 07:00`（连接符两侧带空格）
 *   `00:00-09:00 12:00-14:00`（空白分隔）
 */
function splitWindowSpec(text: string): string[] {
  const parts: string[] = [];
  for (const chunk of text.split(/[,，]/)) {
    const trimmed = chunk.trim();
    if (trimmed === '') continue;
    if (WINDOW_RANGE_RE.test(trimmed)) {
      parts.push(trimmed);
      continue;
    }
    for (const piece of trimmed.split(/\s+/)) {
      if (piece !== '') parts.push(piece);
    }
  }
  return parts;
}

/**
 * 解析单个窗口书写形式（如 `00:00-09:00`、`22:00~06:00`、`18:00-24:00`）。
 * 非法输入抛 OffpeakConfigError。
 */
export function parseWindowRange(text: string): OffpeakWindow {
  const match = WINDOW_RANGE_RE.exec(text.trim());
  if (match === null) {
    throw new OffpeakConfigError(
      `窗口格式必须是 HH:MM-HH:MM（如 00:00-09:00），收到 ${JSON.stringify(text)}`,
    );
  }
  const startMin = parseMinute(match[1] as string, false);
  const endMin = parseMinute(match[2] as string, true);
  if (startMin === endMin) {
    throw new OffpeakConfigError(`窗口起止时间不能相同（那会是一个空窗口）：${JSON.stringify(text)}`);
  }
  return { startMin, endMin };
}

/**
 * 枚举一个窗口覆盖到的所有分钟槽（`[start, end)`，跨零点拆成两段）。
 *
 * `startMin === endMin` 视为空窗口、不覆盖任何分钟——与 {@link isInOffpeakWindow}
 * 的防御语义一致（配置层已禁止这种写法）。
 */
function forEachCoveredMinute(window: OffpeakWindow, visit: (minute: number) => void): void {
  if (window.startMin === window.endMin) return;
  if (window.startMin < window.endMin) {
    for (let minute = window.startMin; minute < window.endMin; minute += 1) visit(minute);
    return;
  }
  // 跨零点：[startMin, 24:00) ∪ [00:00, endMin)
  for (let minute = window.startMin; minute < DAY_MINUTES; minute += 1) visit(minute);
  for (let minute = 0; minute < window.endMin; minute += 1) visit(minute);
}

/**
 * 用 1440 个分钟槽画覆盖计数来检测重叠——跨零点与 `24:00` 都能正确处理，
 * 手写区间比较很容易在这里出错。
 */
function assertNoOverlap(windows: readonly OffpeakWindow[]): void {
  const cover = new Array<number>(DAY_MINUTES).fill(0);
  for (const window of windows) {
    forEachCoveredMinute(window, (minute) => {
      cover[minute] = (cover[minute] ?? 0) + 1;
    });
  }
  const duplicated = cover.findIndex((count) => count > 1);
  if (duplicated !== -1) {
    throw new OffpeakConfigError(
      `谷时段窗口有重叠，${formatMinutes(duplicated)} 被多个窗口覆盖：${formatWindows(windows)}`,
    );
  }
}

/**
 * 解析窗口列表书写形式，如 `00:00-09:00,12:00-14:00,18:00-24:00`。
 *
 * 空项（多余逗号/空白）会被忽略；结果按开始时间排序；重叠会在启动期直接报错。
 * 至少要有一个窗口，否则抛 OffpeakConfigError。
 */
export function parseWindowsSpec(text: string): OffpeakWindow[] {
  const parts = splitWindowSpec(text);
  if (parts.length === 0) {
    throw new OffpeakConfigError('谷时段窗口不能为空，至少需要一个 HH:MM-HH:MM');
  }
  const windows = parts.map((part) => parseWindowRange(part));
  windows.sort((a, b) => a.startMin - b.startMin);
  assertNoOverlap(windows);
  return windows;
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

/** 单个窗口判定：`[start, end)`，支持跨零点窗口。 */
export function isInOffpeakWindow(minute: number, window: OffpeakWindow): boolean {
  if (window.startMin === window.endMin) return false; // 空窗口 = 永不命中（配置层已禁止，这里防御）
  if (window.startMin < window.endMin) {
    return minute >= window.startMin && minute < window.endMin;
  }
  return minute >= window.startMin || minute < window.endMin;
}

/** 多个窗口的判定：命中**任意一个**即为谷时段。 */
export function isInOffpeakWindows(minute: number, windows: readonly OffpeakWindow[]): boolean {
  return windows.some((window) => isInOffpeakWindow(minute, window));
}

// ---------------------------------------------------------------------------
// 闸判定
// ---------------------------------------------------------------------------

export interface OffpeakGateConfig {
  enabled: boolean;
  /** 一天内的谷时段窗口列表（工作日生效；节假日/周末按配置全天谷价） */
  windows: readonly OffpeakWindow[];
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
  if (isInOffpeakWindows(minute, config.windows)) return { gated: false, reason: 'in-window' };
  return { gated: true, reason: 'peak-hours' };
}

// ---------------------------------------------------------------------------
// 运行期覆盖（热切换）+ 持久化
// ---------------------------------------------------------------------------

export interface OffpeakOverride {
  enabled?: boolean;
  windows?: readonly OffpeakWindow[];
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
  /** 生效的窗口列表，已格式化为显示串（如 `00:00–09:00`） */
  windows: string[];
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

/**
 * 覆盖文件的磁盘格式（窗口存可读的 HH:MM，便于人工排查）。
 *
 * `windows` 是当前格式；`window` 是早期只支持单窗口时的写法，只为读旧文件保留
 * （读到就当成单元素列表），不再写出。
 */
interface OverrideFile {
  enabled?: boolean;
  windows?: Array<{ start: string; end: string }>;
  /** @deprecated 旧格式，仅用于兼容读取 */
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
      windows: override.windows ?? base.windows,
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
      windows: effective.windows.map(formatWindow),
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

  /**
   * 整组替换谷时段窗口（多窗口）。
   *
   * 窗口的解析与校验由 {@link parseWindowsSpec} 负责（它在那里抛 OffpeakConfigError），
   * 这里只接收已解析的结果，避免两处各写一套校验。
   */
  setWindows(windows: readonly OffpeakWindow[], actor: string): OffpeakGateConfig {
    if (windows.length === 0) {
      throw new OffpeakConfigError('谷时段窗口不能为空，至少需要一个 HH:MM-HH:MM');
    }
    assertNoOverlap(windows);
    this.override = {
      ...this.override,
      windows: [...windows],
      updatedBy: actor,
      updatedAt: this.now(),
    };
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
      // windows 是当前格式；window 是旧的单窗口格式，读到就当成单元素列表
      const rawWindows: Array<{ start: string; end: string }> | undefined = Array.isArray(
        parsed.windows,
      )
        ? parsed.windows
        : parsed.window !== undefined
          ? [parsed.window]
          : undefined;
      if (rawWindows !== undefined && rawWindows.length > 0) {
        override.windows = rawWindows.map((item) => parseWindowRange(`${item.start}-${item.end}`));
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
            ...((override.windows?.length ?? 0) > 0
              ? {
                  windows: (override.windows ?? []).map((window) => ({
                    start: formatMinutes(window.startMin),
                    end: formatMinutes(window.endMin),
                  })),
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
      // 这里只把原始串透传，真正的解析与校验在 parseWindowsSpec 里做，
      // 失败由调用方转成"设置失败：<原因>"的用户可见回复。
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
