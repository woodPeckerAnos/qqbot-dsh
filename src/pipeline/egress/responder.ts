import type { NormalizedMessage } from '../../core/connector.js';
import type { MessageQueue } from '../../task/message-queue.js';

/**
 * 命令回执和准入错误也通过持久消息队列发送，共享平台锚点的条数与 seq。
 * ingress 归属 ID 仅用于消息记账，不创建执行 Task、不消耗主动预算。
 */
export class Responder {
  constructor(private readonly options: { message: NormalizedMessage; queue: MessageQueue }) {}
  async error(text: string): Promise<void> {
    this.options.queue.enqueue({ taskId: `ingress-${this.options.message.eventId}`, lane: 'fast', message: this.options.message, text, kind: 'error' });
  }
}
