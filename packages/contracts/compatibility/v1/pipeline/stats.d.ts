/**
 * 管线统计：各 stage 自报计数，Orchestrator 聚合成快照。
 *
 * 设计约定：
 *   - 统计仅通过 record/recordDistribution 修改，snapshot 返回深只读值；
 *   - 快照（snapshotStats）在这里的字段之外再附上 inFlight / queued / offpeak，
 *     它们不是计数而是状态，归 Task 管理器、lane 调度器与谷时段闸服务所有；
 *   - health 端点原样展示快照，不在此层做格式化。
 *   - 旧 turn / 后台 / 周期进度字段保留 health 数字字段兼容；当前状态见
 *     health.tasks、health.messages，已停用字段不再由生产路径递增。
 */
/**
 * 管线统计：各 stage 自报计数，Orchestrator 聚合成快照。
 *
 * 设计约定：
 *   - 统计仅通过 record/recordDistribution 修改，snapshot 返回深只读值；
 *   - 快照（snapshotStats）在这里的字段之外再附上 inFlight / queued / offpeak，
 *     它们不是计数而是状态，归 Task 管理器、lane 调度器与谷时段闸服务所有；
 *   - health 端点原样展示快照，不在此层做格式化。
 *   - 旧 turn / 后台 / 周期进度字段保留 health 数字字段兼容；当前状态见
 *     health.tasks、health.messages，已停用字段不再由生产路径递增。
 */
import type { DeepReadonly } from '@qqbot/contracts';
import type { OffpeakSnapshot } from '../offpeak/index.js';
export interface PipelineCounters {
    received: number;
    observed: number;
    observedSkipped: number;
    proactiveEvaluated: number;
    proactiveJudgeCalls: number;
    proactiveJudgeFailures: number;
    proactiveSuspended: number;
    proactiveVetoed: number;
    proactiveSpoke: number;
    proactiveWouldSend: number;
    proactiveDegraded: number;
    proactiveWaitTicketCreated: number;
    proactiveWaitTicketCreatedByReason: Record<string, number>;
    proactiveWaitTickets: Record<string, number>;
    proactiveWaitDeclined: Record<string, number>;
    proactiveWaitInvalidTarget: number;
    proactiveSessionOpened: number;
    proactiveSessionClosed: number;
    proactiveSessionClosedBy: Record<string, number>;
    proactiveSpokeInSession: Record<string, number>;
    proactiveSkippedUnchanged: number;
    deduplicated: number;
    rejectedBusy: number;
    skippedC2C: number;
    gatedOffpeak: number;
    adminCommands: number;
    sessionCommands: number;
    topicResets: number;
    longTaskHints: number;
    busyNoticed: number;
    completed: number;
    failed: number;
    timedOut: number;
    backgroundStarted: number;
    backgroundFinished: number;
    backgroundCaptured: number;
    backgroundPushed: number;
    backgroundDelivered: number;
    childEventsFiltered: number;
    imagesInlined: number;
    imagesSkipped: number;
    windowImagesInlined: number;
    windowImagesSkipped: number;
    windowFilesFetched: number;
    windowForwardsExpanded: number;
    windowForwardsFailed: number;
    forwardsExpanded: number;
    forwardNodesInlined: number;
    forwardsFailed: number;
    filesFetched: number;
    filesExtracted: number;
    filesSavedOnly: number;
    filesSkipped: number;
    fileCharsInlined: number;
    repliesSent: number;
    attachmentsSent: number;
    progressSent: number;
}
export type StatCounter = 'received' | 'observed' | 'observedSkipped' | 'proactiveEvaluated' | 'proactiveJudgeCalls' | 'proactiveJudgeFailures' | 'proactiveSuspended' | 'proactiveVetoed' | 'proactiveSpoke' | 'proactiveWouldSend' | 'proactiveDegraded' | 'proactiveWaitTicketCreated' | 'proactiveWaitInvalidTarget' | 'proactiveSessionOpened' | 'proactiveSessionClosed' | 'proactiveSkippedUnchanged' | 'deduplicated' | 'rejectedBusy' | 'skippedC2C' | 'gatedOffpeak' | 'adminCommands' | 'sessionCommands' | 'topicResets' | 'longTaskHints' | 'busyNoticed' | 'completed' | 'failed' | 'timedOut' | 'backgroundStarted' | 'backgroundFinished' | 'backgroundCaptured' | 'backgroundPushed' | 'backgroundDelivered' | 'childEventsFiltered' | 'imagesInlined' | 'imagesSkipped' | 'windowImagesInlined' | 'windowImagesSkipped' | 'windowFilesFetched' | 'windowForwardsExpanded' | 'windowForwardsFailed' | 'forwardsExpanded' | 'forwardNodesInlined' | 'forwardsFailed' | 'filesFetched' | 'filesExtracted' | 'filesSavedOnly' | 'filesSkipped' | 'fileCharsInlined' | 'repliesSent' | 'attachmentsSent' | 'progressSent';
export type StatDistribution = 'proactiveWaitTicketCreatedByReason' | 'proactiveWaitTickets' | 'proactiveWaitDeclined' | 'proactiveSessionClosedBy' | 'proactiveSpokeInSession';
export interface PipelineStats {
    record(counter: StatCounter, amount?: number): void;
    recordDistribution(counter: StatDistribution, key: string, amount?: number): void;
    snapshot(): DeepReadonly<PipelineCounters>;
    get received(): number;
    get observed(): number;
    get observedSkipped(): number;
    get proactiveEvaluated(): number;
    get proactiveJudgeCalls(): number;
    get proactiveJudgeFailures(): number;
    get proactiveSuspended(): number;
    get proactiveVetoed(): number;
    get proactiveSpoke(): number;
    get proactiveWouldSend(): number;
    get proactiveDegraded(): number;
    get proactiveWaitTicketCreated(): number;
    get proactiveWaitTicketCreatedByReason(): Readonly<Record<string, number>>;
    get proactiveWaitTickets(): Readonly<Record<string, number>>;
    get proactiveWaitDeclined(): Readonly<Record<string, number>>;
    get proactiveWaitInvalidTarget(): number;
    get proactiveSessionOpened(): number;
    get proactiveSessionClosed(): number;
    get proactiveSessionClosedBy(): Readonly<Record<string, number>>;
    get proactiveSpokeInSession(): Readonly<Record<string, number>>;
    get proactiveSkippedUnchanged(): number;
    get deduplicated(): number;
    get rejectedBusy(): number;
    get skippedC2C(): number;
    get gatedOffpeak(): number;
    get adminCommands(): number;
    get sessionCommands(): number;
    get topicResets(): number;
    get longTaskHints(): number;
    get busyNoticed(): number;
    get completed(): number;
    get failed(): number;
    get timedOut(): number;
    get backgroundStarted(): number;
    get backgroundFinished(): number;
    get backgroundCaptured(): number;
    get backgroundPushed(): number;
    get backgroundDelivered(): number;
    get childEventsFiltered(): number;
    get imagesInlined(): number;
    get imagesSkipped(): number;
    get windowImagesInlined(): number;
    get windowImagesSkipped(): number;
    get windowFilesFetched(): number;
    get windowForwardsExpanded(): number;
    get windowForwardsFailed(): number;
    get forwardsExpanded(): number;
    get forwardNodesInlined(): number;
    get forwardsFailed(): number;
    get filesFetched(): number;
    get filesExtracted(): number;
    get filesSavedOnly(): number;
    get filesSkipped(): number;
    get fileCharsInlined(): number;
    get repliesSent(): number;
    get attachmentsSent(): number;
    get progressSent(): number;
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
    [K in keyof PipelineCounters]: number;
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
export type createPipelineStatsFactory = () => PipelineStats;
