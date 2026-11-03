/** Deprecated configuration compatibility. Production lane prompts do not use keyword hints. */

export type { LongTaskHintConfig } from '@qqbot/contracts';

/** 默认命中词：覆盖实测中"模型自判不长、实际卡死会话"的典型任务类。 */
export { DEFAULT_LONG_TASK_PATTERNS } from '@qqbot/contracts';

export { DEFAULT_LONG_TASK_HINT_TEXT } from '@qqbot/contracts';

/** 本条消息是否命中长任务提示（大小写不敏感的子串匹配）。 */
export function matchLongTaskHint(content: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const text = content.toLowerCase();
  return patterns.some((pattern) => text.includes(pattern.toLowerCase()));
}
