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

import type { Logger } from '../logger.js';
import {
  HarnessSdkClient,
  SDK_SERVER_INFO_NAME,
  type InitializeResult,
  type ProtocolViolationError,
  type SessionEventNotification,
  type SessionPromptResult,
  type SessionStatusNotification,
} from './protocol.js';

export interface DshRuntimeOptions {
  /** dsh 可执行文件（默认 "dsh"，从 PATH 解析） */
  bin: string;
  /** profile patch 的绝对路径 */
  profilePatch: string;
  /** 该 runtime 的会话工作目录（= 某个群的工作区） */
  cwd: string;
  /** DSH_HOME 环境变量值 */
  dshHome: string;
  provider: string;
  model: string;
  requestTimeoutMs?: number;
  /** initialize 的等待超时（进程冷启动 + profile 组合，可能较慢） */
  startTimeoutMs: number;
  /** shutdown 发出后等待进程退出的时间 */
  shutdownTimeoutMs: number;
  logger: Logger;
  /** 测试注入用：替换 spawn */
  spawnImpl?: typeof spawn;
  /** 附加环境变量（测试与代理场景） */
  env?: Record<string, string | undefined>;
}

export interface DshRuntimeEvents {
  'session.event': (notification: SessionEventNotification) => void;
  'session.status': (notification: SessionStatusNotification) => void;
  violation: (error: ProtocolViolationError) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export type DshRuntimeState = 'starting' | 'ready' | 'closing' | 'closed' | 'failed';

export class DshRuntime extends EventEmitter {
  private client: HarnessSdkClient | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private _state: DshRuntimeState = 'starting';
  private _serverInfo: InitializeResult['serverInfo'] | undefined;
  private stderrTail: string[] = [];
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

  static buildArgs(options: Pick<DshRuntimeOptions, 'profilePatch'>): string[] {
    return ['--profile', 'sdk', '--patch', options.profilePatch];
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
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.child = child;

    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    child.on('error', (error) => {
      options.logger.error('DSH runtime 进程启动失败', { error: error.message, cwd: options.cwd });
      this._state = 'failed';
      this.resolveExit?.();
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 80) this.stderrTail.shift();
        // DSH 的诊断输出走 stderr，降到 debug 避免刷屏，但保留在 tail 里供报错
        options.logger.debug('dsh stderr', { line });
      }
    });

    child.on('exit', (code, signal) => {
      const wasReady = this._state === 'ready';
      if (this._state !== 'closing') {
        this._state = code === 0 ? 'closed' : 'failed';
        if (wasReady || code !== 0) {
          options.logger.warn('DSH runtime 进程退出', { code, signal, cwd: options.cwd });
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
    client.on('violation', (error) => {
      options.logger.error('DSH 协议通道被污染', { raw: error.rawLine.slice(0, 200) });
      this.emit('violation', error);
    });

    try {
      const result = await client.initialize(
        { cwd: options.cwd, provider: options.provider, model: options.model },
        { timeoutMs: options.startTimeoutMs },
      );
      // 协议漂移检测：服务端身份是 wire-stable 的，变了说明协议不兼容。
      if (result?.serverInfo?.name !== SDK_SERVER_INFO_NAME) {
        throw new Error(
          `initialize 返回了意外的服务端身份 ${JSON.stringify(result?.serverInfo)}，` +
            `预期 name=${SDK_SERVER_INFO_NAME}。DSH 版本可能不兼容。`,
        );
      }
      this._serverInfo = result.serverInfo;
      this._state = 'ready';
      options.logger.debug('DSH runtime 就绪', {
        serverInfo: result.serverInfo,
        pid: child.pid,
      });
      return result;
    } catch (error) {
      const detail = this.stderrTail.slice(-15).join('\n');
      await this.dispose().catch(() => {});
      throw new Error(
        `DSH runtime initialize 失败：${error instanceof Error ? error.message : String(error)}` +
          (detail ? `\n--- dsh stderr 末 15 行 ---\n${detail}` : ''),
        { cause: error },
      );
    }
  }

  /** 派发一次提示。返回入队回执；结果通过 session.event 流出。 */
  async prompt(sessionId: string, text: string): Promise<SessionPromptResult> {
    if (this._state !== 'ready' || this.client === undefined) {
      throw new Error(`runtime 状态为 ${this._state}，不能 prompt()（需要 ready）`);
    }
    return this.client.prompt({
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    });
  }

  /** 是否已就绪且可接受新提示 */
  get isReady(): boolean {
    return this._state === 'ready' && this.client !== undefined && !this.client.isClosed;
  }

  /**
   * 优雅关闭：shutdown → 等待退出 → SIGTERM → 等待 → SIGKILL。
   * 可重复调用。
   */
  async dispose(): Promise<void> {
    if (this._state === 'closed' && this.child?.exitCode !== null) return;
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
      try {
        await client.shutdown({ timeoutMs: shutdownTimeoutMs });
      } catch (error) {
        logger.debug('shutdown 请求未成功，转入信号关闭', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    client?.close();

    if (child === undefined || child.exitCode !== null) {
      this._state = 'closed';
      return;
    }

    await this.waitForExit(shutdownTimeoutMs);
    if (child.exitCode === null) {
      logger.warn('DSH runtime 未在超时内退出，发送 SIGTERM', { pid: child.pid });
      child.kill('SIGTERM');
      await this.waitForExit(shutdownTimeoutMs);
    }
    if (child.exitCode === null) {
      logger.error('DSH runtime 忽略 SIGTERM，发送 SIGKILL', { pid: child.pid });
      child.kill('SIGKILL');
      await this.waitForExit(5_000);
    }
    this._state = 'closed';
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) return Promise.resolve();
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
