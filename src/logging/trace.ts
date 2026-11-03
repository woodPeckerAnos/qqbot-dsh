import { createHash, randomUUID } from 'node:crypto';

/** 值对象显式传递；不依赖异步局部变量，队列可独立持久化。 */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sessionKey?: string;
  readonly inputMessageId?: string;
  readonly inputEventId?: string;
  readonly taskId?: string;
  readonly lane?: 'fast' | 'slow';
  readonly executionId?: string;
  readonly runtimeGeneration?: string;
  readonly dshSessionId?: string;
  readonly messageId?: string;
  readonly historicalTraceMissing?: boolean;
}
export function createTrace(
  fields: Omit<Partial<TraceContext>, 'traceId' | 'spanId'> = {},
  id: () => string = randomUUID
): TraceContext {
  return Object.freeze({ ...fields, traceId: id(), spanId: id() });
}
export function traceSpan(
  parent: TraceContext,
  fields: Partial<TraceContext> = {},
  id: () => string = randomUUID
): TraceContext {
  return Object.freeze({
    ...parent,
    ...fields,
    traceId: parent.traceId,
    spanId: id(),
    parentSpanId: parent.spanId,
  });
}
/** 旧 Task 和队列无需同时存在，也会得到同一 trace。 */
export function legacyTrace(taskId: string, sessionKey?: string): TraceContext {
  const traceId = createHash('sha256').update(`qqbot:legacy:${taskId}`).digest('hex').slice(0, 32);
  return Object.freeze({
    traceId,
    spanId: `${traceId}:legacy`,
    taskId,
    sessionKey,
    historicalTraceMissing: true,
  });
}
