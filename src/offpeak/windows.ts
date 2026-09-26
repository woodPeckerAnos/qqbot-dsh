/**
 * 谷时段窗口：解析、格式化与命中判定。
 *
 * 这是谷时段闸的"配置 DSL"——同一份解析逻辑服务三个调用方：
 *   - 启动期 config.ts 解析 env / 配置文件默认值；
 *   - 运行期管理员 /offpeak window 命令热切换；
 *   - OffpeakGate 加载持久化的运行期覆盖文件。
 * 因此它属于 offpeak 领域模块，而不是只属于 config 层。
 *
 * 非法输入一律抛 OffpeakConfigError，由调用方决定包装成启动期
 * ConfigError 还是用户可见的"设置失败"回复。
 */

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
 *
 * 导出给 gate.ts 的 setWindows 复用（运行期热切换与启动期解析走同一套校验）。
 */
export function assertNoOverlap(windows: readonly OffpeakWindow[]): void {
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
