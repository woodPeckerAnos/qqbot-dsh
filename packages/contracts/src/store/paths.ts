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
/** 会话键 → 稳定的短 hash（目录名用） */
export type conversationHash = (conversationKey: string) => string;
export interface StorePaths {
  workspacesRoot: string;
  stateDir: string;
  conversationsDir: string;
  seenDir: string;
  sessionsFile: string;
}
export type resolveStorePaths = (options: {
  workspacesRoot: string;
  stateDir: string;
}) => StorePaths;
/** 幂等创建全部目录。 */
export type ensureStoreDirs = (paths: StorePaths) => void;
/** 某会话的工作区绝对路径。 */
export type workspacePathFor = (paths: StorePaths, conversationKey: string) => string;
/** 确保该会话工作区存在并返回路径。 */
export type ensureWorkspace = (paths: StorePaths, conversationKey: string) => string;
/** 某会话的对话记录文件路径。 */
export type conversationFileFor = (paths: StorePaths, conversationKey: string) => string;
