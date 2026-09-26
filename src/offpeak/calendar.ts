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
