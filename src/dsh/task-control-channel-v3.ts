import { failure } from '@qqbot/contracts';
import type { DshRuntimeOptions, WorkerAssignment } from '@qqbot/contracts';
import type { Duplex } from 'node:stream';

type ControlRequest = Parameters<NonNullable<DshRuntimeOptions['taskControl']>>[0] & { id: string };
const MAX_FRAME_BYTES = 65536;
const MAX_PENDING_REQUESTS = 32;

/** fd 3 只承载前台控制；按模型顺序执行，接受派发后拒绝后续请求。 */
export class TaskControlQueueV3 {
  private buffer = '';
  private tail: Promise<void> = Promise.resolve();
  private dispatched = false;
  private queuedBytes = 0;
  private queuedFrames = 0;
  constructor(
    private readonly channel: Duplex,
    private readonly options: DshRuntimeOptions,
    private readonly onClosed: () => void
  ) {
    channel.setEncoding('utf8');
    channel.on('data', (chunk: string) => {
      this.receive(chunk);
    });
    channel.on('close', onClosed);
    channel.on('error', (error) => {
      options.logger.cause(error, 'task-control-channel');
      onClosed();
    });
  }
  private receive(chunk: string): void {
    if (this.channel.destroyed) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.queuedBytes += Buffer.byteLength(line);
      this.queuedFrames++;
      if (this.queuedBytes > MAX_FRAME_BYTES * 2 || this.queuedFrames > MAX_PENDING_REQUESTS) {
        this.channel.destroy(new Error('控制队列超过容量'));
        return;
      }
      this.tail = this.tail
        .then(async () => {
          try {
            await this.sendResult(line);
          } finally {
            this.queuedBytes -= Buffer.byteLength(line);
            this.queuedFrames--;
          }
        })
        .catch((error: unknown) => {
          this.options.logger.cause(error, 'task-control-channel');
          this.channel.destroy();
        });
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES)
      this.channel.destroy(new Error('控制帧超过容量'));
  }
  private async sendResult(line: string): Promise<void> {
    if (this.channel.destroyed) return;
    const request = parseRequest(line);
    if (!request) {
      this.channel.destroy(new Error('控制帧无效'));
      return;
    }
    const value = this.dispatched
      ? { ok: false, error: failure('CONFLICT') }
      : await this.options.taskControl?.(request);
    if (request.action === 'start-worker' && isRecord(value) && value.ok === true)
      this.dispatched = true;
    let response = JSON.stringify({ id: request.id, value }) + '\n';
    if (Buffer.byteLength(response) > MAX_FRAME_BYTES)
      response =
        JSON.stringify({
          id: request.id,
          value: { ok: false, error: failure('INVALID_INPUT', '控制回执超过容量') },
        }) + '\n';
    await new Promise<void>((resolve, reject) => {
      this.channel.write(response, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

function parseRequest(line: string): ControlRequest | undefined {
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (!isControlFrame(value)) return;
  if (value.taskId !== undefined && typeof value.taskId !== 'string') return;
  const assignment = value.assignment === undefined ? undefined : parseAssignment(value.assignment);
  if (value.assignment !== undefined && !assignment) return;
  return {
    id: value.id,
    action: value.action,
    taskId: value.taskId,
    sessionId: value.sessionId,
    executionId: value.executionId,
    runtimeGeneration: value.runtimeGeneration,
    assignment,
  };
}

function isControlFrame(value: unknown): value is Record<string, unknown> & {
  id: string;
  action: string;
  sessionId: string;
  executionId: string;
  runtimeGeneration: string;
} {
  return (
    isRecord(value) &&
    ['id', 'action', 'sessionId', 'executionId', 'runtimeGeneration'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0
    )
  );
}

function parseAssignment(value: unknown): WorkerAssignment | undefined {
  if (
    !isRecord(value) ||
    typeof value.instruction !== 'string' ||
    !value.instruction.trim() ||
    !Array.isArray(value.deliverables) ||
    !value.deliverables.every((item: unknown) => typeof item === 'string' && item.trim().length > 0)
  )
    return;
  if (value.acknowledgement !== undefined && typeof value.acknowledgement !== 'string') return;
  return {
    instruction: value.instruction,
    deliverables: value.deliverables as string[],
    acknowledgement: value.acknowledgement,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
