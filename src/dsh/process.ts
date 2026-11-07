import type { DshRuntimeOptions, DshRuntimeState } from '@qqbot/contracts';
/**
 * DSH runtime 子进程监督。
 *
 * 一个 `DshRuntime` = 一个 `dsh --profile sdk --patch <patch>` 进程 + 其 stdio
 * 协议连接。生命周期：
 *
 *   spawn → initialize（进程级 cwd 在此固定）→ 可反复 prompt → shutdown
 *
 * 关闭顺序刻意做成三档（shutdown → SIGTERM → SIGKILL）：直接 SIGKILL 会让 DSH
 * 的 JSONL 会话日志留下半条记录，而那个日志是我们排查问题的主要依据。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

import { LoggedError } from '@qqbot/contracts';

import { HarnessSdkClient } from './protocol.js';
import { SDK_SERVER_INFO_NAME } from '@qqbot/contracts';
import type { InitializeResult, PromptContentBlock, SessionPromptResult } from '@qqbot/contracts';
import { ExecutionChannel } from './execution-channel.js';
import type { ExecutionBinding, ExecutionHandlers, ExecutionAck } from '@qqbot/contracts';

export type { DshRuntimeOptions } from '@qqbot/contracts';

export type { DshRuntimeEvents } from '@qqbot/contracts';

export type { DshRuntimeState } from '@qqbot/contracts';

export class DshRuntime extends EventEmitter {
  private client: HarnessSdkClient | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private taskChannel?: ExecutionChannel;
  private _state: DshRuntimeState = 'starting';
  private _serverInfo: InitializeResult['serverInfo'] | undefined;
  private stderrTail: string[] = [];
  private errorId?: string;
  get lastErrorId(): string | undefined {
    return this.errorId;
  }
  private exitPromise: Promise<void> | undefined;
  private resolveExit: (() => void) | undefined;

  constructor(private readonly options: DshRuntimeOptions) {
    super();
  }

  get state(): DshRuntimeState {
    return this._state;
  }

  get serverInfo(): InitializeResult['serverInfo'] | undefined {
    return this._serverInfo;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** 最近若干行 stderr，用于错误信息里带上真正的原因（例如 cordis 加载失败） */
  get recentStderr(): readonly string[] {
    return this.stderrTail;
  }

  static buildArgs(options: Pick<DshRuntimeOptions, 'profilePatch' | 'patches'>): string[] {
    const args = ['--profile', 'sdk', '--patch', options.profilePatch];
    for (const patch of options.patches ?? []) {
      args.push('--patch', patch);
    }
    return args;
  }

  /** 启动进程并完成 initialize 握手。失败时自动清理进程。 */
  async start(): Promise<InitializeResult> {
    if (this._state !== 'starting') {
      throw new Error(`runtime 状态为 ${this._state}，不能再次 start()`);
    }
    const { options } = this;
    const spawnImpl = options.spawnImpl ?? spawn;

    const child = spawnImpl(options.bin, DshRuntime.buildArgs(options), {
      cwd: options.cwd,
      env: {
        ...process.env,
        DSH_HOME: options.dshHome,
        ...options.env,
      },
      stdio:
        options.taskControl || options.taskCooperation || options.env?.QQBOT_TASK_CHANNEL
          ? ['pipe', 'pipe', 'pipe', 'pipe']
          : ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;
    options.logger.event('runtime.started', { pid: child.pid });
    if (options.taskControl || options.taskCooperation || options.env?.QQBOT_TASK_CHANNEL) {
      this.taskChannel = new ExecutionChannel(child.stdio[3] as Duplex, options, () => {
        this.emit('task.channel.closed');
      });
    }

    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    child.on('error', (error) => {
      this.errorId = options.logger.cause(error, 'runtime-spawn');
      this._state = 'failed';
      this.resolveExit?.();
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue;
        this.stderrTail.push(line.slice(0, 1024));
        if (this.stderrTail.length > 80) this.stderrTail.shift();
        // DSH 的诊断输出走 stderr，降到 debug 避免刷屏，但保留在 tail 里供报错
        options.logger.event('runtime.stderr', { bytes: Buffer.byteLength(line), lines: 1 });
      }
    });

    child.on('exit', (code, signal) => {
      const wasReady = this._state === 'ready';
      if (this._state !== 'closing') {
        this._state = code === 0 ? 'closed' : 'failed';
        if (wasReady || code !== 0) {
          this.errorId ??= options.logger.cause(new Error('runtime-exit'), 'runtime-exit', {
            code,
            signal,
          });
        }
      } else {
        this._state = 'closed';
      }
      this.emit('exit', code, signal);
      this.resolveExit?.();
    });

    const client = new HarnessSdkClient({
      input: child.stdout,
      output: child.stdin,
      requestTimeoutMs: options.requestTimeoutMs,
      onViolation: 'collect',
    });
    this.client = client;

    client.on('session.event', (n) => this.emit('session.event', n));
    client.on('session.status', (n) => this.emit('session.status', n));
    client.on('subagent.started', (n) => this.emit('subagent.started', n));
    client.on('subagent.finished', (n) => this.emit('subagent.finished', n));
    client.on('invalid', (reason) => {
      options.logger.event('runtime.notification', { reason: 'invalid' });
      this.emit('invalid', reason);
    });
    client.on('unknown', () => {
      options.logger.event('runtime.notification', { reason: 'unknown' });
      this.emit('unknown');
    });
    client.on('violation', (error) => {
      this.errorId ??= options.logger.cause(error, 'protocol-violation', {
        bytes: Buffer.byteLength(error.rawLine),
      });
      this.emit('violation', error);
    });

    try {
      const result = await client.initialize(
        {
          cwd: options.cwd,
          provider: options.provider,
          model: options.model,
          ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        },
        { timeoutMs: options.startTimeoutMs }
      );
      // 协议漂移检测：服务端身份是 wire-stable 的，变了说明协议不兼容。
      if (result?.serverInfo?.name !== SDK_SERVER_INFO_NAME) {
        throw new Error(
          `initialize 返回了意外的服务端身份 ${JSON.stringify(result?.serverInfo)}，` +
            `预期 name=${SDK_SERVER_INFO_NAME}。DSH 版本可能不兼容。`
        );
      }
      this._serverInfo = result.serverInfo;
      this._state = 'ready';
      options.logger.event('runtime.ready', { version: result.serverInfo.version, pid: child.pid });
      return result;
    } catch (error) {
      this.errorId ??= options.logger.cause(error, 'runtime-initialize');
      await this.dispose().catch(() => {});
      throw new LoggedError(
        this.errorId,
        `DSH runtime initialize 失败（errorId=${this.errorId}）`,
        { cause: error }
      );
    }
  }

  notifyTaskCooperation(update: import('@qqbot/contracts').TaskCooperationUpdate): void {
    this.taskChannel?.push(update);
  }
  bindExecution(binding: ExecutionBinding, handlers: ExecutionHandlers): Promise<ExecutionAck> {
    return this.channel().bind(binding, handlers);
  }
  unbindExecution(binding: ExecutionBinding): Promise<ExecutionAck> {
    return this.channel().unbind(binding);
  }
  cancelExecution(binding: ExecutionBinding): Promise<ExecutionAck> {
    return this.channel().cancel(binding);
  }
  quiesceExecution(binding: ExecutionBinding): Promise<ExecutionAck> {
    return this.channel().quiesce(binding);
  }
  private channel(): ExecutionChannel {
    if (!this.taskChannel) throw new Error('执行绑定通道不可用');
    return this.taskChannel;
  }
  onTaskChannelClose(listener: () => void): () => void {
    this.on('task.channel.closed', listener);
    return () => {
      this.off('task.channel.closed', listener);
    };
  }

  /**
   * 派发一次提示。返回入队回执；结果通过 session.event 流出。
   *
   * `blocks` 允许 text + image 混排（多模态输入）。图片字节在 dsh/media.ts 里
   * 已经过 MIME 嗅探与大小裁剪，这里只负责原样透传。
   */
  async prompt(sessionId: string, blocks: PromptContentBlock[]): Promise<SessionPromptResult> {
    if (this._state !== 'ready' || this.client === undefined) {
      throw new Error(`runtime 状态为 ${this._state}，不能 prompt()（需要 ready）`);
    }
    return this.client.prompt({ sessionId, contentBlocks: blocks });
  }

  /** 是否已就绪且可接受新提示 */
  get isReady(): boolean {
    return this._state === 'ready' && this.client !== undefined && !this.client.isClosed;
  }

  /**
   * 就绪后优雅关闭：shutdown → 等待退出 → SIGTERM → 等待 → SIGKILL。
   * 未就绪进程直接 SIGTERM，保留信号退出宽限与 SIGKILL 兜底。
   * 可重复调用。
   */
  async dispose(): Promise<void> {
    this.taskChannel?.dispose();
    if (this._state === 'closed') return;
    if (this._state === 'closing') {
      await this.exitPromise;
      return;
    }
    const wasReady = this._state === 'ready';
    this._state = 'closing';
    const client = this.client;
    const child = this.child;
    const { shutdownTimeoutMs, logger } = this.options;

    if (client !== undefined && wasReady) {
      await this.requestShutdown(client);
    }
    client?.close();

    if (child === undefined || this.hasExited()) {
      this._state = 'closed';
      return;
    }

    if (wasReady) await this.waitForExit(shutdownTimeoutMs);
    if (!this.hasExited()) {
      if (wasReady) logger.warn('DSH runtime 未在超时内退出，发送 SIGTERM', { pid: child.pid });
      else logger.debug('DSH runtime 未就绪，发送 SIGTERM', { pid: child.pid });
      child.kill('SIGTERM');
      await this.waitForExit(shutdownTimeoutMs);
    }
    if (!this.hasExited()) {
      logger.error('DSH runtime 忽略 SIGTERM，发送 SIGKILL', { pid: child.pid });
      child.kill('SIGKILL');
      await this.waitForExit(5_000);
    }
    this._state = 'closed';
  }

  private async requestShutdown(client: HarnessSdkClient): Promise<void> {
    try {
      await client.shutdown({ timeoutMs: this.options.shutdownTimeoutMs });
    } catch (error) {
      this.options.logger.debug('shutdown 请求未成功，转入信号关闭', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 信号退出的 exitCode 仍为 null；每次调用都重新读取子进程状态。 */
  private hasExited(): boolean {
    const child = this.child;
    return child === undefined || child.exitCode !== null || child.signalCode != null;
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.hasExited()) return Promise.resolve();
    const exit = this.exitPromise ?? Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      void exit.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
