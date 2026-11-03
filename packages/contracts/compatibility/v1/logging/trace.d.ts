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
export type createTrace = (fields?: Omit<Partial<TraceContext>, 'traceId' | 'spanId'>, id?: () => string) => TraceContext;
export type traceSpan = (parent: TraceContext, fields?: Partial<TraceContext>, id?: () => string) => TraceContext;
/** 旧 Task 和队列无需同时存在，也会得到同一 trace。 */
export type legacyTrace = (taskId: string, sessionKey?: string) => TraceContext;
