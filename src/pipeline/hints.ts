/** Deprecated configuration compatibility. Production lane prompts do not use keyword hints. */

export interface LongTaskHintConfig {
  enabled: boolean;
  /** 命中子串（大小写不敏感）；空串条目在配置层已被滤掉 */
  patterns: string[];
  /** 注入的提示文本 */
  text: string;
}

/** 默认命中词：覆盖实测中"模型自判不长、实际卡死会话"的典型任务类。 */
export const DEFAULT_LONG_TASK_PATTERNS = [
  '核查',
  '核实',
  '爬取',
  '抓取',
  '批量',
  '编译',
  '监控',
  '汇总',
  '调研',
  '新闻',
];

export const DEFAULT_LONG_TASK_HINT_TEXT =
  '（系统提示：本条消息可能是一个耗时任务（多步执行或外部抓取）。' +
  '慢 lane 完整执行，并以前台模式等待所有 subagent 子代理结束，随后给出最终结果；实际执行失败要明确报告。）';

/** 本条消息是否命中长任务提示（大小写不敏感的子串匹配）。 */
export function matchLongTaskHint(content: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const text = content.toLowerCase();
  return patterns.some((pattern) => text.includes(pattern.toLowerCase()));
}
