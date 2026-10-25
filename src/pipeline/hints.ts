/**
 * 长任务提示注入（persona 纪律的桥接层补强）。
 *
 * 背景（DESIGN §13.2 的硬边界）：长任务不阻塞会话，依赖模型**自愿**把任务
 * 派给后台子代理；协议层没有 cancel/steer，桥接层无法在派发后干预一轮的
 * 执行方式。模型最常见的失守点是"自判任务不长"——新闻核查、网页检索这类
 * 任务看起来一两次 web_fetch 就能完，实际一跑就是几分钟，会话随之卡死。
 *
 * 对策：在 prompt 组装时按关键词命中，给**这一条消息**追加一段操作提示，
 * 把"预计耗时 → 后台派发"的判断显式摆到模型面前。它是 best-effort 的
 * 纪律补强，不是派发保证——命中只注入提示，不代替模型做决定（桥接层不做
 * 自然语言分类的硬裁决：误派单的代价比漏派单更难向用户解释）。
 *
 * 误命中（如"爬虫"出现在闲聊里）的代价只是一段提示文本，模型可判断后忽略；
 * 这是刻意的取舍——漏掉的成本（会话卡死几分钟）远高于误注入的成本。
 */

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
  '（系统提示：本条消息可能是一个耗时任务（多步执行或外部抓取）。若预计耗时较长，请务必用 ' +
  'subagent 工具后台派发（run_in_background 默认为 true），派发后立即用一句话回执并结束本轮；' +
  '绝不要在本轮同步等待它完成——那会让会话对所有新消息无响应。若实际一两步就能完成，则忽略本提示。）';

/** 本条消息是否命中长任务提示（大小写不敏感的子串匹配）。 */
export function matchLongTaskHint(content: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const text = content.toLowerCase();
  return patterns.some((pattern) => text.includes(pattern.toLowerCase()));
}
