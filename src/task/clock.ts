/** 执行超时、出口超时和存活提醒共用可注入时钟，验收无需等待真实时间。 */
export interface TaskClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
/** 定时器不独占进程存活；关闭时仍由所属模块主动清理。 */
export const SYSTEM_CLOCK: TaskClock = {
  now: Date.now,
  setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clearTimeout,
};
