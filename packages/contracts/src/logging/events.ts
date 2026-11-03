import { immutableConstant } from '../readonly.js';
import type { LogLevel } from '../logger.js';

export const LOG_CATEGORIES = immutableConstant([
  'input',
  'proactive',
  'task',
  'agent',
  'runtime',
  'delivery',
  'system',
  'legacy',
] as const);
export type LogCategory = (typeof LOG_CATEGORIES)[number];
const spec = <const Fields extends readonly string[]>(
  level: LogLevel,
  component: LogCategory,
  msg: string,
  fields: Fields,
  diagnostic = false
) => ({ level, component, msg, fields, diagnostic });
/** 文案和字段由目录拥有；不得传正文、工具参数/结果或任意错误消息。 */
export const EVENTS = immutableConstant({
  'input.received': spec('info', 'input', '输入已归一化', [
    'source',
    'contentLength',
    'attachmentCount',
  ]),
  'input.decision': spec('info', 'input', '输入判定完成', ['related', 'mentionsChatRecord']),
  'input.shortcut': spec('debug', 'input', '输入已短路', ['reason', 'stage'], true),
  'input.rejected': spec('info', 'input', '输入未准入', ['reason', 'errorId']),
  'proactive.evaluation': spec(
    'debug',
    'proactive',
    '主动评估开始',
    ['trigger', 'candidateCount'],
    true
  ),
  'proactive.decision': spec(
    'info',
    'proactive',
    '主动评估完成',
    ['action', 'reason', 'scene', 'trigger'],
    true
  ),
  'proactive.wait': spec('debug', 'proactive', '主动等待票据', ['action', 'targetId'], true),
  'task.created': spec('info', 'task', 'Task 已持久化准入', ['source', 'generation']),
  'task.lane': spec('info', 'task', 'Lane 状态已提交', [
    'status',
    'resultKind',
    'errorId',
    'errorClass',
  ]),
  'task.terminal': spec('info', 'task', 'Task 执行已终结', ['status', 'durationMs']),
  'task.cancel': spec('info', 'task', 'Task 已接受取消', [
    'initiatorTraceId',
    'initiatorSpanId',
    'initiatorTaskId',
  ]),
  'execution.started': spec('info', 'agent', 'DSH 执行开始', []),
  'execution.ended': spec('info', 'agent', 'DSH 执行结束', [
    'resultKind',
    'durationMs',
    'errorId',
    'errorClass',
  ]),
  'artifact.prepared': spec('info', 'agent', '产物整理完成', [
    'resultKind',
    'contentLength',
    'attachmentCount',
    'durationMs',
    'errorId',
  ]),
  'agent.detail': spec(
    'debug',
    'agent',
    'Agent 定向诊断',
    [
      'dshSeq',
      'eventType',
      'turn',
      'step',
      'toolClass',
      'durationMs',
      'inputTokens',
      'outputTokens',
    ],
    true
  ),
  'agent.started': spec('info', 'agent', '子代理已启动', ['parentDshSessionId']),
  'agent.ended': spec('info', 'agent', '子代理已终结', ['parentDshSessionId', 'status', 'dshSeq']),
  'agent.summary': spec('info', 'agent', 'Agent 执行汇总', [
    'dshSeq',
    'turns',
    'steps',
    'tools',
    'retries',
    'subagents',
    'usage',
    'toolCounts',
    'errors',
    'suppressed',
    'invalid',
    'unknown',
    'late',
    'duplicate',
    'overflow',
    'incomplete',
  ]),
  'delivery.enqueued': spec('info', 'delivery', '消息已持久化入队', [
    'kind',
    'contentLength',
    'attachmentCount',
    'notification',
    'sourceMessageId',
  ]),
  'delivery.attempt': spec('info', 'delivery', '消息发送尝试已提交', ['anchorMessageId', 'seq']),
  'delivery.terminal': spec('info', 'delivery', '消息投递已终结', [
    'status',
    'durationMs',
    'errorId',
    'errorClass',
    'recovered',
  ]),
  'delivery.notice': spec('info', 'delivery', '失败通知已关联', ['sourceMessageId', 'errorId']),
  'runtime.started': spec('info', 'runtime', 'DSH 进程已启动', ['pid']),
  'runtime.ready': spec('info', 'runtime', 'DSH 进程已就绪', ['pid', 'version']),
  'runtime.stderr': spec('debug', 'runtime', 'DSH stderr 元数据', ['bytes', 'lines'], true),
  'runtime.notification': spec('debug', 'runtime', 'DSH 通知无法识别', ['reason'], true),
  'root.error': spec('error', 'system', '首次故障根因', [
    'errorId',
    'errorClass',
    'code',
    'signal',
    'bytes',
  ]),
  'logging.suppressed': spec('info', 'system', '日志抑制汇总', ['counts', 'executionId']),
  'logging.configured': spec('info', 'system', '日志配置已应用', [
    'diagnosticTargets',
    'expiresAt',
  ]),
  'logging.reload_failed': spec('warn', 'system', '日志配置重载失败，保留原配置', ['errorClass']),
} as const);
export type EventName = keyof typeof EVENTS;
export type EventFields = Record<string, unknown>;

export type EventFieldsFor<Name extends EventName> = Partial<
  Record<(typeof EVENTS)[Name]['fields'][number], unknown>
>;
