/**
 * 存储路径布局与群标识映射。
 *
 * 布局（根为 QQ_WORKSPACES_ROOT / QQ_STATE_DIR）：
 *
 *   /data/workspaces/<hash>/          每个 QQ 群一个工作区（agent 的 cwd）
 *     AGENTS.md                       管理员可写的群规则，DSH 自动加载
 *   /data/bot/conversations/<hash>.jsonl   对话记录（只追加）
 *   /data/bot/seen/<eventId>               事件去重标记（空文件）
 *   /data/bot/sessions.json                群 → sessionId 映射（便于排障）
 *
 * 用 hash 而不是原始 openid 做目录名：openid 可能含特殊字符，且长度不可控；
 * 但日志与映射文件里保留原始 openid，便于排查"是哪个群"。
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 群 openid → 稳定的短 hash（目录名用） */
export function groupHash(groupOpenid: string): string {
  return createHash('sha256').update(groupOpenid).digest('hex').slice(0, 16);
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

/** 某群的工作区绝对路径。 */
export function workspacePathFor(paths: StorePaths, groupOpenid: string): string {
  return join(paths.workspacesRoot, groupHash(groupOpenid));
}

/** 确保该群工作区存在并返回路径。 */
export function ensureWorkspace(paths: StorePaths, groupOpenid: string): string {
  const path = workspacePathFor(paths, groupOpenid);
  mkdirSync(path, { recursive: true });
  return path;
}

/** 某群的对话记录文件路径。 */
export function conversationFileFor(paths: StorePaths, groupOpenid: string): string {
  return join(paths.conversationsDir, `${groupHash(groupOpenid)}.jsonl`);
}
