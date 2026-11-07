import type { DeepReadonly } from '../readonly.js';
/**
 * 按调用方隔离键管理 DSH runtime 租约，带硬上限、LRU 和空闲回收。
 *
 * 为什么必须隔离进程：DSH 的 `initialize.cwd` 是进程级的，同进程内
 * 所有会话共用同一个 cwd（见 dsh-sdk-jsonrpc-server 的 `HarnessSdkJsonRpcServer.cwd`）。
 * 共用不同 Task 的工作区会导致文件串属。DshLaneRunner 使用 Session/lane/Task
 * 隔离键获取独占租约，生成唯一执行 sessionId，并在执行结束后销毁具体租约。
 *
 * 代价是进程数与内存随活跃会话数增长，因此需要：
 *   - `maxRuntimes` 上限，超出按 LRU 回收最久未使用的（回收前先优雅 shutdown）；
 *   - `runtimeIdleMs` 空闲回收（0 表示不回收）；
 *   - 处理"进程自己死了"的情况：下次取用自动重建。
 *
 * runtime 回收不恢复 DSH 历史；Task 输入由 PromptPreparer 固定上下文与回放。
 */
/**
 * 按调用方隔离键管理 DSH runtime 租约，带硬上限、LRU 和空闲回收。
 *
 * 为什么必须隔离进程：DSH 的 `initialize.cwd` 是进程级的，同进程内
 * 所有会话共用同一个 cwd（见 dsh-sdk-jsonrpc-server 的 `HarnessSdkJsonRpcServer.cwd`）。
 * 共用不同 Task 的工作区会导致文件串属。DshLaneRunner 使用 Session/lane/Task
 * 隔离键获取独占租约，生成唯一执行 sessionId，并在执行结束后销毁具体租约。
 *
 * 代价是进程数与内存随活跃会话数增长，因此需要：
 *   - `maxRuntimes` 上限，超出按 LRU 回收最久未使用的（回收前先优雅 shutdown）；
 *   - `runtimeIdleMs` 空闲回收（0 表示不回收）；
 *   - 处理"进程自己死了"的情况：下次取用自动重建。
 *
 * runtime 回收不恢复 DSH 历史；Task 输入由 PromptPreparer 固定上下文与回放。
 */
import type { EventEmitter } from 'node:events';
import type { Logger } from '../logger.js';
import type { DshRuntime, DshRuntimeEvents, DshRuntimeOptions } from './process.js';
import type {
  PromptContentBlock,
  SessionEventNotification,
  SessionPromptResult,
  SessionStatusNotification,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from './protocol.js';
/** 租约消费者只获得协议操作，不能启动、关闭或改写池内 runtime。 */
export interface RuntimeHandle {
  readonly isReady: boolean;
  readonly state: string;
  readonly pid: number | undefined;
  readonly lastErrorId: string | undefined;
  prompt(sessionId: string, blocks: PromptContentBlock[]): Promise<SessionPromptResult>;
  notifyTaskCooperation?(update: import('../task/cooperation.js').TaskCooperationUpdate): void;
  onTaskChannelClose?(listener: () => void): () => void;
  on<K extends keyof DshRuntimeEvents>(event: K, listener: DshRuntimeEvents[K]): void;
  off<K extends keyof DshRuntimeEvents>(event: K, listener: DshRuntimeEvents[K]): void;
}
/** 每次准入产生独立身份；相同进程上的旧租约不能释放新的占用。 */
export interface RuntimeLease {
  readonly leaseId: string;
  readonly generation: string;
  readonly conversationKey: string;
  readonly runtime: RuntimeHandle;
  readonly sessionId: string;
  readonly createdAt: number;
}
interface RuntimeLeaseSnapshotValue {
  readonly leaseId: string;
  readonly busy: boolean;
  readonly replayed: boolean;
  readonly lastUsedAt: number;
  readonly activeChildren: readonly string[];
}
export type RuntimeLeaseSnapshot = DeepReadonly<RuntimeLeaseSnapshotValue>;
export interface RuntimePoolOptions {
  maxRuntimes: number;
  runtimeIdleMs: number;
  /** new DshRuntime 用的模板（cwd 与 logger 由池按会话替换） */
  base: Omit<DshRuntimeOptions, 'cwd' | 'logger'>;
  logger: Logger;
  /** 注入时钟，便于单测 */
  now?: () => number;
  /** 注入 runtime 工厂，便于单测 */
  runtimeFactory?: (options: DshRuntimeOptions) => DshRuntime;
  /** sessionId 生成器，便于单测断言 */
  sessionIdFactory?: (conversationKey: string) => string;
  /** 运行代次和租约身份的确定性来源；生产默认 UUID。 */
  idFactory?: () => string;
}
export interface RuntimePoolEvents {
  'session.event': (conversationKey: string, notification: SessionEventNotification) => void;
  'session.status': (conversationKey: string, notification: SessionStatusNotification) => void;
  'subagent.started': (conversationKey: string, notification: SubagentStartedNotification) => void;
  'subagent.finished': (
    conversationKey: string,
    notification: SubagentFinishedNotification
  ) => void;
  'runtime.exit': (
    conversationKey: string,
    code: number | null,
    signal: NodeJS.Signals | null
  ) => void;
}
/**
 * 为一个会话生成稳定的 sessionId。
 *
 * 注意：进程重启后**不会**因为这个 id 相同而恢复上下文（见 docs/ARCHITECTURE.md 的「平台前提」）。
 * 用稳定 id 只是为了让 DSH 的会话日志目录可读、便于排查。
 *
 * 做字符净化：单聊的会话键形如 `c2c:<openid>`，冒号等字符可能出现在 DSH 的
 * 会话文件名里，统一替换为 `_` 以免踩到路径解析。
 */
export type stableSessionId = (conversationKey: string) => string;
export interface RuntimePool extends EventEmitter {
  get size(): number;
  /** 当前所有活跃会话的 key（用于 health 展示） */
  activeConversationKeys(): string[];
  /** 全部 runtime 内仍在运行的子代理总数（health 展示）。 */
  activeSubagents(): number;
  /** 只读非独占租约，用于最小协议检查；执行使用 acquireLease。 */
  acquire(
    conversationKey: string,
    workspacePath: string,
    overrides?: Partial<DshRuntimeOptions>,
    exclusive?: boolean,
    signal?: AbortSignal
  ): Promise<RuntimeLease>;
  acquireLease(
    conversationKey: string,
    workspacePath: string,
    overrides?: Partial<DshRuntimeOptions>,
    signal?: AbortSignal
  ): Promise<RuntimeLease>;
  /** 标记具体租约空闲并撤销其写入能力；重复或伪造身份无副作用。 */
  release(lease: RuntimeLease): void;
  /** 关闭具体租约；调用者不能用会话键误伤后续执行。 */
  drop(lease: RuntimeLease): Promise<void>;
  snapshot(lease: RuntimeLease): RuntimeLeaseSnapshot | undefined;
  /** 关闭所有 runtime。用于进程退出。 */
  disposeAll(): Promise<void>;
}
export type createRuntimePoolFactory = (options: RuntimePoolOptions) => RuntimePool;
