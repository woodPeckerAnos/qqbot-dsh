/**
 * 会话 → DSH 会话映射（群聊与单聊共用）。
 *
 * 这里有一个必须讲清楚的设计点：**每次 runtime 重建都会铸一个新的 sessionId**。
 *
 * 原因是实测得到的结论（见 docs/DESIGN.md 2.3）：DSH 的 `session/prompt` 没有
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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Logger } from '../logger.js';
import { conversationHash, type StorePaths } from './paths.js';

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

interface SessionsFileShape {
  version: 1;
  sessions: Record<string, ConversationSessionRecord>;
}

/** 磁盘上可能出现的记录形状：早期版本用 `groupOpenid` 命名会话键。 */
interface StoredSessionRecord extends Partial<ConversationSessionRecord> {
  groupOpenid?: string;
}

export interface SessionStoreOptions {
  paths: StorePaths;
  logger: Logger;
  now?: () => number;
  sessionIdFactory?: (conversationKey: string, generation: number) => string;
}

export class SessionStore {
  private readonly sessions = new Map<string, ConversationSessionRecord>();
  private readonly now: () => number;
  private readonly sessionIdFactory: (conversationKey: string, generation: number) => string;

  constructor(private readonly options: SessionStoreOptions) {
    this.now = options.now ?? Date.now;
    this.sessionIdFactory =
      options.sessionIdFactory ??
      ((conversationKey, generation) =>
        `qq-${conversationHash(conversationKey)}-g${generation}-${randomUUID().slice(0, 8)}`);
    this.load();
  }

  /**
   * 取该会话当前会话记录；若不存在或 `rotate` 为真则铸新会话。
   *
   * @param rotate 是否强制开新会话（runtime 重建时传 true）
   */
  ensure(conversationKey: string, rotate = false): ConversationSessionRecord {
    const existing = this.sessions.get(conversationKey);
    if (existing !== undefined && !rotate) return existing;

    const generation = (existing?.generation ?? 0) + 1;
    const at = this.now();
    const record: ConversationSessionRecord = {
      conversationKey,
      logicalId: conversationHash(conversationKey),
      currentSessionId: this.sessionIdFactory(conversationKey, generation),
      generation,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    this.sessions.set(conversationKey, record);
    this.persist();
    this.options.logger.info(
      existing === undefined ? '为会话创建 DSH 会话' : '为会话轮换 DSH 会话（runtime 重建）',
      { conversation: record.logicalId, generation, sessionId: record.currentSessionId },
    );
    return record;
  }

  /** 只读查询（不创建）。 */
  peek(conversationKey: string): ConversationSessionRecord | undefined {
    return this.sessions.get(conversationKey);
  }

  /** 全部记录（health / 诊断用） */
  all(): ConversationSessionRecord[] {
    return [...this.sessions.values()];
  }

  private load(): void {
    const file = this.options.paths.sessionsFile;
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        version?: number;
        sessions?: Record<string, StoredSessionRecord>;
        /** v0：早期只有群聊时的字段名 */
        groups?: Record<string, StoredSessionRecord>;
      };
      // 兼容旧文件：早期只有群聊，字段名是 groups + groupOpenid。
      if (parsed.version !== undefined && parsed.version !== 1) {
        this.options.logger.warn('sessions.json 版本不认识，忽略并重建', {
          version: parsed.version,
        });
        return;
      }
      const source = parsed.sessions ?? parsed.groups;
      if (source === undefined) {
        this.options.logger.warn('sessions.json 结构不认识，忽略并重建');
        return;
      }
      for (const [key, raw] of Object.entries(source)) {
        if (raw === null || typeof raw !== 'object') continue;
        const conversationKey = raw.conversationKey ?? raw.groupOpenid ?? key;
        const record: ConversationSessionRecord = {
          conversationKey,
          logicalId: raw.logicalId ?? conversationHash(conversationKey),
          currentSessionId: raw.currentSessionId ?? '',
          generation: raw.generation ?? 1,
          createdAt: raw.createdAt ?? this.now(),
          updatedAt: raw.updatedAt ?? this.now(),
        };
        this.sessions.set(key, record);
      }
      this.options.logger.info('已加载会话映射', { sessions: this.sessions.size });
    } catch (error) {
      // 映射文件损坏不是致命错误：最坏情况是重新铸会话 + 走回放，功能不受影响
      this.options.logger.warn('sessions.json 解析失败，将忽略（会新建会话）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 原子写：先写临时文件再 rename，避免半截文件。 */
  private persist(): void {
    const file = this.options.paths.sessionsFile;
    const payload: SessionsFileShape = {
      version: 1,
      sessions: Object.fromEntries([...this.sessions.entries()]),
    };
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    } catch (error) {
      this.options.logger.warn('写入 sessions.json 失败（不影响运行）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
