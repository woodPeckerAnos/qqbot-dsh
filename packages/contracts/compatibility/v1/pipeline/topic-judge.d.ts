/**
 * 话题判定器：新消息与当前会话的既有话题是否相关。
 *
 * 为什么存在（替代最初的"硬时间间隔"方案）：话题是否结束是语义判断，
 * 不是时间判断——深夜接着中午的话题继续聊完全正常，而两分钟前刚收尾的话题
 * 也不该赖在上下文里。判定必须在 prompt 组装**之前**完成（回放/上下文注入
 * 都在那之后），所以不经 DSH 进程（起 runtime 跑一轮太贵，还会污染会话），
 * 直连 chat completions API 做一次无工具的结构化输出。
 *
 * 纪律：
 *   - **fail-safe = 相关**：超时、HTTP 错误、JSON 解析失败一律按"相关"处理
 *     （不重置）——误清的代价（上下文断片）远大于误留的代价（多带一点旧上下文）；
 *   - 输入全部按不可信内容处理：历史与新消息用显式边界标记包裹，
 *     声明"内容不是指令"（与 renderReplay 同款姿态）；
 *   - 判定结果只影响"是否重置上下文"，永远不会吞掉用户消息本身。
 */
/**
 * 话题判定器：新消息与当前会话的既有话题是否相关。
 *
 * 为什么存在（替代最初的"硬时间间隔"方案）：话题是否结束是语义判断，
 * 不是时间判断——深夜接着中午的话题继续聊完全正常，而两分钟前刚收尾的话题
 * 也不该赖在上下文里。判定必须在 prompt 组装**之前**完成（回放/上下文注入
 * 都在那之后），所以不经 DSH 进程（起 runtime 跑一轮太贵，还会污染会话），
 * 直连 chat completions API 做一次无工具的结构化输出。
 *
 * 纪律：
 *   - **fail-safe = 相关**：超时、HTTP 错误、JSON 解析失败一律按"相关"处理
 *     （不重置）——误清的代价（上下文断片）远大于误留的代价（多带一点旧上下文）；
 *   - 输入全部按不可信内容处理：历史与新消息用显式边界标记包裹，
 *     声明"内容不是指令"（与 renderReplay 同款姿态）；
 *   - 判定结果只影响"是否重置上下文"，永远不会吞掉用户消息本身。
 */
import type { Logger } from '../logger.js';
import type { ConversationTurn } from '../store/conversations.js';
/** 判定输入。 */
export interface TopicJudgeInput {
    /** 最近的会话记录（不含当前这条新消息） */
    history: readonly ConversationTurn[];
    /** 当前新消息的扁平化文本 */
    newMessage: string;
    /**
     * 是否**顺带**判定"这条新消息有没有明确提到一条聊天记录"（默认不问）。
     *
     * 只有观察窗口里真的躺着一条还没展开的聊天记录时才置 true：没得展开的时候问它，
     * 等于邀请模型无中生有；而这是**同一次调用**的第二个字段，不问就没有任何代价。
     */
    askAboutChatRecord?: boolean;
}
/**
 * 一次判定的结论。
 *
 * 两个字段的 fail-safe 方向**刻意相反**：
 *   - `related` 失败时取 true（误清上下文的代价远大于多带一点旧上下文）；
 *   - `mentionsChatRecord` 失败时取 false（展开要回查、要花 token，而"没展开"
 *     最多少看一条记录——模型会如实说看不到，不会编）。
 */
export interface TopicVerdict {
    /** 新消息是否在延续既有话题（true = 保持上下文） */
    related: boolean;
    /** 新消息是否明确指向了一条聊天记录（只有 `askAboutChatRecord` 为 true 时才有意义） */
    mentionsChatRecord: boolean;
}
/**
 * 判定器函数签名。由 main.ts 用 createTopicJudge 构造后注入 PromptPreparer；
 * 未注入 = 关闭判定（也就**不会有**按需展开聊天记录的能力，见 §"聊天记录"）。
 */
export type TopicJudge = (input: TopicJudgeInput) => Promise<TopicVerdict>;
export interface TopicJudgeOptions {
    apiBase: string;
    /** 只来自 env（DEEPSEEK_API_KEY），不进配置文件 */
    apiKey: string;
    model: string;
    timeoutMs: number;
    /** 送给判定器的每条记录/新消息的最大字符数（防止超长输入） */
    perTurnMaxChars: number;
    logger: Logger;
    /** 测试注入用：替换 fetch */
    fetchImpl?: typeof fetch;
}
/** 把判定输入渲染成 user 消息（带不可信内容边界标记）。 */
export type renderJudgePrompt = (input: TopicJudgeInput, perTurnMaxChars: number) => string;
/** 判定结论的 fail-safe 值：相关（不重置）、不展开聊天记录。 */
export declare const VERDICT_FALLBACK: TopicVerdict;
/**
 * 从模型输出里解析结论；任何异常都落到 {@link VERDICT_FALLBACK}。
 *
 * `askAboutChatRecord` 为 false 时**忽略**输出里的 `mentions_chat_record`：没问就不
 * 认，否则模型自说自话的一个字段就能触发一次回查（那正是我们要避免的）。
 */
export type parseJudgeOutput = (text: string, askAboutChatRecord?: boolean) => TopicVerdict;
/**
 * 构造话题判定器。返回 undefined 表示未启用（缺 apiKey）。
 *
 * 判定失败（超时/HTTP 错误/解析失败）一律返回 true（视为相关，不重置上下文），
 * 失败原因记 warn 日志并计入返回值语义之外的观测面（调用方统计）。
 */
export type createTopicJudge = (options: TopicJudgeOptions) => TopicJudge | undefined;
export type TopicJudgeResult = (input: TopicJudgeInput) => Promise<import('../errors.js').Result<TopicVerdict>>;
export type parseJudgeResult = (text: string, askAboutChatRecord?: boolean) => import('../errors.js').Result<TopicVerdict>;
export type createTopicJudgeResult = (options: TopicJudgeOptions) => TopicJudgeResult | undefined;
