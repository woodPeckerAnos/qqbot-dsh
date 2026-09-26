/**
 * DSH SDK wire 协议客户端：stdio 上的 NDJSON JSON-RPC 2.0。
 *
 * 为什么自研而不是用官方 SDK 客户端：`@deepseek-ai/dsh-sdk-client` **未发布到
 * npm**。服务端协议本身很小（3 个方法 + 4 个通知），自研的收益是零内部包依赖，
 * 不会因为 DSH 内部包版本漂移而碎掉。
 *
 * 协议要点（依据 @deepseek-ai/dsh-sdk-protocol 的 lib/types/types.d.ts）：
 *   - 一行一个 JSON-RPC 消息；
 *   - 有 id 无 method = 响应；有 id 有 method = 请求；只有 method = 通知；
 *   - **stdout 只允许协议帧**，任何非 JSON 行都必须被当成错误而不是静默忽略，
 *     否则帧错位会导致后续请求永远等不到响应（这类 bug 极难排查）；
 *   - `session/prompt` 只返回入队回执 `{messageId}`，真正结果在 `session.event`。
 */

import { EventEmitter } from 'node:events';

/** 服务端身份，用于校验协议漂移 */
export const SDK_SERVER_INFO_NAME = 'deepseek-harness-sdk-runtime';

// ---------------------------------------------------------------------------
// wire 类型（与 dsh-sdk-protocol 的命名类型一一对应）
// ---------------------------------------------------------------------------

export interface InitializeParams {
  /** 会话的工作目录。**进程级**：同进程的所有会话共用这个 cwd。 */
  cwd: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

export interface InitializeResult {
  serverInfo: { name: string; version: string };
}

/**
 * 内联图片允许的 MIME 集合。
 *
 * 这就是 runtime 准入时接受的四种（见 @deepseek-ai/dsh-sdk-protocol 的
 * SdkEncodedImageBlock）：超出这个集合（例如 bmp/heic）不能内联，只能降级成文字说明。
 */
export type PromptImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/**
 * 提示内容块。
 *
 * image 块携带**原始栅格字节的 base64**，由 runtime 在准入时写入它自己的附件存储
 * （不需要我们先落盘）。这就是"多模态输入"的通道：文本块给出上下文与图片说明，
 * 图片块给出像素本身。
 */
export type PromptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: PromptImageMimeType };

export interface SessionPromptParams {
  sessionId: string;
  contentBlocks: PromptContentBlock[];
}

export interface SessionPromptResult {
  /** 已入队用户消息的 id；**不是**助手消息 id，也不是本轮结束信号 */
  messageId: string;
}

/** 会话日志事件的最小结构（我们只关心 type/seq/data，其余透传） */
export interface SessionEventEnvelope {
  type: string;
  seq: number;
  time?: number;
  data: Record<string, unknown>;
}

export interface SessionEventNotification {
  sessionId: string;
  event: SessionEventEnvelope;
}

export interface SessionStatusNotification {
  sessionId: string;
  status: 'idle' | 'running';
}

/** 协议方法名 → 载荷形状 */
export interface HarnessSdkRequestMap {
  initialize: { params: InitializeParams; result: InitializeResult };
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult };
  shutdown: { params: undefined; result: Record<string, never> };
}

export type HarnessSdkMethod = keyof HarnessSdkRequestMap;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcResponseError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`JSON-RPC ${code}: ${message}`);
    this.name = 'JsonRpcResponseError';
  }
}

/** stdout 出现非协议内容——属于致命错误，必须让上层看到 */
export class ProtocolViolationError extends Error {
  constructor(
    message: string,
    readonly rawLine: string,
  ) {
    super(message);
    this.name = 'ProtocolViolationError';
  }
}

// ---------------------------------------------------------------------------
// 事件类型（供上层订阅）
// ---------------------------------------------------------------------------

export interface HarnessSdkClientEvents {
  'session.event': (notification: SessionEventNotification) => void;
  'session.status': (notification: SessionStatusNotification) => void;
  'subagent.started': (payload: Record<string, unknown>) => void;
  'subagent.finished': (payload: Record<string, unknown>) => void;
  /** stdout 污染 / 无法解析的帧 */
  violation: (error: ProtocolViolationError) => void;
  /** 传输层收到无法归类的消息（未知通知），仅用于诊断 */
  unknown: (frame: unknown) => void;
  close: () => void;
}

export interface HarnessSdkClientOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** 单次请求超时（毫秒）。默认 30s；initialize 可能更久，由调用方覆盖。 */
  requestTimeoutMs?: number;
  /** 非协议 stdout 的处理策略：throw 会让流报错，collect 只记录事件 */
  onViolation?: 'throw' | 'collect';
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export class HarnessSdkClient {
  private readonly emitter = new EventEmitter();
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = '';
  private closed = false;

  constructor(private readonly options: HarnessSdkClientOptions) {
    options.input.setEncoding?.('utf8');
    options.input.on('data', this.onData);
    options.input.on('end', this.onEnd);
    options.input.on('error', this.onStreamError);
  }

  on<E extends keyof HarnessSdkClientEvents>(event: E, listener: HarnessSdkClientEvents[E]): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<E extends keyof HarnessSdkClientEvents>(event: E, listener: HarnessSdkClientEvents[E]): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 是否有在途请求（用于判断进程是否卡住） */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 发送一次请求。超时与错误响应都会 reject。 */
  request<M extends HarnessSdkMethod>(
    method: M,
    params: HarnessSdkRequestMap[M]['params'],
    options: { timeoutMs?: number } = {},
  ): Promise<HarnessSdkRequestMap[M]['result']> {
    if (this.closed) {
      return Promise.reject(new Error(`传输已关闭，无法发送 ${method}`));
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
    return new Promise<HarnessSdkRequestMap[M]['result']>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      });
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.write(`${frame}\n`);
    });
  }

  initialize(params: InitializeParams, options?: { timeoutMs?: number }): Promise<InitializeResult> {
    return this.request('initialize', params, options);
  }

  prompt(params: SessionPromptParams, options?: { timeoutMs?: number }): Promise<SessionPromptResult> {
    return this.request('session/prompt', params, options);
  }

  shutdown(options?: { timeoutMs?: number }): Promise<Record<string, never>> {
    return this.request('shutdown', undefined, options);
  }

  /** 关闭传输层监听（不销毁底层流，流的所有权在调用方） */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.input.off?.('data', this.onData);
    this.options.input.off?.('end', this.onEnd);
    this.options.input.off?.('error', this.onStreamError);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(`传输已关闭，请求 ${p.method} 未完成`));
    }
    this.emitter.emit('close');
    this.emitter.removeAllListeners();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private write(chunk: string): void {
    this.options.output.write(chunk);
  }

  private readonly onData = (chunk: string | Buffer): void => {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.handleLine(line);
    }
  };

  private readonly onEnd = (): void => {
    // 输入结束：所有在途请求都不可能再有响应。
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(`DSH runtime 的 stdout 已结束，请求 ${p.method} 未完成`));
    }
  };

  private readonly onStreamError = (error: Error): void => {
    this.reportViolation(new ProtocolViolationError(`stdout 流错误：${error.message}`, ''));
  };

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (line === '') return;

    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // 这条路径是"stdout 被污染"的现场。必须显式报错：静默忽略会让
      // 该帧对应的响应永久丢失，表现为莫名其妙的超时。
      this.reportViolation(
        new ProtocolViolationError(
          'DSH runtime 的 stdout 出现了非 JSON 内容（协议通道被污染）。' +
            '排查方向：profile 里是否插入了往 stdout 打日志的插件。',
          line,
        ),
      );
      return;
    }

    const hasId = frame['id'] !== undefined && frame['id'] !== null;
    const hasMethod = typeof frame['method'] === 'string';

    if (hasId && !hasMethod) {
      this.handleResponse(frame);
      return;
    }
    if (hasId && hasMethod) {
      // 服务端→客户端请求：当前协议里服务端从不发请求（死能力）。
      // 按协议应回 -32601，避免对端挂等。
      const id = frame['id'];
      const method = frame['method'] as string;
      this.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        })}\n`,
      );
      return;
    }
    if (hasMethod) {
      this.handleNotification(frame['method'] as string, frame['params']);
      return;
    }
    this.emitter.emit('unknown', frame);
  }

  private handleResponse(frame: Record<string, unknown>): void {
    const id = frame['id'] as number;
    const pending = this.pending.get(id);
    if (pending === undefined) {
      // 迟到的响应（例如已超时）——记录但不崩
      this.emitter.emit('unknown', frame);
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = frame['error'] as JsonRpcError | undefined;
    if (error !== undefined && error !== null) {
      pending.reject(new JsonRpcResponseError(error.code, error.message, error.data));
      return;
    }
    pending.resolve(frame['result']);
  }

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'session.event': {
        const payload = params as SessionEventNotification;
        this.emitter.emit('session.event', payload);
        return;
      }
      case 'session.status': {
        const payload = params as SessionStatusNotification;
        this.emitter.emit('session.status', payload);
        return;
      }
      case 'subagent.started': {
        this.emitter.emit('subagent.started', params as Record<string, unknown>);
        return;
      }
      case 'subagent.finished': {
        this.emitter.emit('subagent.finished', params as Record<string, unknown>);
        return;
      }
      default:
        this.emitter.emit('unknown', { method, params });
    }
  }

  private reportViolation(error: ProtocolViolationError): void {
    if (this.options.onViolation === 'throw') {
      throw error;
    }
    this.emitter.emit('violation', error);
  }
}
