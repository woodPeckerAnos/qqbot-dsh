/**
 * 存储路径布局与会话标识映射。
 *
 * 布局（根为 QQ_WORKSPACES_ROOT / QQ_STATE_DIR）：
 *
 *   /data/workspaces/<hash>/                每个会话一个工作区（agent 的 cwd）
 *     AGENTS.md                             管理员可写的会话规则，DSH 自动加载
 *   /data/bot/conversations/<hash>.jsonl    对话记录（只追加）
 *   /data/bot/seen/<eventId>                事件去重标记（空文件）
 *   /data/bot/sessions.json                 会话 → sessionId 映射（便于排障）
 *
 * 用 hash 而不是原始 openid 做目录名：openid 可能含特殊字符，且长度不可控；
 * 但日志与映射文件里保留原始 openid，便于排查"是哪个会话"。
 *
 * 这里的 "会话键"（conversationKey）由 QQ 接入层给出：
 *   - 群聊：原始 `group_openid`（保持与既有部署的目录兼容，不做迁移）；
 *   - 单聊：`c2c:<user_openid>`（用户 openid 与群 openid 是两套命名空间，必须隔离）。
 * 存储层只把它当不透明字符串，不解析其结构。
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 会话键 → 稳定的短 hash（目录名用） */
export function conversationHash(conversationKey: string): string {
  return createHash('sha256').update(conversationKey).digest('hex').slice(0, 16);
}

export interface StorePaths {
  workspacesRoot: string;
  stateDir: string;
  conversationsDir: string;
  seenDir: string;
  sessionsFile: string;
}

export function resolveStorePaths(options: {
  workspacesRoot: string;
  stateDir: string;
}): StorePaths {
  return {
    workspacesRoot: options.workspacesRoot,
    stateDir: options.stateDir,
    conversationsDir: join(options.stateDir, 'conversations'),
    seenDir: join(options.stateDir, 'seen'),
    sessionsFile: join(options.stateDir, 'sessions.json'),
  };
}

/** 幂等创建全部目录。 */
export function ensureStoreDirs(paths: StorePaths): void {
  mkdirSync(paths.workspacesRoot, { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.conversationsDir, { recursive: true });
  mkdirSync(paths.seenDir, { recursive: true });
}

/** 某会话的工作区绝对路径。 */
export function workspacePathFor(paths: StorePaths, conversationKey: string): string {
  return join(paths.workspacesRoot, conversationHash(conversationKey));
}

/** 确保该会话工作区存在并返回路径。 */
export function ensureWorkspace(paths: StorePaths, conversationKey: string): string {
  const path = workspacePathFor(paths, conversationKey);
  mkdirSync(path, { recursive: true });
  return path;
}

/** 某会话的对话记录文件路径。 */
export function conversationFileFor(paths: StorePaths, conversationKey: string): string {
  return join(paths.conversationsDir, `${conversationHash(conversationKey)}.jsonl`);
}
