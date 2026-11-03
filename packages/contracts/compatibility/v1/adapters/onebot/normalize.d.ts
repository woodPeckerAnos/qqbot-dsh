/**
 * OneBot v11 事件 → 归一化事件（纯函数，无 IO，便于单测）。
 *
 * 归一化规则：
 *   - 群消息（message.group，sub_type=normal）：只在 @机器人 时触发；
 *     正文 = 全部片段的扁平化结果（文本 + 图片/语音/视频/文件的文字标记）；
 *   - 私聊（message.private，sub_type=friend）：直接触发；
 *   - notice.group_increase 且 user_id 是自己 → 进群欢迎；
 *   - notice.friend_add → 加好友欢迎；
 *   - request.friend / request.group(invite) → 返回审批描述，由连接器按配置放行；
 *   - meta_event：lifecycle → 记录 self_id，heartbeat → 保活信号。
 *
 * 富媒体与引用（这是本文件从"只认 text 段"升级出来的部分）：
 *   - `image` / `mface` / `record` / `video` / `file` 段各自映射成 core 的
 *     MessagePart，图片由 PromptPreparer 按 Task 下载并复用到两个 lane 的 prompt；
 *   - `reply` 段只带消息 id，被引用的内容要**额外回查**（get_msg），所以这里只把
 *     id 透出去（`quotedMessageId`），由 connector.ts 完成异步补全；
 *   - `at` 段里 @ 机器人自己是触发条件，@ 别人渲染成 `@昵称`。
 *
 * 会话键规则：`ob11:g<群号>` / `ob11:u<QQ号>`。
 * 加 `ob11:` 前缀是必须的：OneBot 的数字 QQ 号与官方 openid 是两套命名空间，
 * 且去重表、工作区、对话记录全平台共用，无前缀就会互相污染。
 */
/**
 * OneBot v11 事件 → 归一化事件（纯函数，无 IO，便于单测）。
 *
 * 归一化规则：
 *   - 群消息（message.group，sub_type=normal）：只在 @机器人 时触发；
 *     正文 = 全部片段的扁平化结果（文本 + 图片/语音/视频/文件的文字标记）；
 *   - 私聊（message.private，sub_type=friend）：直接触发；
 *   - notice.group_increase 且 user_id 是自己 → 进群欢迎；
 *   - notice.friend_add → 加好友欢迎；
 *   - request.friend / request.group(invite) → 返回审批描述，由连接器按配置放行；
 *   - meta_event：lifecycle → 记录 self_id，heartbeat → 保活信号。
 *
 * 富媒体与引用（这是本文件从"只认 text 段"升级出来的部分）：
 *   - `image` / `mface` / `record` / `video` / `file` 段各自映射成 core 的
 *     MessagePart，图片由 PromptPreparer 按 Task 下载并复用到两个 lane 的 prompt；
 *   - `reply` 段只带消息 id，被引用的内容要**额外回查**（get_msg），所以这里只把
 *     id 透出去（`quotedMessageId`），由 connector.ts 完成异步补全；
 *   - `at` 段里 @ 机器人自己是触发条件，@ 别人渲染成 `@昵称`。
 *
 * 会话键规则：`ob11:g<群号>` / `ob11:u<QQ号>`。
 * 加 `ob11:` 前缀是必须的：OneBot 的数字 QQ 号与官方 openid 是两套命名空间，
 * 且去重表、工作区、对话记录全平台共用，无前缀就会互相污染。
 */
import type { ConversationTarget, MessagePart, NormalizedEvent } from '../../core/connector.js';
import type { OneBotEvent, OneBotSegment } from './types.js';
export declare const ONEBOT_PLATFORM = "onebot";
export type onebotGroupTarget = (groupId: number | string) => ConversationTarget;
export type onebotC2cTarget = (userId: number | string) => ConversationTarget;
export type NormalizeResult = {
    type: 'event';
    event: NormalizedEvent;
    /** 群/私聊消息引用了某条消息时为该消息 id（连接器据此回查引用内容） */
    quotedMessageId?: string;
    /** 消息里的转发块（连接器据此回查 get_forward_msg，见 ForwardRef） */
    forwardRefs?: ForwardRef[];
} | {
    type: 'friend-request';
    flag: string;
    userId: number;
} | {
    type: 'group-invite';
    flag: string;
    groupId: number;
    userId: number;
} | {
    type: 'lifecycle';
    selfId: number;
} | {
    type: 'heartbeat';
    selfId: number;
} | {
    type: 'ignored';
    reason: string;
};
/** 一条消息解析出来的全部内容 */
export interface ExtractedContent {
    parts: MessagePart[];
    /** parts 的扁平化文本（进对话记录、命令匹配、日志） */
    content: string;
    /** 是否 @ 了机器人自己 */
    atSelf: boolean;
    /** `reply` 段引用的消息 id */
    quotedMessageId?: string;
    /**
     * 待展开的转发块：`index` 是它在 `parts` 里的位置（占位片段），
     * `id` 是 get_forward_msg 的入参，`nodes` 是平台**已经随事件推过来**的逐条内容。
     *
     * 为什么不在归一化时就把内容渲染成最终片段：限额（条数/字符/深度）属于连接器的
     * 配置，渲染必须和回查路径共用同一套限额，否则"内联"与"回查"两条路的成本不一样。
     * 解析（纯函数）在这里做，渲染与限额在连接器做。
     *
     * 为什么 `id` 与 `nodes` 都可选：两者至少有一个（都没有时归一化直接给
     * `[聊天记录]` 文本占位）；只有 nodes 的形态见 `case 'node'` 与部分实现。
     */
    forwardRefs?: ForwardRef[];
}
/** 转发块占位片段在 parts 中的位置 + 平台侧 id / 已内联的逐条内容 */
export interface ForwardRef {
    index: number;
    /** get_forward_msg 的入参；平台没给 id 且有内联内容时不写 */
    id?: string;
    /** 平台随事件推来的逐条发言（NapCat 的 `forward.data.content`）；有就不必回查 */
    nodes?: ForwardNode[];
}
/** 转发块里的一条发言（已解析成片段，可能自己还带转发/引用） */
export interface ForwardNode {
    author?: string;
    parts: MessagePart[];
    /** 该条发言内部的嵌套转发（相对 `parts` 的下标）；没有嵌套时不写 */
    forwardRefs?: ForwardRef[];
}
/** 把 CQ 码字符串拆成等价的段数组（老框架或 raw_message 只有 CQ 码时用）。 */
export type parseCqCodes = (raw: string) => OneBotSegment[];
/**
 * 解析一条 OneBot 消息的全部内容（数组段或 CQ 码字符串）。
 *
 * 纯函数：不做任何网络请求，引用消息的内容也不在这里回查。
 */
export type extractMessageContent = (message: OneBotSegment[] | string | undefined, selfId: number) => ExtractedContent;
/**
 * 兼容旧入口：只关心文本与是否 @ 机器人。
 * @deprecated 新代码请用 extractMessageContent（它同时给出图片等片段）。
 */
export type extractGroupContent = (message: OneBotSegment[] | string | undefined, selfId: number) => {
    content: string;
    atSelf: boolean;
};
/**
 * 把 get_msg 回查到的被引用消息解析成**完整内容**（含它自己的转发待回查下标）。
 *
 * 返回完整 `ExtractedContent` 而不是只有 parts：被引用的消息本身可能是一条
 * 合并转发，把它的 `forwardRefs` 丢掉会让"引用一条聊天记录"渲染成
 * `[转发消息]（内容未读入）`——明明有能力查却不查。
 *
 * 纯函数：`data` 是 get_msg 返回的 `data` 字段。
 */
export type quotedContentFromGetMsg = (data: unknown, selfId: number) => ExtractedContent;
/** @deprecated 用 quotedContentFromGetMsg（它同时给出嵌套的转发下标） */
export type quotedPartsFromGetMsg = (data: unknown, selfId: number) => MessagePart[];
/** 从 get_msg 返回体里取被引用消息的发送者显示名。 */
export type quotedAuthorFromGetMsg = (data: unknown) => string | undefined;
/**
 * `get_forward_msg` 的响应 → 逐条发言（纯函数，便于单测）。
 *
 * 任何不认识的条目都**跳过**而不是抛错：一条解析不了的转发不该让用户这条消息
 * 消失（与引用回查同样的降级纪律）。返回空数组表示"这个转发块读不出来"，
 * 由连接器换成 `[聊天记录]`。
 */
export type parseForwardNodes = (data: unknown, selfId: number) => ForwardNode[];
/**
 * 归一化一条 OneBot 事件。
 * 返回值描述"该做什么"，副作用（审批、记录 self_id）由连接器执行。
 */
export type normalizeOneBotEvent = (raw: OneBotEvent, now?: () => number) => NormalizeResult;
