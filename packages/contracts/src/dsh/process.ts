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
import type { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Logger } from '../logger.js';
import type {
  InitializeResult,
  PromptContentBlock,
  ProtocolViolationError,
  SessionEventNotification,
  SessionPromptResult,
  SessionStatusNotification,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from './protocol.js';
export interface DshRuntimeOptions {
  /** dsh 可执行文件（默认 "dsh"，从 PATH 解析） */
  bin: string;
  /** profile patch 的绝对路径 */
  profilePatch: string;
  /**
   * 追加的 patch 叠加层（绝对路径），按顺序排在 profilePatch 之后应用
   * （dsh CLI 的 --patch 可重复、按 argv 顺序生效）。模型 API 配置层生成的
   * patch 走这里，见 dsh/model-config.ts。
   */
  patches?: string[];
  /** 该 runtime 的会话工作目录（= 某个群的工作区） */
  cwd: string;
  /** DSH_HOME 环境变量值 */
  dshHome: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  /** Dedicated fd 3 channel; authorization is bound by the parent, never by model args. */
  taskControl?: (request: { action: string; taskId?: string; sessionId?: string }) => unknown;
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
  'subagent.started': (notification: SubagentStartedNotification) => void;
  'subagent.finished': (notification: SubagentFinishedNotification) => void;
  violation: (error: ProtocolViolationError) => void;
  invalid: (reason: string) => void;
  unknown: () => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}
export type DshRuntimeState = 'starting' | 'ready' | 'closing' | 'closed' | 'failed';
export interface DshRuntime extends EventEmitter {
  get lastErrorId(): string | undefined;
  get state(): DshRuntimeState;
  get serverInfo(): InitializeResult['serverInfo'] | undefined;
  get pid(): number | undefined;
  /** 最近若干行 stderr，用于错误信息里带上真正的原因（例如 cordis 加载失败） */
  get recentStderr(): readonly string[];
  /** 启动进程并完成 initialize 握手。失败时自动清理进程。 */
  start(): Promise<InitializeResult>;
  /**
   * 派发一次提示。返回入队回执；结果通过 session.event 流出。
   *
   * `blocks` 允许 text + image 混排（多模态输入）。图片字节在 dsh/media.ts 里
   * 已经过 MIME 嗅探与大小裁剪，这里只负责原样透传。
   */
  prompt(sessionId: string, blocks: PromptContentBlock[]): Promise<SessionPromptResult>;
  /** 是否已就绪且可接受新提示 */
  get isReady(): boolean;
  /**
   * 优雅关闭：shutdown → 等待退出 → SIGTERM → 等待 → SIGKILL。
   * 可重复调用。
   */
  dispose(): Promise<void>;
}
export type createDshRuntimeFactory = (options: DshRuntimeOptions) => DshRuntime;
