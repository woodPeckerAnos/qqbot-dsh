import type {
  OffpeakGateConfig,
  GateDecision,
  OffpeakOverride,
  OffpeakSnapshot,
} from '@qqbot/contracts';
/**
 * 谷时段闸：运行时判定（evaluateGate）与有状态服务（OffpeakGate）。
 *
 * - `evaluateGate` 是纯函数：给定生效配置与运行时输入（当前时刻、模型身份、
 *   是否管理员），回答"这条消息要不要拦"。它不是配置校验——配置合法性在
 *   windows.ts / config.ts 启动期已经保证；它是每条消息都要执行的业务策略。
 * - `OffpeakGate` 持有运行期覆盖（管理员 /offpeak 命令热切换），并原子持久化
 *   到 stateDir。当前生效配置 = env 默认 + 运行期覆盖，每次调用现算，
 *   改完下一条消息即生效。
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { readonlySnapshot, failure, type DeepReadonly } from '@qqbot/contracts';
import type { Logger } from '@qqbot/contracts';
import {
  dateStringInTimeZone,
  isValidDateString,
  isWeekendInTimeZone,
  minutesInTimeZone,
} from './calendar.js';
import {
  assertNoOverlap,
  formatMinutes,
  formatWindow,
  isInOffpeakWindows,
  parseWindowRange,
} from './windows.js';
import { OffpeakConfigError } from '@qqbot/contracts';
import type { OffpeakWindow } from '@qqbot/contracts';

export type { OffpeakGateConfig } from '@qqbot/contracts';

export type { GateReason } from '@qqbot/contracts';

export type { GateDecision } from '@qqbot/contracts';

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
  // 节假日与周末全天谷价，先于时间窗口判定（官方规则见 index.ts 文件头注释）
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

export type { OffpeakOverride } from '@qqbot/contracts';

/** /metrics 里暴露的闸状态快照。 */
export type { OffpeakSnapshot } from '@qqbot/contracts';

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
      persistOverride?: (file: string, text: string) => void;
    }
  ) {
    this.options = { ...options, defaults: readonlySnapshot(options.defaults) };
    this.override = this.load();
  }

  /** 当前生效配置 = env 默认 + 运行期覆盖。每次调用现算，改完下条消息即生效。 */
  effective(): DeepReadonly<OffpeakGateConfig> {
    const base = this.options.defaults;
    const override = this.override;
    if (override === undefined) return readonlySnapshot(base);
    let holidays = base.holidays;
    if ((override.holidaysAdd?.length ?? 0) > 0 || (override.holidaysDel?.length ?? 0) > 0) {
      const merged = new Set(base.holidays);
      for (const date of override.holidaysAdd ?? []) merged.add(date);
      for (const date of override.holidaysDel ?? []) merged.delete(date);
      holidays = merged;
    }
    return readonlySnapshot({
      enabled: override.enabled ?? base.enabled,
      windows: override.windows ?? base.windows,
      timeZone: base.timeZone,
      modelPattern: base.modelPattern,
      weekendsAllDay: base.weekendsAllDay,
      holidays,
    });
  }

  snapshot(): DeepReadonly<OffpeakSnapshot> {
    const effective = this.effective();
    const override = this.override;
    const sorted = [...effective.holidays].sort();
    return readonlySnapshot({
      enabled: effective.enabled,
      windows: effective.windows.map(formatWindow),
      timeZone: effective.timeZone,
      modelPattern: effective.modelPattern,
      weekendsAllDay: effective.weekendsAllDay,
      holidaysCount: sorted.length,
      ...(sorted.length > 0 ? { holidaysCoverageUntil: sorted[sorted.length - 1] } : {}),
      overridden: override !== undefined,
      ...(override !== undefined
        ? { updatedBy: override.updatedBy, updatedAt: override.updatedAt }
        : {}),
    });
  }

  /** 追加一个全天谷价日期。日期非法抛 OffpeakConfigError。 */
  addHoliday(date: string, actor: string): DeepReadonly<OffpeakGateConfig> {
    const normalized = date.trim();
    if (!isValidDateString(normalized)) {
      throw new OffpeakConfigError(`日期必须是真实存在的 YYYY-MM-DD，收到 ${JSON.stringify(date)}`);
    }
    const add = (this.override?.holidaysAdd ?? []).filter((item) => item !== normalized);
    const del = (this.override?.holidaysDel ?? []).filter((item) => item !== normalized);
    add.push(normalized);
    this.commitOverride({
      ...this.override,
      holidaysAdd: [...add].sort(),
      holidaysDel: [...del].sort(),
      updatedBy: actor,
      updatedAt: this.now(),
    });
    return this.effective();
  }

  /** 移除一个全天谷价日期（从默认表与追加表中同时剔除）。 */
  delHoliday(date: string, actor: string): DeepReadonly<OffpeakGateConfig> {
    const normalized = date.trim();
    if (!isValidDateString(normalized)) {
      throw new OffpeakConfigError(`日期必须是真实存在的 YYYY-MM-DD，收到 ${JSON.stringify(date)}`);
    }
    const add = (this.override?.holidaysAdd ?? []).filter((item) => item !== normalized);
    const del = (this.override?.holidaysDel ?? []).filter((item) => item !== normalized);
    del.push(normalized);
    this.commitOverride({
      ...this.override,
      holidaysAdd: [...add].sort(),
      holidaysDel: [...del].sort(),
      updatedBy: actor,
      updatedAt: this.now(),
    });
    return this.effective();
  }

  setEnabled(enabled: boolean, actor: string): DeepReadonly<OffpeakGateConfig> {
    this.commitOverride({ ...this.override, enabled, updatedBy: actor, updatedAt: this.now() });
    return this.effective();
  }

  /**
   * 整组替换谷时段窗口（多窗口）。
   *
   * 窗口的解析与校验由 windows.ts 的 parseWindowsSpec 负责（它在那里抛
   * OffpeakConfigError），这里只接收已解析的结果，避免两处各写一套校验。
   */
  setWindows(windows: readonly OffpeakWindow[], actor: string): DeepReadonly<OffpeakGateConfig> {
    if (windows.length === 0) {
      throw new OffpeakConfigError('谷时段窗口不能为空，至少需要一个 HH:MM-HH:MM');
    }
    assertNoOverlap(windows);
    this.commitOverride({
      ...this.override,
      windows: structuredClone(windows),
      updatedBy: actor,
      updatedAt: this.now(),
    });
    return this.effective();
  }

  clearOverride(actor: string): void {
    this.commitOverride(undefined);
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
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
        this.options.logger.warn('谷时段覆盖读取失败，使用默认值', {
          code: 'UPSTREAM_FAILED',
          errorId: this.options.logger.cause(cause, 'persistence'),
        });
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
      let rawWindows: Array<{ start: string; end: string }> | undefined;
      if (Array.isArray(parsed.windows)) rawWindows = parsed.windows;
      else if (parsed.window !== undefined) rawWindows = [parsed.window];
      if (rawWindows !== undefined && rawWindows.length > 0) {
        override.windows = rawWindows.map((item) => parseWindowRange(`${item.start}-${item.end}`));
      }
      if (Array.isArray(parsed.holidaysAdd)) {
        override.holidaysAdd = parsed.holidaysAdd.filter(
          (item): item is string => typeof item === 'string' && isValidDateString(item)
        );
      }
      if (Array.isArray(parsed.holidaysDel)) {
        override.holidaysDel = parsed.holidaysDel.filter(
          (item): item is string => typeof item === 'string' && isValidDateString(item)
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
  private commitOverride(candidate: OffpeakOverride | undefined): void {
    this.persist(candidate);
    this.override = candidate;
  }

  private persist(override: OffpeakOverride | undefined): void {
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
            ...((override.holidaysAdd?.length ?? 0) > 0
              ? { holidaysAdd: override.holidaysAdd }
              : {}),
            ...((override.holidaysDel?.length ?? 0) > 0
              ? { holidaysDel: override.holidaysDel }
              : {}),
          };
    try {
      const text = `${JSON.stringify(file, null, 2)}\n`;
      if (this.options.persistOverride) {
        this.options.persistOverride(this.options.filePath, text);
        return;
      }
      mkdirSync(dirname(this.options.filePath), { recursive: true });
      const tmp = `${this.options.filePath}.tmp`;
      writeFileSync(tmp, text, 'utf8');
      renameSync(tmp, this.options.filePath);
    } catch (error) {
      const info = failure(
        'PERSISTENCE_FAILED',
        error,
        this.options.logger.cause(error, 'persistence')
      );
      throw Object.assign(new Error('谷时段覆盖保存失败', { cause: error }), { error: info });
    }
  }
}
