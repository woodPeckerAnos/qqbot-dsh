/**
 * 上游内容安全过滤的稳定识别。
 *
 * DSH 的 turn/end 只给一段简短错误消息（例如
 * `Output data may contain inappropriate content.`），不把原始响应或提示词
 * 带进应用日志。调用方只根据这段消息决定用户说明与上下文刷新，不展示原文。
 */
const CONTENT_SAFETY =
  /(?:inappropriate\s+content|content[\s_-]?filter|safety|内容安全|敏感内容)/iu;

export function isContentSafetyFailure(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const message = (cause as Record<string, unknown>)['message'];
  return typeof message === 'string' && CONTENT_SAFETY.test(message);
}
