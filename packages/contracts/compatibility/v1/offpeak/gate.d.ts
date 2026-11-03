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
import type { DeepReadonly } from '@qqbot/contracts';
import type { Logger } from '../logger.js';
import type { OffpeakWindow } from './windows.js';
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
export type GateReason = 'admin' | 'disabled' | 'model-mismatch' | 'weekend' | 'holiday' | 'in-window' | 'peak-hours';
export interface GateDecision {
    gated: boolean;
    reason: GateReason;
}
export type evaluateGate = (args: {
    config: OffpeakGateConfig;
    provider: string;
    model: string;
    isAdmin: boolean;
    now: number;
}) => GateDecision;
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
interface OffpeakSnapshotValue {
    enabled: boolean;
    /** 生效的窗口列表，已格式化为显示串（如 `00:00–09:00`） */
    windows: readonly string[];
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
export type OffpeakSnapshot = DeepReadonly<OffpeakSnapshotValue>;
export interface OffpeakGate {
    /** 当前生效配置 = env 默认 + 运行期覆盖。每次调用现算，改完下条消息即生效。 */
    effective(): DeepReadonly<OffpeakGateConfig>;
    snapshot(): DeepReadonly<OffpeakSnapshot>;
    /** 追加一个全天谷价日期。日期非法抛 OffpeakConfigError。 */
    addHoliday(date: string, actor: string): DeepReadonly<OffpeakGateConfig>;
    /** 移除一个全天谷价日期（从默认表与追加表中同时剔除）。 */
    delHoliday(date: string, actor: string): DeepReadonly<OffpeakGateConfig>;
    setEnabled(enabled: boolean, actor: string): DeepReadonly<OffpeakGateConfig>;
    /**
     * 整组替换谷时段窗口（多窗口）。
     *
     * 窗口的解析与校验由 windows.ts 的 parseWindowsSpec 负责（它在那里抛
     * OffpeakConfigError），这里只接收已解析的结果，避免两处各写一套校验。
     */
    setWindows(windows: readonly OffpeakWindow[], actor: string): DeepReadonly<OffpeakGateConfig>;
    clearOverride(actor: string): void;
}
export type createOffpeakGateFactory = (options: {
    defaults: OffpeakGateConfig;
    filePath: string;
    logger: Logger;
    now?: () => number;
    persistOverride?: (file: string, text: string) => void;
}) => OffpeakGate;
export {};
