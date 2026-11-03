/**
 * inbox：把用户发来的文件落到会话工作区，供 agent 用自己已有的工具继续深挖。
 *
 * 为什么必须有这一层（而不是只把抽取出的文本塞进 prompt）：
 *   抽取是有损且有限的——截断、扫描件没有文本层、表格版式丢失。原文落到工作区，
 *   agent 就能读文件、写脚本、分页处理接着做；prompt 里的抽取文本只是
 *   "确定性基线"。两条路共用同一次下载，边际成本只是一次写盘。
 *
 * 与 outbox 的关系：**语义相反、必须分开**。outbox 是"要发回用户的产物"，
 * egress 会扫描即发；把用户发来的文件写进 outbox 会立刻回声给用户。
 * 配置层（config.ts）已经禁止两者同名，那是第一道闸，这里是第二道。
 *
 * 安全不变量（本模块负责）：
 *   - 文件名来自用户 → 一律 sanitize（去分隔符 / 控制字符 / 前导点，限长），
 *     再以 `<时间戳>-` 前缀保证唯一；写入用 `wx` 标志，**绝不覆盖**已有文件；
 *   - 写前做 realpath 包含性校验（与 outbox 同款），挡住符号链接把戏；
 *   - 单文件体积由调用方按 maxFileBytes 预筛，本层再按实际字节数复核一次；
 *   - 清理与配额一律 best-effort：失败只记 warn，绝不影响本轮回答。
 */
/**
 * inbox：把用户发来的文件落到会话工作区，供 agent 用自己已有的工具继续深挖。
 *
 * 为什么必须有这一层（而不是只把抽取出的文本塞进 prompt）：
 *   抽取是有损且有限的——截断、扫描件没有文本层、表格版式丢失。原文落到工作区，
 *   agent 就能读文件、写脚本、分页处理接着做；prompt 里的抽取文本只是
 *   "确定性基线"。两条路共用同一次下载，边际成本只是一次写盘。
 *
 * 与 outbox 的关系：**语义相反、必须分开**。outbox 是"要发回用户的产物"，
 * egress 会扫描即发；把用户发来的文件写进 outbox 会立刻回声给用户。
 * 配置层（config.ts）已经禁止两者同名，那是第一道闸，这里是第二道。
 *
 * 安全不变量（本模块负责）：
 *   - 文件名来自用户 → 一律 sanitize（去分隔符 / 控制字符 / 前导点，限长），
 *     再以 `<时间戳>-` 前缀保证唯一；写入用 `wx` 标志，**绝不覆盖**已有文件；
 *   - 写前做 realpath 包含性校验（与 outbox 同款），挡住符号链接把戏；
 *   - 单文件体积由调用方按 maxFileBytes 预筛，本层再按实际字节数复核一次；
 *   - 清理与配额一律 best-effort：失败只记 warn，绝不影响本轮回答。
 */
import type { Logger } from '../logger.js';
/**
 * 把平台给的文件名洗成"只能落在 inbox 里的一个普通文件名"。
 *
 * 纯函数、可单测。规则刻意偏保守：宁可把不认识的字换成下划线，也不放行任何
 * 可能有特殊含义的字符。中英文、数字与 `._-() ` 之外的字符都会被替换。
 */
export type sanitizeInboxFileName = (raw: string) => string;
export interface SaveInboxFileOptions {
    /** 该会话的工作区绝对路径 */
    workspacePath: string;
    /** 工作区内的 inbox 目录名（配置层已保证是纯目录名） */
    inboxDir: string;
    /** 平台给的文件名（会被 sanitize） */
    fileName: string;
    data: Uint8Array;
    /** 单文件字节上限（本层复核一次） */
    maxBytes: number;
    logger: Logger;
    now?: () => number;
}
export interface SavedInboxFile {
    /** 落盘绝对路径 */
    absPath: string;
    /** 相对工作区的展示路径（`inbox/1767-report.pdf`），写进 prompt 用 */
    relPath: string;
    /** 实际落盘的文件名（含时间戳前缀） */
    fileName: string;
    sizeBytes: number;
}
/**
 * 落一个文件到 inbox。失败一律返回 undefined（调用方降级成文字说明）。
 *
 * 时间戳前缀有两个作用：目录内按名字排序即按时间排序；同一秒内同名文件靠
 * `-N` 后缀与 `wx` 标志退让。它同时是**来源标记**——清理只认这个前缀，
 * 不会误删用户或 agent 自己放进来的文件（见 cleanupInbox）。
 */
export type saveInboxFile = (options: SaveInboxFileOptions) => Promise<SavedInboxFile | undefined>;
export interface InboxCleanupOptions {
    workspacePath: string;
    inboxDir: string;
    /** 保留天数（0 = 只按总量配额清理，不按时间） */
    retentionDays: number;
    /** 目录总字节上限；超出时**删最旧的**而不是拒绝新文件 */
    maxBytes: number;
    logger: Logger;
    now?: () => number;
}
/**
 * inbox 清理：先删超期文件，再删最旧的直到总量回到上限内。
 *
 * 三条边界：
 *   - 只认**本模块写的**文件（`<时间戳>-` 前缀）。`inbox` 对 agent 是很自然的名字，
 *     它自己往里放中间产物完全可能；没有来源标记的话，一个 7 天定时器会悄悄
 *     删掉它的东西且无人知情。前缀在这里就是 provenance。
 *   - 目录必须是工作区内的真实目录（见 resolveInboxDir）——否则清理会变成
 *     越权删除原语。
 *   - 为什么是"删最旧"而不是"拒绝新文件"：用户刚发来的文件价值最高，旧文件的
 *     价值随时间衰减；拒绝新文件会让"刚发的 PDF 读不了"变成常态故障。
 *
 * 全程 best-effort：任何一步失败只记 warn。清理失败不该影响用户这一轮的回答。
 */
export type cleanupInbox = (options: InboxCleanupOptions) => Promise<void>;
