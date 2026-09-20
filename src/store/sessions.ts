/**
 * 群 → DSH 会话映射。
 *
 * 这里有一个必须讲清楚的设计点：**每次 runtime 重建都会铸一个新的 sessionId**。
 *
 * 原因是实测得到的结论（见 docs/DESIGN.md 2.3）：DSH 的 `session/prompt` 没有
 * resume 语义，复用旧 sessionId 不会恢复历史，反而会让 DSH 的持久化把新会话
 * 追加到旧日志上，产生"看着是同一个会话、实际没有上下文"的误导状态。
 *
 * 所以：
 *   - `logicalId`：群的稳定标识，用于日志与排障，恒定不变；
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
import { groupHash, type StorePaths } from './paths.js';

export interface GroupSessionRecord {
  groupOpenid: string;
  /** 稳定标识（= groupHash），永远不变 */
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
  groups: Record<string, GroupSessionRecord>;
}

export interface SessionStoreOptions {
  paths: StorePaths;
  logger: Logger;
  now?: () => number;
  sessionIdFactory?: (groupOpenid: string, generation: number) => string;
}

export class SessionStore {
  private readonly groups = new Map<string, GroupSessionRecord>();
  private readonly now: () => number;
  private readonly sessionIdFactory: (groupOpenid: string, generation: number) => string;

  constructor(private readonly options: SessionStoreOptions) {
    this.now = options.now ?? Date.now;
    this.sessionIdFactory =
      options.sessionIdFactory ??
      ((groupOpenid, generation) => `qq-${groupHash(groupOpenid)}-g${generation}-${randomUUID().slice(0, 8)}`);
    this.load();
  }

  /**
   * 取该群当前会话记录；若不存在或 `rotate` 为真则铸新会话。
   *
   * @param rotate 是否强制开新会话（runtime 重建时传 true）
   */
  ensure(groupOpenid: string, rotate = false): GroupSessionRecord {
    const existing = this.groups.get(groupOpenid);
    if (existing !== undefined && !rotate) return existing;

    const generation = (existing?.generation ?? 0) + 1;
    const at = this.now();
    const record: GroupSessionRecord = {
      groupOpenid,
      logicalId: groupHash(groupOpenid),
      currentSessionId: this.sessionIdFactory(groupOpenid, generation),
      generation,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    this.groups.set(groupOpenid, record);
    this.persist();
    this.options.logger.info(
      existing === undefined ? '为群创建 DSH 会话' : '为群轮换 DSH 会话（runtime 重建）',
      { group: record.logicalId, generation, sessionId: record.currentSessionId },
    );
    return record;
  }

  /** 只读查询（不创建）。 */
  peek(groupOpenid: string): GroupSessionRecord | undefined {
    return this.groups.get(groupOpenid);
  }

  /** 全部记录（health / 诊断用） */
  all(): GroupSessionRecord[] {
    return [...this.groups.values()];
  }

  private load(): void {
    const file = this.options.paths.sessionsFile;
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as SessionsFileShape;
      if (parsed?.version !== 1) {
        this.options.logger.warn('sessions.json 版本不认识，忽略并重建', {
          version: parsed?.version,
        });
        return;
      }
      for (const [key, record] of Object.entries(parsed.groups ?? {})) {
        if (record !== null && typeof record === 'object') this.groups.set(key, record);
      }
      this.options.logger.info('已加载群会话映射', { groups: this.groups.size });
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
      groups: Object.fromEntries([...this.groups.entries()]),
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
