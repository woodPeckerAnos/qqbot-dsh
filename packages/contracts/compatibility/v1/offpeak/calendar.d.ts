/**
 * 谷时段日历：时区换算、周末判定与法定节假日表。
 *
 * 按 DeepSeek 计费规则（见 index.ts 文件头），周六/周日与中国法定节假日
 * 全天按谷价计费。节假日表内置国务院办公厅《关于 2026 年部分节假日安排的
 * 通知》（国办发明电〔2025〕7 号），跨年数据由 env（QQ_OFFPEAK_HOLIDAYS）
 * 或管理员 /offpeak holiday 命令追加。
 *
 * 全部基于 Intl.DateTimeFormat 做时区换算，不依赖宿主进程的本地时区。
 */
/** 校验时区名是否被当前 ICU 认识（配置错误要在启动期爆出来）。 */
export type isValidTimeZone = (timeZone: string) => boolean;
/** 某时刻在指定时区里是一天中的第几分钟。 */
export type minutesInTimeZone = (ts: number, timeZone: string) => number;
/**
 * 官方节假日历（2026 年，含调休休息日）。
 * 来源：国务院办公厅《关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7 号，
 * 2025-11-04 发布）。按 DeepSeek 规则，放假调休期间全天按空闲时段计费。
 * 周末日期列在其中无害（周末本就全天谷价），列全是为了与官方通知逐条对应、便于核对。
 */
export declare const CN_HOLIDAYS_2026: readonly string[];
/** 校验 YYYY-MM-DD 是真实存在的日期（拒绝 2026-02-30 之类）。 */
export type isValidDateString = (text: string) => boolean;
/** 某时刻在指定时区里的日历日期（YYYY-MM-DD）。 */
export type dateStringInTimeZone = (ts: number, timeZone: string) => string;
/** 某时刻在指定时区里是否为周六/周日。 */
export type isWeekendInTimeZone = (ts: number, timeZone: string) => boolean;
