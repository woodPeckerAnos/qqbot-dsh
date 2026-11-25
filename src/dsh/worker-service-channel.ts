import { failure } from '@qqbot/contracts';
import type { DshRuntimeOptions, WorkerServiceRequest, WorkerBudgetUpdate } from '@qqbot/contracts';
import type { Duplex } from 'node:stream';

/** Bounded worker-only fd3; closure cancels HTTP and queued capabilities. */
export class WorkerServiceChannel {
  private buffer = '';
  private readonly requests = new Map<string, AbortController>();
  private readonly abort = new AbortController();
  constructor(
    private readonly channel: Duplex,
    private readonly options: DshRuntimeOptions,
    private readonly onClosed: () => void
  ) {
    channel.setEncoding('utf8');
    channel.on('data', (chunk: string) => {
      this.receive(chunk);
    });
    channel.on('close', () => {
      this.close();
    });
    channel.on('error', (error) => {
      options.logger.cause(error, 'worker-service-channel');
      this.close();
    });
  }
  notify(update: WorkerBudgetUpdate): void {
    if (!this.channel.destroyed && !this.abort.signal.aborted)
      this.channel.write(JSON.stringify({ type: 'worker-budget', update }) + '\n');
  }
  close(): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    this.onClosed();
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > 65536) {
        this.channel.destroy(new Error('worker服务队列超过容量'));
        return;
      }
      this.receiveFrame(line);
      if (this.channel.destroyed) return;
    }
    if (Buffer.byteLength(this.buffer) > 65536)
      this.channel.destroy(new Error('worker服务帧超过容量'));
  }
  private receiveFrame(line: string): void {
    const cancellation = workerCancellation(line);
    if (cancellation) {
      this.requests.get(cancellation)?.abort();
      return;
    }
    const request = parseWorkerRequest(line);
    if (!request || this.requests.has(request.id)) {
      this.channel.destroy(new Error('worker服务帧无效'));
      return;
    }
    if (this.requests.size >= 32) {
      this.channel.destroy(new Error('worker服务队列超过容量'));
      return;
    }
    this.enqueueRequest(request);
  }
  private enqueueRequest(request: WorkerServiceRequest & { id: string }): void {
    const controller = new AbortController();
    this.requests.set(request.id, controller);
    void this.send(request, AbortSignal.any([this.abort.signal, controller.signal]))
      .catch((error: unknown) => {
        this.options.logger.cause(error, 'worker-service-channel');
        this.channel.destroy();
      })
      .finally(() => {
        this.requests.delete(request.id);
      });
  }
  private async send(
    request: WorkerServiceRequest & { id: string },
    signal: AbortSignal
  ): Promise<void> {
    let value: unknown;
    try {
      value = await this.options.workerServices?.(request, signal);
    } catch (cause) {
      value = {
        ok: false,
        error: failure(
          signal.aborted ? 'CANCELLED' : 'UPSTREAM_FAILED',
          undefined,
          this.options.logger.cause(cause, 'worker-service')
        ),
      };
    }
    if (this.channel.destroyed || this.abort.signal.aborted) return;
    let line = JSON.stringify({ id: request.id, value }) + '\n';
    if (Buffer.byteLength(line) > 65536)
      line =
        JSON.stringify({
          id: request.id,
          value: { ok: false, error: failure('INVALID_INPUT', 'worker服务回执超过容量') },
        }) + '\n';
    await new Promise<void>((resolve, reject) => {
      this.channel.write(line, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
function parseWorkerRequest(line: string): (WorkerServiceRequest & { id: string }) | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.turn !== undefined && (!Number.isSafeInteger(value.turn) || Number(value.turn) < 1))
    return undefined;
  if (!workerIdentity(value)) return undefined;
  const payload = workerPayload(value);
  if (!payload) return undefined;
  return {
    id: value.id as string,
    sessionId: value.sessionId as string,
    executionId: value.executionId as string,
    runtimeGeneration: value.runtimeGeneration as string,
    action: value.action as WorkerServiceRequest['action'],
    turn: value.turn as number | undefined,
    ...payload,
  };
}
function workerCancellation(line: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('type' in value) ||
    value.type !== 'worker-cancel' ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    value.id.length > 128
  )
    return undefined;
  return value.id;
}
function workerIdentity(value: Record<string, unknown>): boolean {
  return (
    ['id', 'sessionId', 'executionId', 'runtimeGeneration'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 512
    ) &&
    typeof value.id === 'string' &&
    value.id.length <= 128
  );
}
function workerPayload(
  value: Record<string, unknown>
): Pick<WorkerServiceRequest, 'step' | 'url' | 'request'> | undefined {
  switch (value.action) {
    case 'authorize-step':
      return typeof value.step === 'number' && Number.isSafeInteger(value.step) && value.step > 0
        ? { step: value.step }
        : undefined;
    case 'authorize-fetch':
      return typeof value.url === 'string' ? { url: value.url } : undefined;
    case 'search': {
      const request = parseWorkerSearch(value.request);
      return request ? { request } : undefined;
    }
    default:
      return undefined;
  }
}
function parseWorkerSearch(request: unknown): WorkerServiceRequest['request'] {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    !('query' in request) ||
    typeof request.query !== 'string'
  )
    return undefined;
  if (
    'maxResults' in request &&
    request.maxResults !== undefined &&
    typeof request.maxResults !== 'number'
  )
    return undefined;
  return {
    query: request.query,
    maxResults: 'maxResults' in request ? (request.maxResults as number | undefined) : undefined,
  };
}
