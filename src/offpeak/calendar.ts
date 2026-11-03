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
export { CN_HOLIDAYS_2026 } from '@qqbot/contracts';

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
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
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
