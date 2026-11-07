import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type {
  DshRuntimeOptions,
  ExecutionAck,
  ExecutionBinding,
  ExecutionHandlers,
  ExecutionControlRequest,
  TaskCooperationRequest,
  TaskCooperationUpdate,
} from '@qqbot/contracts';

/** fd 3 transport is lane-stable; authority and pending waits are per execution. */
export class ExecutionChannel {
  private active?: {
    binding: ExecutionBinding;
    handlers: ExecutionHandlers;
    abort: AbortController;
  };
  private readonly pending = new Map<
    string,
    { resolve: (value: ExecutionAck) => void; reject: (error: Error) => void }
  >();
  private readonly closed = new AbortController();
  private buffer = '';
  constructor(
    private readonly stream: Duplex,
    private readonly options: DshRuntimeOptions,
    close: () => void
  ) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      this.read(chunk);
    });
    const end = () => {
      if (this.closed.signal.aborted) return;
      this.clear();
      this.closed.abort();
      close();
    };
    stream.on('close', end);
    stream.on('error', (error) => {
      end();
      options.logger.warn('Task 控制通道关闭', { error: error.message });
    });
  }
  private read(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 65536) {
      this.stream.destroy();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.receive(line);
    }
  }
  private receive(line: string): void {
    try {
      const packet = JSON.parse(line) as Record<string, unknown>;
      if (typeof packet.id !== 'string') throw new Error('控制消息缺少 id');
      if (packet.type === 'execution-response') {
        this.receiveAck(packet.id, packet);
        return;
      }
      const id = packet.id;
      void Promise.resolve()
        .then(() => this.dispatch(packet))
        .then(
          (value) => {
            this.send({ id, value });
          },
          (error: unknown) => {
            this.send({ id, error: String(error) });
          }
        );
    } catch (error) {
      this.options.logger.warn('Task 控制协议异常', { error: String(error) });
      this.stream.destroy();
    }
  }
  private receiveAck(id: string, packet: Record<string, unknown>): void {
    const waiter = this.pending.get(id);
    if (packet.error)
      waiter?.reject(new Error(typeof packet.error === 'string' ? packet.error : '执行确认失败'));
    else waiter?.resolve(packet.value as ExecutionAck);
  }
  private dispatch(packet: Record<string, unknown>): unknown {
    if (typeof packet.action !== 'string') throw new Error('未知控制请求');
    const active = this.active;
    if (active) {
      if (!matches(active.binding, packet) || active.abort.signal.aborted)
        throw new Error('执行身份不匹配或已失效');
      return this.dispatchBound(packet, active);
    }
    if (this.options.env?.QQBOT_TASK_CHANNEL) throw new Error('执行身份已解绑');
    return this.dispatchLegacy(packet);
  }
  private dispatchBound(
    packet: Record<string, unknown>,
    active: NonNullable<ExecutionChannel['active']>
  ): unknown {
    if (String(packet.action).startsWith('cooperation-'))
      return active.handlers.cooperation?.(
        packet as unknown as TaskCooperationRequest,
        AbortSignal.any([active.abort.signal, this.closed.signal])
      );
    return active.handlers.control(packet as unknown as ExecutionControlRequest);
  }
  private dispatchLegacy(packet: Record<string, unknown>): unknown {
    if (String(packet.action).startsWith('cooperation-'))
      return this.options.taskCooperation?.(
        packet as unknown as TaskCooperationRequest,
        this.closed.signal
      );
    return this.options.taskControl?.(
      packet as unknown as { action: string; taskId?: string; sessionId?: string }
    );
  }
  async bind(binding: ExecutionBinding, handlers: ExecutionHandlers): Promise<ExecutionAck> {
    if (this.active) throw new Error('执行尚未解绑');
    this.active = {
      binding: Object.freeze({ ...binding }),
      handlers,
      abort: new AbortController(),
    };
    return this.request('bind', binding);
  }
  async unbind(binding: ExecutionBinding): Promise<ExecutionAck> {
    const ack = await this.request('unbind', binding);
    this.active?.abort.abort();
    this.active = undefined;
    return ack;
  }
  cancel(binding: ExecutionBinding): Promise<ExecutionAck> {
    if (!this.active || !matches(this.active.binding, binding))
      return Promise.reject(new Error('执行绑定已失效'));
    this.active.abort.abort();
    return this.request('cancel', binding);
  }
  quiesce(binding: ExecutionBinding): Promise<ExecutionAck> {
    return this.request('quiesce', binding);
  }
  push(update: TaskCooperationUpdate): void {
    this.send(update);
  }
  dispose(): void {
    this.clear();
    this.stream.destroy();
  }
  private clear(): void {
    this.active?.abort.abort();
    for (const waiter of this.pending.values()) waiter.reject(new Error('执行绑定通道关闭'));
    this.pending.clear();
  }
  private request(action: string, binding: ExecutionBinding): Promise<ExecutionAck> {
    if (!this.active || !matches(this.active.binding, binding))
      return Promise.reject(new Error('执行绑定已失效'));
    if (this.stream.destroyed) return Promise.reject(new Error('执行绑定通道不可用'));
    return this.waitForAck(action, binding);
  }
  private waitForAck(action: string, binding: ExecutionBinding): Promise<ExecutionAck> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        failed(new Error('执行确认超时'));
      }, this.options.shutdownTimeoutMs);
      const confirmed = (ack: ExecutionAck | undefined) => {
        cleanup();
        if (!ack?.idle || !matches(binding, ack.binding))
          reject(new Error('执行确认身份不匹配或未静止'));
        else resolve(ack);
      };
      this.pending.set(id, { resolve: confirmed, reject: failed });
      this.stream.write(
        JSON.stringify({ type: 'execution', id, action, binding }) + '\n',
        (error) => {
          if (error) failed(error);
        }
      );
    });
  }
  private send(value: unknown): void {
    if (!this.stream.destroyed) this.stream.write(JSON.stringify(value) + '\n');
  }
}
function matches(binding: ExecutionBinding, candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  return Object.entries(binding).every(
    ([key, value]) => (candidate as Record<string, unknown>)[key] === value
  );
}
