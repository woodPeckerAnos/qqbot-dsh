/**
 * 管线统计：各 stage 自报计数，Orchestrator 聚合成快照。
 *
 * 设计约定：
 *   - 计数器是公共数值字段，哪个 stage 拥有哪个字段在各自的文件头注释里写明；
 *   - 快照（snapshotStats）在这里的字段之外再附上 inFlight / queued / offpeak，
 *     它们不是计数而是状态，归 Task 管理器、lane 调度器与谷时段闸服务所有；
 *   - health 端点原样展示快照，不在此层做格式化。
 *   - 旧 turn / 后台 / 周期进度字段保留 health 数字字段兼容；当前状态见
 *     health.tasks、health.messages，已停用字段不再由生产路径递增。
 */

import type { OffpeakSnapshot } from '../offpeak/index.js';

export class PipelineStats {
  /** 收到的用户消息数（Orchestrator 入口；**不含**旁听消息） */
  received = 0;
  /**
   * 收到的旁听消息数（群里没 @ bot，Orchestrator 入口分流）。
   * 与 `received` 分开计数：旁听消息不占配额、不产生回复，混在一起会让人
   * 误判"今天的消息量"。
   */
  observed = 0;
  /** 旁听消息被丢弃数（未装配介入层时） */
  observedSkipped = 0;
  /** 主动介入：进入判定的评估次数 */
  proactiveEvaluated = 0;
  /** 主动介入：发起过的判定调用次数（与 proactiveJudgeFailures 一起读，分清"没调"与"调了失败"） */
  proactiveJudgeCalls = 0;
  /** 主动介入：判定失败次数（超时 / HTTP / 解析） */
  proactiveJudgeFailures = 0;
  /** 主动介入：因判定连续失败被暂停评估的会话数 */
  proactiveSuspended = 0;
  /** 主动介入：被否决层否决的次数 */
  proactiveVetoed = 0;
  /** 主动介入：首次成功送达的主动 Task 数，每 Task 计一次 */
  proactiveSpoke = 0;
  /** 主动介入：dryRun 下"本应发出"的次数 */
  proactiveWouldSend = 0;
  /** 主动介入：投递层降级次数（平台不支持 / 限流 / 错误） */
  proactiveDegraded = 0;
  /**
   * 主动介入：wait 票据的**建票**次数（模型想等，且对象仍挂起）。
   * 与 `proactiveWaitTickets` 的四个终局一起读才能闭合账目。
   */
  proactiveWaitTicketCreated = 0;
  /**
   * 主动介入：建票据的**理由分布**（`wait_ticket_created{reason}`）。
   * 需求点名要有它：按理由分布直接回答"模型为什么想等"。
   */
  proactiveWaitTicketCreatedByReason: Record<string, number> = {};
  /**
   * 主动介入：wait 票据的四种终局计数（`resolved` / `spent` / `stale` / `unchanged`）。
   *
   * 账目等式：`proactiveWaitTicketCreated === Σ 本字段`。
   *   - `resolved` 高 = wait 有价值；长期为 0 = 这个机制应该删掉；
   *   - `spent` 高 = 模型过度使用"让路"；
   *   - `stale` / `unchanged` 越高越好（各自省下了一次 LLM 调用）。
   */
  proactiveWaitTickets: Record<string, number> = {};
  /** 主动介入：模型想等、但被否决层按下的次数（按理由：not-yet / watching / …） */
  proactiveWaitDeclined: Record<string, number> = {};
  /** 主动介入：模型引用了一个不存在（或没给）的挂起问题 */
  proactiveWaitInvalidTarget = 0;
  /**
   * 主动介入：**开了一个话题 session**（LLM 判"值得"且该次发言成立）。
   *
   * 与 `proactiveSpoke` 一起看：开得多、说得少 = 判据偏松；
   * 与 `proactiveSpokeInSession` 的分布一起看 = "预算 2 到底对不对"。
   */
  proactiveSessionOpened = 0;
  /**
   * 主动介入：**关了一个话题 session**。
   *
   * 账目等式：`proactiveSessionOpened === proactiveSessionClosed`
   * （每次开启只有一个终局），且 `=== Σ proactiveSessionClosedBy`。
   */
  proactiveSessionClosed = 0;
  /**
   * 主动介入：session 的关闭原因分布
   * （`llm-closed` / `topic-changed` / `idle` / `conversation-gone`）。
   *
   * `llm-closed` 高 = 判据里"什么时候该关"那一段有效；
   * `topic-changed` 高 = 模型在主动切话题（预算是靠它重置的）；
   * **预算不在这个分布里**——它只让会话闭嘴（见 `proactiveBudgetExhausted`）。
   */
  proactiveSessionClosedBy: Record<string, number> = {};
  /**
   * 主动介入：每个话题里首次成功送达的 Task 数分布（键 = Task 数，值 = 话题数）。
   *
   * 需求点名它是核心指标：集中在 1 = 预算 2 用不满（可考虑降为 1）；
   * 集中在 2 = 预算卡着（每次都说满）。
   */
  proactiveSpokeInSession: Record<string, number> = {};
  /** 主动介入：被"转录自上次判定以来无新增"挡下的次数（唯一的本地闸，不调 LLM） */
  proactiveSkippedUnchanged = 0;
  /** 事件去重丢弃数（dedupe stage） */
  deduplicated = 0;
  /** Task 准入拒绝数（main.ts 的 Actor 提交出口） */
  rejectedBusy = 0;
  /** 单聊开关拦截数（Orchestrator 入口，去重之前） */
  skippedC2C = 0;
  /** 谷时段闸拦截数（offpeak-gate stage） */
  gatedOffpeak = 0;
  /** 处理过的 /offpeak 命令数（offpeak-command stage） */
  adminCommands = 0;
  /** 处理过的 /stop、/new 会话控制命令数（session-command stage） */
  sessionCommands = 0;
  /** 旧单轮话题重置计数，仅保留 health 兼容 */
  topicResets = 0;
  /** 旧长任务提示计数，仅保留 health 兼容 */
  longTaskHints = 0;
  /** 旧整轮会话锁排队提示计数，仅保留 health 兼容 */
  busyNoticed = 0;
  /** 用户 Task 正常完成数（main.ts，双 lane 终结） */
  completed = 0;
  /** 用户 Task 失败数（main.ts，双 lane 终结） */
  failed = 0;
  /** 旧单轮超时计数，仅保留 health 兼容 */
  timedOut = 0;
  /** 旧后台子代理启动计数，仅保留 health 兼容 */
  backgroundStarted = 0;
  /** 旧后台子代理结束计数，仅保留 health 兼容 */
  backgroundFinished = 0;
  /** 旧后台自发轮次捕获计数，仅保留 health 兼容 */
  backgroundCaptured = 0;
  /** 旧后台即时推送计数，仅保留 health 兼容 */
  backgroundPushed = 0;
  /** 旧后台搭载回复计数，仅保留 health 兼容 */
  backgroundDelivered = 0;
  /** 旧单轮子会话事件过滤计数，仅保留 health 兼容 */
  childEventsFiltered = 0;
  /**
   * 准备进 prompt 的图片**块**数（PromptPreparer，每 Task 计一次）。
   *
   * 计的是 block：一张长图按可读分辨率切成 N 块时算 N（见 dsh/image.ts），
   * 所以它可能大于这一轮消息里的源图张数——想知道"用户发了几张图"，看
   * PromptPreparer 的源图统计 `totalImages`。
   */
  imagesInlined = 0;
  /** 读取失败/超限/格式不支持/解不开而跳过的图片数（PromptPreparer） */
  imagesSkipped = 0;
  /**
   * 滚窗上下文里成功内联的源图数（PromptPreparer；`imagesInlined` 的补充，
   * 不是它的子集——两者按来源分开计）。
   *
   * 为什么要单独计：被 @ 时上下文里的图（"群里先发图、再 @ 问这是什么"）走的是一条
   * 独立通路（写入时只存引用、注入时才取字节，见 `store/window.ts`）。混进
   * `imagesInlined` 就再也答不上"模型看不到的到底是刚发的那张，还是背景里的那张"。
   */
  windowImagesInlined = 0;
  /**
   * 滚窗上下文里**没能送进 prompt** 的源图张数（配额不够 / 下载失败 / 格式不支持 /
   * 解不开都会计进来）。
   */
  windowImagesSkipped = 0;
  /** 从滚窗上下文里取到字节的文件数（PromptPreparer；同时并进 filesFetched 等） */
  windowFilesFetched = 0;
  /**
   * 按需展开的聊天记录条数（PromptPreparer）。
   *
   * 这条通路**只在**话题判定认为"这次的问题明确提到了一条聊天记录"时才走
   * （见 `store/window.ts` 的 `recordIds`）。长期为 0 = 那条规定太严或用户从不这么问；
   * 与 `windowForwardsFailed` 一起读才知道"问了但读不到"的比例。
   */
  windowForwardsExpanded = 0;
  /** 认定要展开、但最终没读出来的聊天记录条数（回查失败 / 平台不支持 / 超限） */
  windowForwardsFailed = 0;
  /**
   * 成功展开的转发消息块数（连接器回查 get_forward_msg 成功后）。
   * 只统计**顶层**块——嵌套块的条目会并进父块的渲染文本，两边都计会重复。
   */
  forwardsExpanded = 0;
  /** 实际渲染进 content 的转发条目数（连接器；受 maxNodes/maxChars 裁剪后，同样只算顶层） */
  forwardNodesInlined = 0;
  /**
   * 未能展开的转发块数：回查失败/超时/响应解析不出条目/嵌套层级过深/超出读取上限。
   *
   * **不包括"开关关掉"**：那是运维主动关闭，不是失败——把它计进来会让
   * "关掉功能"看起来像"功能坏了"。关掉时连接器不发任何请求、也不上报。
   */
  forwardsFailed = 0;
  /** 取到字节并通过体积复核的文件数（PromptPreparer；与 filesSkipped 互斥） */
  filesFetched = 0;
  /** 成功抽取正文的文件数（PromptPreparer） */
  filesExtracted = 0;
  /** 只落盘、未抽取正文的文件数（PromptPreparer；类型不支持或解析器不可用） */
  filesSavedOnly = 0;
  /** 因关闭/超体积/超出数量/失败而跳过的文件数（PromptPreparer / 连接器） */
  filesSkipped = 0;
  /** 准备进 prompt 的文件正文字符数（PromptPreparer，每 Task 计一次） */
  fileCharsInlined = 0;
  /** 成功送达的消息数（Task 出口 / 欢迎语） */
  repliesSent = 0;
  /** 旧附件消息计数，仅保留 health 兼容；当前见 health.messages */
  attachmentsSent = 0;
  /** 旧周期进度计数，仅保留 health 兼容 */
  progressSent = 0;
}

/**
 * health 端点展示用的完整快照：计数 + Task / lane 状态 + 谷时段闸状态。
 *
 * 三个 wait 相关字段被映射成**数字**（而不是原样透出对象）：
 * `dispatcher` 是 `/metrics` 的对外契约，字段全为数字是一条被 RUNBOOK
 * 依赖的形状约束——按理由拆开的分布另在 `proactive.waitDeclined` /
 * `proactive.waitTickets` 里给（见 health.ts）。
 */
export type PipelineStatsSnapshot = {
  [K in keyof PipelineStats]: number;
} & {
  /** 四种终局之和（与 `proactiveWaitTicketCreated` 一起读，账目应当闭合） */
  proactiveWaitTickets: number;
  /** 按理由建票次数的总和（按理由的分布见 proactive.waitTicketsCreatedByReason） */
  proactiveWaitTicketCreatedByReason: number;
  /** 按下次数的总和（按理由的分布见 proactive.waitDeclined） */
  proactiveWaitDeclined: number;
  /** session 关闭次数的总和（**必须等于 proactiveSessionClosed**；分布见 proactive.sessions.closedBy） */
  proactiveSessionClosedBy: number;
  /** 所有 session 里发言次数的总和（分布见 proactive.sessions.spokeInSession） */
  proactiveSpokeInSession: number;
  inFlight: number;
  queued: number;
  offpeak: OffpeakSnapshot;
};
