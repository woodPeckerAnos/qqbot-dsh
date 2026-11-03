/**
 * 会话 → DSH 会话映射（群聊与单聊共用）。
 *
 * 这里有一个必须讲清楚的设计点：**每次 runtime 重建都会铸一个新的 sessionId**。
 *
 * 原因是实测得到的结论（见 docs/ARCHITECTURE.md 的「平台前提」）：DSH 的 `session/prompt` 没有
 * resume 语义，复用旧 sessionId 不会恢复历史，反而会让 DSH 的持久化把新会话
 * 追加到旧日志上，产生"看着是同一个会话、实际没有上下文"的误导状态。
 *
 * 所以：
 *   - `logicalId`：会话的稳定标识（= conversationHash(key)），用于日志与排障；
 *   - `currentSessionId` + `generation`：当前 runtime 使用的 DSH 会话，
 *     每次重建递增 generation 并换新 id。
 *
 * 历史上下文由对话记录回放提供（store/conversations.ts），与 sessionId 无关。
 * 将来 DSH 若开放 resume，只需把 `newSessionId` 换成"复用旧的 + 调 resume"。
 */
/**
 * 会话 → DSH 会话映射（群聊与单聊共用）。
 *
 * 这里有一个必须讲清楚的设计点：**每次 runtime 重建都会铸一个新的 sessionId**。
 *
 * 原因是实测得到的结论（见 docs/ARCHITECTURE.md 的「平台前提」）：DSH 的 `session/prompt` 没有
 * resume 语义，复用旧 sessionId 不会恢复历史，反而会让 DSH 的持久化把新会话
 * 追加到旧日志上，产生"看着是同一个会话、实际没有上下文"的误导状态。
 *
 * 所以：
 *   - `logicalId`：会话的稳定标识（= conversationHash(key)），用于日志与排障；
 *   - `currentSessionId` + `generation`：当前 runtime 使用的 DSH 会话，
 *     每次重建递增 generation 并换新 id。
 *
 * 历史上下文由对话记录回放提供（store/conversations.ts），与 sessionId 无关。
 * 将来 DSH 若开放 resume，只需把 `newSessionId` 换成"复用旧的 + 调 resume"。
 */
import type { ContractFailure, DeepReadonly } from '@qqbot/contracts';
import type { Logger } from '../logger.js';
import type { StorePaths } from './paths.js';
export interface ConversationSessionRecord {
  /** 会话键（群 = group_openid；单聊 = `c2c:<user_openid>`） */
  conversationKey: string;
  /** 稳定标识（= conversationHash），永远不变 */
  logicalId: string;
  /** 当前 DSH 会话 id；每次 runtime 重建都会更新 */
  currentSessionId: string;
  /** 当前 runtime 是第几次创建（1 开始） */
  generation: number;
  createdAt: number;
  updatedAt: number;
}
export interface SessionStoreOptions {
  paths: StorePaths;
  logger: Logger;
  now?: () => number;
  sessionIdFactory?: (conversationKey: string, generation: number) => string;
  /** 注入原子写能力；成功返回后才提交 generation，不属于行为配置。 */
  persistSession?: (file: string, text: string) => void;
}
export class SessionPersistenceError extends Error {
  readonly code = 'PERSISTENCE_FAILED';
  readonly retry = 'safe';
  readonly error: ContractFailure;
  constructor(cause: unknown) {
    super('会话映射持久化失败', { cause });
    this.error = failure('PERSISTENCE_FAILED', cause);
  }
}
export type createSessionPersistenceErrorFactory = (cause: unknown) => SessionPersistenceError;
export interface SessionStore {
  /**
   * 取该会话当前会话记录；若不存在或 `rotate` 为真则铸新会话。
   *
   * @param rotate 是否强制开新会话（runtime 重建时传 true）
   */
  ensure(conversationKey: string, rotate?: boolean): DeepReadonly<ConversationSessionRecord>;
  /** 只读查询（不创建）。 */
  peek(conversationKey: string): DeepReadonly<ConversationSessionRecord> | undefined;
  /** 全部记录（health / 诊断用） */
  all(): DeepReadonly<ConversationSessionRecord[]>;
}
export type createSessionStoreFactory = (options: SessionStoreOptions) => SessionStore;

import { failure } from '../errors.js';
