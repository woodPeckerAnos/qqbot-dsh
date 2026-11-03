import type { TraceContext } from '../../logger.js';
import type { NormalizedMessage } from '../../core/connector.js';
import type { MessageQueue } from '../../task/message-queue.js';
export interface Responder {
    error(text: string): Promise<void>;
}
export type createResponderFactory = (options: {
    message: NormalizedMessage;
    queue: MessageQueue;
    trace?: TraceContext;
}) => Responder;
