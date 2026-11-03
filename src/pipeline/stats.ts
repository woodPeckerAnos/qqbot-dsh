import type { PipelineCounters, StatCounter, StatDistribution } from '@qqbot/contracts';
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
import { readonlySnapshot, type DeepReadonly } from '@qqbot/contracts';

export type { PipelineCounters } from '@qqbot/contracts';
export type { StatCounter } from '@qqbot/contracts';
export type { StatDistribution } from '@qqbot/contracts';
export class PipelineStats {
  private readonly counters: PipelineCounters = {
    received: 0,
    observed: 0,
    observedSkipped: 0,
    proactiveEvaluated: 0,
    proactiveJudgeCalls: 0,
    proactiveJudgeFailures: 0,
    proactiveSuspended: 0,
    proactiveVetoed: 0,
    proactiveSpoke: 0,
    proactiveWouldSend: 0,
    proactiveDegraded: 0,
    proactiveWaitTicketCreated: 0,
    proactiveWaitTicketCreatedByReason: {},
    proactiveWaitTickets: {},
    proactiveWaitDeclined: {},
    proactiveWaitInvalidTarget: 0,
    proactiveSessionOpened: 0,
    proactiveSessionClosed: 0,
    proactiveSessionClosedBy: {},
    proactiveSpokeInSession: {},
    proactiveSkippedUnchanged: 0,
    deduplicated: 0,
    rejectedBusy: 0,
    skippedC2C: 0,
    gatedOffpeak: 0,
    adminCommands: 0,
    sessionCommands: 0,
    topicResets: 0,
    longTaskHints: 0,
    busyNoticed: 0,
    completed: 0,
    failed: 0,
    timedOut: 0,
    backgroundStarted: 0,
    backgroundFinished: 0,
    backgroundCaptured: 0,
    backgroundPushed: 0,
    backgroundDelivered: 0,
    childEventsFiltered: 0,
    imagesInlined: 0,
    imagesSkipped: 0,
    windowImagesInlined: 0,
    windowImagesSkipped: 0,
    windowFilesFetched: 0,
    windowForwardsExpanded: 0,
    windowForwardsFailed: 0,
    forwardsExpanded: 0,
    forwardNodesInlined: 0,
    forwardsFailed: 0,
    filesFetched: 0,
    filesExtracted: 0,
    filesSavedOnly: 0,
    filesSkipped: 0,
    fileCharsInlined: 0,
    repliesSent: 0,
    attachmentsSent: 0,
    progressSent: 0,
  };
  record(counter: StatCounter, amount = 1): void {
    assertCount(amount);
    this.counters[counter] += amount;
  }
  recordDistribution(counter: StatDistribution, key: string, amount = 1): void {
    assertCount(amount);
    this.counters[counter][key] = (this.counters[counter][key] ?? 0) + amount;
  }
  snapshot(): DeepReadonly<PipelineCounters> {
    return readonlySnapshot(this.counters);
  }
  get received(): number {
    return this.counters.received;
  }
  get observed(): number {
    return this.counters.observed;
  }
  get observedSkipped(): number {
    return this.counters.observedSkipped;
  }
  get proactiveEvaluated(): number {
    return this.counters.proactiveEvaluated;
  }
  get proactiveJudgeCalls(): number {
    return this.counters.proactiveJudgeCalls;
  }
  get proactiveJudgeFailures(): number {
    return this.counters.proactiveJudgeFailures;
  }
  get proactiveSuspended(): number {
    return this.counters.proactiveSuspended;
  }
  get proactiveVetoed(): number {
    return this.counters.proactiveVetoed;
  }
  get proactiveSpoke(): number {
    return this.counters.proactiveSpoke;
  }
  get proactiveWouldSend(): number {
    return this.counters.proactiveWouldSend;
  }
  get proactiveDegraded(): number {
    return this.counters.proactiveDegraded;
  }
  get proactiveWaitTicketCreated(): number {
    return this.counters.proactiveWaitTicketCreated;
  }
  get proactiveWaitTicketCreatedByReason(): Readonly<Record<string, number>> {
    return readonlySnapshot(this.counters.proactiveWaitTicketCreatedByReason);
  }
  get proactiveWaitTickets(): Readonly<Record<string, number>> {
    return readonlySnapshot(this.counters.proactiveWaitTickets);
  }
  get proactiveWaitDeclined(): Readonly<Record<string, number>> {
    return readonlySnapshot(this.counters.proactiveWaitDeclined);
  }
  get proactiveWaitInvalidTarget(): number {
    return this.counters.proactiveWaitInvalidTarget;
  }
  get proactiveSessionOpened(): number {
    return this.counters.proactiveSessionOpened;
  }
  get proactiveSessionClosed(): number {
    return this.counters.proactiveSessionClosed;
  }
  get proactiveSessionClosedBy(): Readonly<Record<string, number>> {
    return readonlySnapshot(this.counters.proactiveSessionClosedBy);
  }
  get proactiveSpokeInSession(): Readonly<Record<string, number>> {
    return readonlySnapshot(this.counters.proactiveSpokeInSession);
  }
  get proactiveSkippedUnchanged(): number {
    return this.counters.proactiveSkippedUnchanged;
  }
  get deduplicated(): number {
    return this.counters.deduplicated;
  }
  get rejectedBusy(): number {
    return this.counters.rejectedBusy;
  }
  get skippedC2C(): number {
    return this.counters.skippedC2C;
  }
  get gatedOffpeak(): number {
    return this.counters.gatedOffpeak;
  }
  get adminCommands(): number {
    return this.counters.adminCommands;
  }
  get sessionCommands(): number {
    return this.counters.sessionCommands;
  }
  get topicResets(): number {
    return this.counters.topicResets;
  }
  get longTaskHints(): number {
    return this.counters.longTaskHints;
  }
  get busyNoticed(): number {
    return this.counters.busyNoticed;
  }
  get completed(): number {
    return this.counters.completed;
  }
  get failed(): number {
    return this.counters.failed;
  }
  get timedOut(): number {
    return this.counters.timedOut;
  }
  get backgroundStarted(): number {
    return this.counters.backgroundStarted;
  }
  get backgroundFinished(): number {
    return this.counters.backgroundFinished;
  }
  get backgroundCaptured(): number {
    return this.counters.backgroundCaptured;
  }
  get backgroundPushed(): number {
    return this.counters.backgroundPushed;
  }
  get backgroundDelivered(): number {
    return this.counters.backgroundDelivered;
  }
  get childEventsFiltered(): number {
    return this.counters.childEventsFiltered;
  }
  get imagesInlined(): number {
    return this.counters.imagesInlined;
  }
  get imagesSkipped(): number {
    return this.counters.imagesSkipped;
  }
  get windowImagesInlined(): number {
    return this.counters.windowImagesInlined;
  }
  get windowImagesSkipped(): number {
    return this.counters.windowImagesSkipped;
  }
  get windowFilesFetched(): number {
    return this.counters.windowFilesFetched;
  }
  get windowForwardsExpanded(): number {
    return this.counters.windowForwardsExpanded;
  }
  get windowForwardsFailed(): number {
    return this.counters.windowForwardsFailed;
  }
  get forwardsExpanded(): number {
    return this.counters.forwardsExpanded;
  }
  get forwardNodesInlined(): number {
    return this.counters.forwardNodesInlined;
  }
  get forwardsFailed(): number {
    return this.counters.forwardsFailed;
  }
  get filesFetched(): number {
    return this.counters.filesFetched;
  }
  get filesExtracted(): number {
    return this.counters.filesExtracted;
  }
  get filesSavedOnly(): number {
    return this.counters.filesSavedOnly;
  }
  get filesSkipped(): number {
    return this.counters.filesSkipped;
  }
  get fileCharsInlined(): number {
    return this.counters.fileCharsInlined;
  }
  get repliesSent(): number {
    return this.counters.repliesSent;
  }
  get attachmentsSent(): number {
    return this.counters.attachmentsSent;
  }
  get progressSent(): number {
    return this.counters.progressSent;
  }
}
function assertCount(amount: number): void {
  if (!Number.isFinite(amount) || amount < 0)
    throw new RangeError('Statistics increments must be finite and nonnegative');
}

/**
 * health 端点展示用的完整快照：计数 + Task / lane 状态 + 谷时段闸状态。
 *
 * 三个 wait 相关字段被映射成**数字**（而不是原样透出对象）：
 * `dispatcher` 是 `/metrics` 的对外契约，字段全为数字是一条被 RUNBOOK
 * 依赖的形状约束——按理由拆开的分布另在 `proactive.waitDeclined` /
 * `proactive.waitTickets` 里给（见 health.ts）。
 */
export type { PipelineStatsSnapshot } from '@qqbot/contracts';
