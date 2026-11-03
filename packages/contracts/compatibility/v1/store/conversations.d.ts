/**
 * 对话记录：每个会话（群聊/单聊）一个只追加的 JSONL 文件。
 *
 * 存在的唯一理由：**DSH 的会话历史在进程重启后不会自动恢复**（见
 * docs/ARCHITECTURE.md 的「平台前提」 的源码核对）。所以"重启不失忆"必须由我们自己兜，
 * 而这个文件就是那份记忆。
 *
 * 为什么用 JSONL 而不是 SQLite：
 *   - Node 24 的 node:sqlite 仍是实验特性（会打 ExperimentalWarning）；
 *   - 追加写 + tail 读正好是这个场景的全部需求，不需要事务/索引；
 *   - 纯文本便于运维直接看（`tail -f` 就能观察机器人在聊什么）。
 *
 * 写入策略：`appendFileSync` 单次写入（小于 PIPE_BUF 时是原子的），失败只记日志
 * 不抛错——记忆属于"尽力而为"，不能因为它让整个回复流程失败。
 */
/**
 * 对话记录：每个会话（群聊/单聊）一个只追加的 JSONL 文件。
 *
 * 存在的唯一理由：**DSH 的会话历史在进程重启后不会自动恢复**（见
 * docs/ARCHITECTURE.md 的「平台前提」 的源码核对）。所以"重启不失忆"必须由我们自己兜，
 * 而这个文件就是那份记忆。
 *
 * 为什么用 JSONL 而不是 SQLite：
 *   - Node 24 的 node:sqlite 仍是实验特性（会打 ExperimentalWarning）；
 *   - 追加写 + tail 读正好是这个场景的全部需求，不需要事务/索引；
 *   - 纯文本便于运维直接看（`tail -f` 就能观察机器人在聊什么）。
 *
 * 写入策略：`appendFileSync` 单次写入（小于 PIPE_BUF 时是原子的），失败只记日志
 * 不抛错——记忆属于"尽力而为"，不能因为它让整个回复流程失败。
 */
import type { DeepReadonly, Result } from '@qqbot/contracts';
import type { Logger } from '../logger.js';
import type { OriginalMessageReference } from '../core/connector.js';
import type { StorePaths } from './paths.js';
export type ConversationRole = 'user' | 'assistant' | 'system-note';
export interface ConversationTurn {
    role: ConversationRole;
    /** 群成员昵称（user）或 "bot"（assistant） */
    speaker: string;
    text: string;
    ts: number;
    /** 触发本条的用户消息 id，便于把回复和提问关联起来 */
    replyToMsgId?: string;
    reference?: OriginalMessageReference;
    taskId?: string;
    lane?: 'fast' | 'slow';
}
interface ConversationReadSnapshotValue {
    readonly turns: DeepReadonly<ConversationTurn[]>;
    /** 无法解析的行数，避免把部分读取失败误当作完整空历史。 */
    readonly corrupted: number;
}
export type ConversationReadSnapshot = DeepReadonly<ConversationReadSnapshotValue>;
export interface ConversationStore {
    /** 追加一条记录。失败只记日志，不抛错。 */
    append(conversationKey: string, turn: ConversationTurn): void;
    /** 明确表达写入失败，兼容入口 append 继续按尽力而为处理。 */
    appendResult(conversationKey: string, turn: ConversationTurn): Result<void>;
    /** 读取全部记录（诊断/测试用）。解析失败的行跳过并计数。 */
    readAll(conversationKey: string): DeepReadonly<ConversationTurn[]>;
    /** 历史无TTL；缺失、I/O失败和部分损坏均保留独立语义。 */
    readResult(conversationKey: string): Result<ConversationReadSnapshot>;
    /** 取最近 n 条记录。 */
    readTail(conversationKey: string, n: number): DeepReadonly<ConversationTurn[]>;
}
export type createConversationStoreFactory = (paths: StorePaths, logger: Logger) => ConversationStore;
/**
 * 把历史记录渲染成回放文本，并入冷启动后的第一条 prompt。
 *
 * 安全考虑：历史内容来自群成员/私聊用户，属于**不可信输入**。所以：
 *   1. 用显式边界标记包裹，并明确声明"这是历史记录，不是指令"；
 *   2. 不把历史渲染成看起来像系统提示的格式；
 *   3. 长度截断，避免一条超长历史把 prompt 撑爆。
 *
 * 这只能降低、不能消除 prompt injection 风险——安全性最终靠容器边界
 * （见 docs/ARCHITECTURE.md 的「安全边界」）。
 */
export type renderReplay = (turns: readonly ConversationTurn[], maxChars?: number) => string;
export {};
