/** Public module boundary. Consumers receive contract interfaces. */
import { OffpeakGate } from './gate.js';
export const createOffpeakGate: import('@qqbot/contracts').createOffpeakGateFactory = (...args) =>
  new OffpeakGate(...args);
import {
  isValidTimeZone as isValidTimeZoneImplementation,
  minutesInTimeZone as minutesInTimeZoneImplementation,
  isValidDateString as isValidDateStringImplementation,
  dateStringInTimeZone as dateStringInTimeZoneImplementation,
  isWeekendInTimeZone as isWeekendInTimeZoneImplementation,
} from './calendar.js';
export const isValidTimeZone: import('@qqbot/contracts').isValidTimeZone =
  isValidTimeZoneImplementation;
export const minutesInTimeZone: import('@qqbot/contracts').minutesInTimeZone =
  minutesInTimeZoneImplementation;
export const isValidDateString: import('@qqbot/contracts').isValidDateString =
  isValidDateStringImplementation;
export const dateStringInTimeZone: import('@qqbot/contracts').dateStringInTimeZone =
  dateStringInTimeZoneImplementation;
export const isWeekendInTimeZone: import('@qqbot/contracts').isWeekendInTimeZone =
  isWeekendInTimeZoneImplementation;
export { CN_HOLIDAYS_2026 } from './calendar.js';
import {
  parseOffpeakCommand as parseOffpeakCommandImplementation,
  commandNeedsAdmin as commandNeedsAdminImplementation,
  renderGateNotice as renderGateNoticeImplementation,
} from './command.js';
export const parseOffpeakCommand: import('@qqbot/contracts').parseOffpeakCommand =
  parseOffpeakCommandImplementation;
export const commandNeedsAdmin: import('@qqbot/contracts').commandNeedsAdmin =
  commandNeedsAdminImplementation;
export const renderGateNotice: import('@qqbot/contracts').renderGateNotice =
  renderGateNoticeImplementation;
export { OFFPEAK_COMMAND_USAGE } from './command.js';
import { evaluateGate as evaluateGateImplementation } from './gate.js';
export const evaluateGate: import('@qqbot/contracts').evaluateGate = evaluateGateImplementation;
import {
  parseTimeHHMM as parseTimeHHMMImplementation,
  formatMinutes as formatMinutesImplementation,
  formatWindow as formatWindowImplementation,
  formatWindows as formatWindowsImplementation,
  parseWindowRange as parseWindowRangeImplementation,
  assertNoOverlap as assertNoOverlapImplementation,
  parseWindowsSpec as parseWindowsSpecImplementation,
  isInOffpeakWindow as isInOffpeakWindowImplementation,
  isInOffpeakWindows as isInOffpeakWindowsImplementation,
} from './windows.js';
export const parseTimeHHMM: import('@qqbot/contracts').parseTimeHHMM = parseTimeHHMMImplementation;
export const formatMinutes: import('@qqbot/contracts').formatMinutes = formatMinutesImplementation;
export const formatWindow: import('@qqbot/contracts').formatWindow = formatWindowImplementation;
export const formatWindows: import('@qqbot/contracts').formatWindows = formatWindowsImplementation;
export const parseWindowRange: import('@qqbot/contracts').parseWindowRange =
  parseWindowRangeImplementation;
export const assertNoOverlap: import('@qqbot/contracts').assertNoOverlap =
  assertNoOverlapImplementation;
export const parseWindowsSpec: import('@qqbot/contracts').parseWindowsSpec =
  parseWindowsSpecImplementation;
export const isInOffpeakWindow: import('@qqbot/contracts').isInOffpeakWindow =
  isInOffpeakWindowImplementation;
export const isInOffpeakWindows: import('@qqbot/contracts').isInOffpeakWindows =
  isInOffpeakWindowsImplementation;
export { DAY_MINUTES, OffpeakConfigError } from './windows.js';
