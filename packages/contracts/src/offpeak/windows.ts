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
export type createOffpeakConfigErrorFactory = (message: string) => OffpeakConfigError;
/** 解析 "HH:MM" 为一天中的分钟数；非法输入抛 OffpeakConfigError。 */
export type parseTimeHHMM = (text: string) => number;
export type formatMinutes = (totalMin: number) => string;
/** 窗口的显示串，如 `00:00–09:00`（连接符用 en dash）。 */
export type formatWindow = (window: OffpeakWindow) => string;
/** 窗口列表的显示串，如 `00:00–09:00、12:00–14:00、18:00–24:00`。 */
export type formatWindows = (windows: readonly OffpeakWindow[]) => string;
/**
 * 解析单个窗口书写形式（如 `00:00-09:00`、`22:00~06:00`、`18:00-24:00`）。
 * 非法输入抛 OffpeakConfigError。
 */
export type parseWindowRange = (text: string) => OffpeakWindow;
/**
 * 用 1440 个分钟槽画覆盖计数来检测重叠——跨零点与 `24:00` 都能正确处理，
 * 手写区间比较很容易在这里出错。
 *
 * 导出给 gate.ts 的 setWindows 复用（运行期热切换与启动期解析走同一套校验）。
 */
export type assertNoOverlap = (windows: readonly OffpeakWindow[]) => void;
/**
 * 解析窗口列表书写形式，如 `00:00-09:00,12:00-14:00,18:00-24:00`。
 *
 * 空项（多余逗号/空白）会被忽略；结果按开始时间排序；重叠会在启动期直接报错。
 * 至少要有一个窗口，否则抛 OffpeakConfigError。
 */
export type parseWindowsSpec = (text: string) => OffpeakWindow[];
/** 单个窗口判定：`[start, end)`，支持跨零点窗口。 */
export type isInOffpeakWindow = (minute: number, window: OffpeakWindow) => boolean;
/** 多个窗口的判定：命中**任意一个**即为谷时段。 */
export type isInOffpeakWindows = (minute: number, windows: readonly OffpeakWindow[]) => boolean;
