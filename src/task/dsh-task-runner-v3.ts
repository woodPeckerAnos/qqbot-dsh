import { failure, SYSTEM_CLOCK } from '@qqbot/contracts';
import type {
  AttachmentReference,
  ContractFailure,
  createDshTaskRunnerFactoryV3,
  DeepReadonly,
  FrontendReply,
  FrontendTurnResultV3,
  JobExecutionV3,
  Logger,
  MessageContext,
  OutgoingAttachment,
  PromptContentBlock,
  Result,
  RuntimeHandle,
  DshRuntimeOptions,
  RuntimeLease,
  SessionEventNotification,
  SessionEvent,
  SessionStatusNotification,
  SubagentFinishedNotification,
  SubagentStartedNotification,
  TaskClock,
  TaskJobV3,
  TaskRunnerV3,
  TaskSnapshotV3,
  TurnAccumulator,
  WorkerResult,
  WorkerServiceRequest,
  WorkerBudgetUpdate,
} from '@qqbot/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { scanOutbox } from '../media/index.js';
import { splitPersonaSections } from '../store/index.js';
import { createTurnAccumulator } from '../runtime/index.js';
import { renderSessionContextViewV3 } from '../session/index.js';
import { legacyTrace, traceSpan } from '../observability/index.js';
import { buildTaskRuntimeEnvironmentV3 } from './runtime-profile-v3.js';
import {
  failedTurn,
  failedWorker,
  recordTurnFailure,
  recordWorkerFailure,
  workerResultFromTurn,
  workerResultMessage,
} from './worker-outcome-v3.js';
import type { TurnDataV3, TurnResultV3 } from './worker-outcome-v3.js';

type RunnerOptions = Parameters<createDshTaskRunnerFactoryV3>[0];
type Task = DeepReadonly<TaskSnapshotV3>;
type Job = DeepReadonly<TaskJobV3>;
interface TurnWork {
  task: Task;
  job: Job;
  workspace: string;
  blocks: PromptContentBlock[];
  signal: AbortSignal;
  handoff?: { attachments: AttachmentReference[]; constraints: string[] };
}

/** 每个获准作业创建独立 runtime，进程与交付物收尾完成后才交回调度器。 */
export class DshTaskRunnerV3 implements TaskRunnerV3 {
  private readonly clock: TaskClock;
  constructor(private readonly options: RunnerOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }
  async runFrontend(
    task: Task,
    job: Job,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<Result<FrontendTurnResultV3>> {
    try {
      const prepared = await this.options.preparer.prepare(task, context);
      const workspace = await this.options.preparer.prepareWorkspace(task, 'frontend', job.jobId);
      const handoff = await this.readHandoff(task);
      const blocks: PromptContentBlock[] = [
        {
          type: 'text',
          text: replyFormatInstruction(context.policy.textFormat) + frontendInstruction(task),
        },
        ...prepared.blocks,
      ];
      this.appendContext(task, blocks);
      const turn = await this.runTurn({ task, job, workspace, blocks, signal, handoff });
      if (signal.aborted) return { ok: false, error: failure('CANCELLED') };
      if (this.options.manager.get(task.taskId)?.worker)
        return { ok: true, value: { kind: 'dispatched' } };
      if (turn.kind === 'failed') return { ok: false, error: turn.failure };
      if (turn.kind === 'dispatched') return { ok: true, value: turn };
      const reply = frontendReply(task, turn.data.text);
      return reply.ok ? { ok: true, value: { kind: 'reply', reply: reply.value } } : reply;
    } catch (error) {
      return this.failed(error, signal);
    }
  }
  async runWorker(
    task: Task,
    job: Job,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<Result<WorkerResult>> {
    if (!task.worker)
      return { ok: false, error: failure('INVALID_INPUT', '缺少已保存的worker请求') };
    try {
      const prepared = await this.options.preparer.prepare(task, context);
      const workspace = await this.options.preparer.prepareWorkspace(task, 'worker', job.jobId);
      const blocks: PromptContentBlock[] = [
        {
          type: 'text',
          text: workerInstruction(task, workspace, this.options.config.media.outboxDir),
        },
        ...prepared.blocks,
      ];
      this.appendContext(task, blocks);
      const turn = await this.runTurn({ task, job, workspace, blocks, signal });
      return {
        ok: true,
        value: await this.collectDeliverables(task, workspace, workerResultFromTurn(turn), signal),
      };
    } catch (error) {
      return {
        ok: true,
        value: failedWorker(this.failed(error, signal).error),
      };
    }
  }
  private async collectDeliverables(
    task: Task,
    workspace: string,
    initial: WorkerResult,
    signal: AbortSignal
  ): Promise<WorkerResult> {
    let result = initial;
    try {
      result = await this.scanDeliverables(task, workspace, result);
    } catch (error) {
      result = recordWorkerFailure(result, this.failed(error, signal).error);
    }
    return signal.aborted ? recordWorkerFailure(result, failure('CANCELLED')) : result;
  }
  private async scanDeliverables(
    task: Task,
    workspace: string,
    result: WorkerResult
  ): Promise<WorkerResult> {
    const directory = join(workspace, this.options.config.media.outboxDir);
    const root = await checkOutboxDirectory(workspace, directory);
    if (!root.ok) return recordWorkerFailure(result, root.error);
    if (!root.value) return result;
    // scanOutbox 的旧消费者允许目录读取降级；V3 需要明确保存读取故障。
    await readdir(root.value);
    const outbox = await scanOutbox(root.value, {
      maxFileBytes: this.options.config.media.maxFileBytes,
      imageExtensions: this.options.config.media.imageExtensions,
      logger: this.options.logger,
    });
    await this.addCheckedAttachments({ task, result, root: root.value, outbox });
    if (!outbox.skipped.length && !outbox.oversize.length) return result;
    result.unfinished.push(`无法交付：${[...outbox.skipped, ...outbox.oversize].join('、')}`);
    return recordWorkerFailure(result, failure('INVALID_INPUT', '交付物无效或超过容量'));
  }
  private async addCheckedAttachments(delivery: {
    task: Task;
    result: WorkerResult;
    root: string;
    outbox: Awaited<ReturnType<typeof scanOutbox>>;
  }): Promise<void> {
    const { task, result, root, outbox } = delivery;
    const seen = new Set<string>();
    for (const attachment of outbox.attachments) {
      if (/\.(?:txt|md|markdown|rst)$/iu.test(attachment.fileName) && !textDocumentRequested(task))
        continue;
      const canonicalPath = await realpath(attachment.absPath);
      if (seen.has(canonicalPath)) continue;
      seen.add(canonicalPath);
      attachment.absPath = canonicalPath;
      if (!(await validAttachment(attachment, this.options.config.media.maxFileBytes, root))) {
        outbox.skipped.push(attachment.fileName);
        continue;
      }
      result.attachments.push(attachment);
      result.evidence.push(`文件已检查：${attachment.fileName}（${attachment.sizeBytes}字节）。`);
    }
  }
  async runSummary(
    task: Task,
    job: Job,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<Result<FrontendReply>> {
    if (!task.worker?.result || task.worker.resultVersion !== job.resultVersion)
      return { ok: false, error: failure('STALE_DATA') };
    try {
      const workspace = await this.options.preparer.prepareWorkspace(task, 'summary', job.jobId);
      const rules = await readFile(join(workspace, 'AGENTS.md'), 'utf8');
      const material = replyFormatInstruction(context.policy.textFormat) + summaryInstruction(task);
      const capacity = this.options.preparer.summaryCapacity(task, material + rules);
      if (!capacity.ok) return capacity;
      const turn = await this.runTurn({
        task,
        job,
        workspace,
        blocks: [{ type: 'text', text: material }],
        signal,
      });
      if (turn.kind === 'failed') return { ok: false, error: turn.failure };
      if (turn.kind === 'dispatched') return { ok: false, error: failure('INVALID_INPUT') };
      const workerWorkspace = join(workspace, '..', 'worker');
      return await summaryReply(task, turn.data.text, {
        maxBytes: this.options.config.media.maxFileBytes,
        workerWorkspace,
        outboxDirectory: join(workerWorkspace, this.options.config.media.outboxDir),
      });
    } catch (error) {
      return this.failed(error, signal);
    }
  }
  private failed(error: unknown, signal: AbortSignal): { ok: false; error: ContractFailure } {
    return {
      ok: false,
      error: failure(
        signal.aborted ? 'CANCELLED' : 'UPSTREAM_FAILED',
        undefined,
        this.options.logger.cause(error, 'task-runtime-v3')
      ),
    };
  }
  private appendContext(task: Task, blocks: PromptContentBlock[]): void {
    if (!this.options.contextView || this.options.config.sessionContext?.mode === 'off') return;
    try {
      blocks.push({
        type: 'text',
        text: renderSessionContextViewV3(this.options.contextView.read(task)),
      });
    } catch (error) {
      // 旧结果是理解背景；读取故障不取消当前已经授权的请求。
      this.options.logger.warn('会话背景读取失败，继续处理当前请求', {
        taskId: task.taskId,
        errorId: this.options.logger.cause(error, 'session-context-read'),
      });
    }
  }
  private async readHandoff(
    task: Task
  ): Promise<{ attachments: AttachmentReference[]; constraints: string[] }> {
    const root = this.options.preparer.workspace(task);
    const inbox = join(root, this.options.config.attachments.files.inboxDir);
    const attachments = await readInputAttachments(inbox);
    const rules = await readOptionalFile(join(root, 'AGENTS.md'));
    return {
      attachments,
      constraints: [splitPersonaSections(rules).business.trim()].filter(Boolean),
    };
  }
  private async runTurn(work: TurnWork): Promise<TurnResultV3> {
    const pool = this.options.pools[work.job.kind === 'worker' ? 'worker' : 'frontend'];
    const control = controlExecution(work);
    const logger = executionLogger(this.options.logger, work, control);
    let result: TurnResultV3, lease: RuntimeLease | undefined;
    try {
      lease = await pool.acquireLease(
        `${work.job.sessionKey}:${work.job.kind}:${work.task.worker?.receipt.workerId ?? work.job.jobId}`,
        work.workspace,
        runtimeOptions(work, logger, this.options, control),
        work.signal
      );
      result = await this.sendTurnPrompt(work, lease, control, logger);
    } catch (error) {
      result = failedTurn(this.failed(error, work.signal).error, control.events?.partialData);
    }
    try {
      if (lease) await pool.drop(lease);
      result = closingTurn(result, control.events);
    } catch (error) {
      result = recordTurnFailure(result, this.failed(error, work.signal).error);
    } finally {
      control.events?.close();
      logger.finishExecution(control.executionId);
    }
    return work.signal.aborted ? recordTurnFailure(result, failure('CANCELLED')) : result;
  }
  private async sendTurnPrompt(
    work: TurnWork,
    lease: RuntimeLease,
    control: ControlExecution,
    logger: Logger
  ): Promise<TurnResultV3> {
    const bound = this.bindExecution(work, lease, control);
    if (!bound.ok) return failedTurn(bound.error);
    control.events = new TurnEventsV3(lease.runtime, createTurnAccumulator(control.sessionId), {
      work,
      execution: bound.value,
      options: this.options,
      clock: this.clock,
      logger,
    });
    return control.events.sendPrompt();
  }
  private bindExecution(
    work: TurnWork,
    lease: RuntimeLease,
    control: ControlExecution
  ): Result<JobExecutionV3> {
    const execution = {
      jobId: work.job.jobId,
      executionId: control.executionId,
      sessionId: control.sessionId,
      runtimeGeneration: lease.generation,
    };
    const bound = this.options.manager.bindExecution(work.task.taskId, work.job.jobId, execution);
    if (!bound.ok) return bound;
    Object.assign(control, {
      generation: lease.generation,
      controls: this.options.control.bind(work.task, work.job, execution, work.handoff),
    });
    return { ok: true, value: execution };
  }
}

/** Owned deferred prevents a late notification from changing the chosen turn result. */
class Deferred<T> {
  private resolveValue?: (value: T) => void;
  readonly promise: Promise<T> = new Promise((resolve) => {
    this.resolveValue = resolve;
  });
  get pending(): boolean {
    return !!this.resolveValue;
  }
  resolve(value: T): void {
    const resolve = this.resolveValue;
    this.resolveValue = undefined;
    resolve?.(value);
  }
}

interface TurnBindings {
  work: TurnWork;
  execution: JobExecutionV3;
  options: RunnerOptions;
  clock: TaskClock;
  logger: Logger;
}
interface ControlExecution {
  executionId: string;
  sessionId: string;
  dshSessionId: string;
  signal: AbortSignal;
  generation?: string;
  controls?: ReturnType<RunnerOptions['control']['bind']>;
  events?: TurnEventsV3;
}
function controlExecution(work: TurnWork): ControlExecution {
  const executionId = randomUUID();
  const sessionId = `task-${work.task.taskId}-${work.job.jobId}-${executionId}`;
  return { executionId, sessionId, dshSessionId: sessionId, signal: work.signal };
}
function executionLogger(logger: Logger, work: TurnWork, control: ControlExecution): Logger {
  return logger
    .withTrace(
      traceSpan(work.task.input.trace ?? legacyTrace(work.task.taskId), {
        taskId: work.task.taskId,
        ...control,
      })
    )
    .child({
      role: work.job.kind,
      jobId: work.job.jobId,
      workerId: work.task.worker?.receipt.workerId,
    });
}
function runtimeOptions(
  work: TurnWork,
  logger: Logger,
  options: RunnerOptions,
  control: ControlExecution
): Partial<DshRuntimeOptions> {
  return {
    logger,
    provider: options.config.tasks.taskProvider,
    model: options.config.tasks.taskModel,
    reasoningEffort: options.config.tasks.reasoningEffort,
    env: {
      QQBOT_WORKER_SERVICE_TIMEOUT_MS: String(options.config.tasks.slowTimeoutMs),
      QQBOT_WORKER_MAX_STEPS: String(options.config.tasks.workerMaxSteps),
      ...buildTaskRuntimeEnvironmentV3(
        work.job.kind,
        {
          taskId: work.task.taskId,
          executionId: control.executionId,
          sessionId: control.sessionId,
        },
        options.config.tasks.frontendMaxSteps
      ),
    },
    taskControl:
      work.job.kind === 'frontend'
        ? (request) => executeControlRequest(request, control)
        : undefined,
    workerServices:
      work.job.kind === 'worker'
        ? (request, signal) =>
            control.events?.service(request, signal) ??
            Promise.resolve({ ok: false, error: failure('CANCELLED') })
        : undefined,
    taskCooperation: undefined,
  };
}
function executeControlRequest(
  request: Parameters<NonNullable<DshRuntimeOptions['taskControl']>>[0],
  state: ControlExecution
): unknown {
  if (!authorizedControlRequest(request, state) || !state.controls)
    return { ok: false, error: failure('CANCELLED') };
  switch (request.action) {
    case 'query':
      return state.controls.query(request.taskId);
    case 'query-summary':
      return state.controls.querySummary(request.query);
    case 'read-result':
      return executeReadResult(request.resultRequest, state.controls);
    case 'cancel':
      return request.taskId
        ? state.controls.cancel(request.taskId)
        : { ok: false, error: failure('INVALID_INPUT') };
    case 'start-worker':
      return executeWorkerDispatch(request.assignment, state);
    default:
      return { ok: false, error: failure('INVALID_INPUT') };
  }
}
function executeReadResult(
  request: import('@qqbot/contracts').TaskResultRequestV1 | undefined,
  controls: NonNullable<ControlExecution['controls']>
): unknown {
  return request ? controls.readResult(request) : { ok: false, error: failure('INVALID_INPUT') };
}
function executeWorkerDispatch(
  assignment: import('@qqbot/contracts').WorkerAssignment | undefined,
  state: ControlExecution
): unknown {
  if (!assignment || !state.controls) return { ok: false, error: failure('INVALID_INPUT') };
  const result = state.controls.startWorker(assignment);
  if (result.ok) state.events?.dispatch();
  else if (quotaFailure(result.error)) state.events?.failContract(result.error);
  return result;
}
function authorizedControlRequest(
  request: Parameters<NonNullable<DshRuntimeOptions['taskControl']>>[0],
  state: ControlExecution
): boolean {
  return (
    !state.signal.aborted &&
    (state.events?.frontendToolAllowed ?? true) &&
    request.sessionId === state.sessionId &&
    request.executionId === state.executionId &&
    request.runtimeGeneration === state.generation
  );
}
/** Turn events and child membership have one owner and are released before the lease. */
class TurnEventsV3 {
  private readonly done = new Deferred<TurnResultV3>();
  private readonly children = new Map<string, string>();
  private childFailed = false;
  private collectingFailedMaterial = false;
  private lastSeq = -1;
  private readonly childSeq = new Map<string, number>();
  private readonly steps = new Set<string>();
  private readonly observedSteps = new Set<string>();
  private readonly knownURLs = new Set<string>();
  private fallbackFetches = 0;
  private budgetReason?: WorkerBudgetUpdate['reason'];
  private finalStep?: string;
  private searchDisabled = false;
  private softTimer?: ReturnType<TaskClock['setTimeout']>;
  private frontendStep = 0;
  private frontendCalls = 0;
  private readonly activeSteps = new Map<string, string>();
  private timer?: ReturnType<TaskClock['setTimeout']>;
  private readonly detachControlEvents: () => void;
  private readonly detachChannel?: () => void;
  constructor(
    private readonly runtime: RuntimeHandle,
    private readonly accumulator: TurnAccumulator,
    private readonly binding: TurnBindings
  ) {
    runtime.on('session.event', this.event);
    runtime.on('session.status', this.status);
    runtime.on('subagent.started', this.started);
    runtime.on('subagent.finished', this.finished);
    runtime.on('exit', this.exit);
    runtime.on('violation', this.violation);
    this.detachControlEvents = binding.options.manager.onEvent(this.accepted);
    for (const url of binding.work.task.input.message.content.match(/https?:\/\/[^\s<>，。]+/gu) ??
      [])
      this.knownURLs.add(normalizeURL(url));
    if (binding.work.job.kind === 'worker')
      this.softTimer = binding.clock.setTimeout(() => {
        this.finishBudget('time-budget');
      }, binding.options.config.tasks.slowTimeoutMs * binding.options.config.tasks.workerSoftTimeoutRatio);
    if (binding.work.job.kind === 'frontend' || binding.work.job.kind === 'worker')
      this.detachChannel = runtime.onTaskChannelClose?.(() => {
        this.fail('UPSTREAM_FAILED', '执行能力通道关闭');
      });
    binding.work.signal.addEventListener('abort', this.abort, { once: true });
    this.timer = binding.clock.setTimeout(
      () => {
        this.fail('TIMEOUT');
      },
      binding.work.job.kind === 'worker'
        ? binding.options.config.tasks.slowTimeoutMs
        : binding.options.config.tasks.fastTimeoutMs
    );
  }
  get frontendToolAllowed(): boolean {
    return (
      this.done.pending && this.frontendCalls < this.binding.options.config.tasks.frontendMaxSteps
    );
  }
  get partialData(): TurnDataV3 {
    return {
      text: this.accumulator.partialText,
      evidence: [`已记录工具调用：${this.accumulator.toolsInvoked}次。`],
      unfinished: this.searchDisabled
        ? ['本次搜索服务失败，只读取了已知来源；检索信息可能不完整。']
        : [],
    };
  }
  async service(request: WorkerServiceRequest, signal: AbortSignal): Promise<unknown> {
    if (
      !this.current() ||
      signal.aborted ||
      request.executionId !== this.binding.execution.executionId ||
      request.runtimeGeneration !== this.binding.execution.runtimeGeneration ||
      !this.member(request.sessionId)
    )
      return { ok: false, error: failure('CANCELLED') };
    switch (request.action) {
      case 'authorize-step':
        return this.authorizeStep(request);
      case 'authorize-fetch':
        return this.authorizeFetch(request.url);
      case 'search':
        return this.search(request, signal);
    }
  }
  private authorizeStep(request: WorkerServiceRequest): Result<{ kind: 'execute' | 'finish' }> {
    const id = workerStepKey(request);
    if (!id) return { ok: false, error: failure('INVALID_INPUT') };
    if (id === this.finalStep) return { ok: true, value: { kind: 'finish' } };
    if (this.steps.has(id)) return { ok: true, value: { kind: 'execute' } };
    if (!this.budgetReason && this.steps.size < this.binding.options.config.tasks.workerMaxSteps) {
      this.steps.add(id);
      return { ok: true, value: { kind: 'execute' } };
    }
    this.finishBudget(this.budgetReason ?? 'step-budget');
    if (request.sessionId !== this.binding.execution.sessionId || this.finalStep)
      return { ok: false, error: failure('CANCELLED', '业务阶段已结束') };
    this.finalStep = id;
    return { ok: true, value: { kind: 'finish' } };
  }
  private authorizeFetch(input: string | undefined): Result<void> {
    const url = input ? normalizeURL(input) : '';
    if (this.budgetReason) return { ok: false, error: failure('CANCELLED') };
    if (!this.searchDisabled) return { ok: true, value: undefined };
    if (!this.knownURLs.has(url) || this.fallbackFetches >= 3)
      return { ok: false, error: failure('INVALID_INPUT', '搜索故障后仅允许最多3个已知来源链接') };
    this.fallbackFetches++;
    return { ok: true, value: undefined };
  }
  private async search(request: WorkerServiceRequest, signal: AbortSignal): Promise<unknown> {
    const query = request.request;
    if (!query || typeof query.query !== 'string' || !query.query.trim())
      return { ok: false, error: failure('INVALID_INPUT') };
    if (this.budgetReason) return { ok: false, error: failure('CANCELLED') };
    const service = this.binding.options.search;
    if (this.searchDisabled || !service) {
      this.searchDisabled = true;
      return {
        ok: false,
        error: failure('UPSTREAM_FAILED', {
          kind: 'service-error',
          provider: 'search',
          message: '搜索服务暂不可用',
        }),
      };
    }
    const result = await service.search(query, signal);
    if (signal.aborted || !this.current()) return { ok: false, error: failure('CANCELLED') };
    return this.saveSearchOutcome(result);
  }
  private saveSearchOutcome(
    result: Awaited<ReturnType<NonNullable<RunnerOptions['search']>['search']>>
  ): unknown {
    if (result.ok) {
      for (const source of result.value.sources) this.knownURLs.add(normalizeURL(source.url));
      return result;
    }
    if (quotaFailure(result.error)) {
      this.finishBudget('quota-exhausted');
      this.failContract(result.error);
    } else this.searchDisabled = true;
    return result;
  }

  failContract(error: ContractFailure): void {
    this.collectingFailedMaterial ||= this.done.pending;
    this.done.resolve(failedTurn(error, this.partialData));
  }
  private member(sessionId: string): boolean {
    return sessionId === this.binding.execution.sessionId || this.children.has(sessionId);
  }
  private finishBudget(reason: WorkerBudgetUpdate['reason']): void {
    if (this.budgetReason) return;
    this.budgetReason = reason;
    this.runtime.notifyWorkerBudget?.({ kind: 'finish', reason, ...this.binding.execution });
  }
  dispatch(): void {
    this.done.resolve({ kind: 'dispatched' });
  }
  async sendPrompt(): Promise<TurnResultV3> {
    this.binding.logger.event('execution.started');
    if (this.binding.work.signal.aborted) this.abort();
    else
      void this.runtime
        .prompt(this.binding.execution.sessionId, this.binding.work.blocks)
        .catch((error: unknown) => {
          this.fail('UPSTREAM_FAILED', error);
        });
    const result = await this.done.promise;
    this.binding.logger.event('execution.ended', {
      resultKind: result.kind,
    });
    return result;
  }
  private current(): boolean {
    return (
      this.done.pending &&
      this.binding.options.manager.matches(
        this.binding.work.task.taskId,
        this.binding.work.job.jobId,
        this.binding.execution
      )
    );
  }
  private fail(code: ContractFailure['code'], cause?: unknown): void {
    this.collectingFailedMaterial ||= this.done.pending;
    this.done.resolve(failedTurn(failure(code, cause, this.runtime.lastErrorId), this.partialData));
  }
  private readonly abort = (): void => {
    this.fail('CANCELLED');
  };
  private readonly exit = (): void => {
    this.fail('UNKNOWN_OUTCOME');
  };
  private readonly violation = (): void => {
    this.fail('INVALID_INPUT');
  };
  private readonly accepted = (event: DeepReadonly<SessionEvent>): void => {
    if (
      event.type === 'worker-accepted' &&
      event.taskId === this.binding.work.task.taskId &&
      event.execution?.jobId === this.binding.work.job.jobId &&
      this.current()
    )
      this.dispatch();
  };
  private readonly event = (notification: SessionEventNotification): void => {
    const root = notification.sessionId === this.binding.execution.sessionId;
    if (!root) {
      this.observeChild(notification);
      return;
    }
    // Closing the same execution may commit an interrupted assistant body after cancellation.
    if (notification.event.seq <= this.lastSeq) return;
    this.lastSeq = notification.event.seq;
    if (!this.current()) {
      if (
        this.collectingFailedMaterial &&
        notification.event.type === 'assistant/message' &&
        isRecord(notification.event.data) &&
        notification.event.data.interrupted === true
      )
        this.accumulator.observe(notification.event);
      return;
    }
    this.observeStep(notification);
    this.recordModelCall(notification);
    if (!this.done.pending) return;
    if (!this.authorizedEvent(notification)) return;
    this.accumulator.observe(notification.event);
    this.finish();
  };
  private recordModelCall(notification: SessionEventNotification): void {
    if (
      this.binding.work.job.kind === 'worker' ||
      !['assistant/message', 'assistant/attempt'].includes(notification.event.type)
    )
      return;
    this.frontendCalls++;
    if (this.frontendCalls > this.binding.options.config.tasks.frontendMaxSteps)
      this.fail('INVALID_INPUT', { kind: 'frontend-call-budget' });
  }
  private observeChild(notification: SessionEventNotification): void {
    if (
      !this.current() ||
      !this.children.has(notification.sessionId) ||
      notification.event.seq <= (this.childSeq.get(notification.sessionId) ?? -1)
    )
      return;
    this.childSeq.set(notification.sessionId, notification.event.seq);
    this.observeStep(notification);
  }
  private authorizedEvent(notification: SessionEventNotification): boolean {
    if (
      this.binding.work.job.kind === 'worker' &&
      notification.event.type === 'tool/call' &&
      this.finalStep !== undefined &&
      this.activeSteps.get(notification.sessionId) === this.finalStep
    ) {
      this.fail('INVALID_INPUT', { kind: 'unauthorized-final-tool' });
      return false;
    }
    const max = this.binding.options.config.tasks.frontendMaxSteps;
    if (
      forbiddenEvent(notification, this.binding.work.job.kind, max) ||
      (this.binding.work.job.kind === 'frontend' &&
        notification.event.type === 'tool/call' &&
        (this.frontendStep >= max || this.frontendCalls >= max))
    ) {
      this.fail('INVALID_INPUT', {
        kind: 'unauthorized-tool',
        reason: '当前角色执行了未授权工具或超出调用上限',
      });
      return false;
    }
    return true;
  }
  private observeStep(notification: SessionEventNotification): void {
    const { type, data } = notification.event;
    if (type !== 'step/start' || !isRecord(data) || typeof data.step !== 'number') return;
    if (this.binding.work.job.kind !== 'worker') {
      this.frontendStep = data.step;
      return;
    }
    const turn = typeof data.turn === 'number' ? data.turn : 1;
    const id = `${notification.sessionId}:${turn}:${data.step}`;
    this.activeSteps.set(notification.sessionId, id);
    if (this.observedSteps.has(id)) return;
    this.observedSteps.add(id);
    if (id === this.finalStep) return;
    const granted = this.authorizeStep({
      action: 'authorize-step',
      ...this.binding.execution,
      sessionId: notification.sessionId,
      step: data.step,
      turn,
    });
    if (!granted.ok) this.failContract(failure('INVALID_INPUT', { kind: 'worker-step-budget' }));
  }

  private readonly status = (notification: SessionStatusNotification): void => {
    if (!this.current() || notification.sessionId !== this.binding.execution.sessionId) return;
    this.accumulator.observeStatus(notification.status);
    this.finish();
  };
  private readonly started = (notification: SubagentStartedNotification): void => {
    if (!this.current()) return;
    if (
      notification.parentSessionId === this.binding.execution.sessionId ||
      this.children.has(notification.parentSessionId)
    )
      this.children.set(notification.childSessionId, notification.parentSessionId);
  };
  private readonly finished = (notification: SubagentFinishedNotification): void => {
    if (
      !this.current() ||
      this.children.get(notification.childSessionId) !== notification.parentSessionId
    )
      return;
    this.children.delete(notification.childSessionId);
    this.childFailed ||= notification.status === 'error';
    this.finish();
  };
  private finish(): void {
    if (!this.accumulator.isSettled || this.children.size) return;
    const outcome = this.accumulator.result();
    if (this.budgetReason && this.budgetReason !== 'quota-exhausted') {
      this.fail('TIMEOUT', { kind: 'execution-budget', reason: this.budgetReason });
      return;
    }
    if (outcome.kind !== 'completed' || this.childFailed)
      this.fail('UPSTREAM_FAILED', {
        kind: this.childFailed ? 'child-failure' : 'turn-failure',
        reason: outcome.reason,
        // 上游给的原因要带到前台，才能在内容安全过滤等场景给出可理解的说明；
        // 不记录原始响应或提示词，只保留 DSH 的简短错误消息。
        ...(outcome.kind === 'error' && outcome.errorMessage !== undefined
          ? { message: outcome.errorMessage }
          : {}),
      });
    else
      this.done.resolve({
        kind: 'completed',
        data: {
          ...this.partialData,
          text: outcome.text,
          evidence: ['执行正常结束。', ...this.partialData.evidence],
        },
      });
  }
  close(): void {
    this.runtime.off('session.event', this.event);
    this.runtime.off('session.status', this.status);
    this.runtime.off('subagent.started', this.started);
    this.runtime.off('subagent.finished', this.finished);
    this.runtime.off('exit', this.exit);
    this.runtime.off('violation', this.violation);
    this.binding.work.signal.removeEventListener('abort', this.abort);
    this.detachControlEvents();
    this.detachChannel?.();
    if (this.timer) this.binding.clock.clearTimeout(this.timer);
    if (this.softTimer) this.binding.clock.clearTimeout(this.softTimer);
  }
}

function forbiddenEvent(
  notification: SessionEventNotification,
  role: Job['kind'],
  maxSteps: number
): boolean {
  const { type, data } = notification.event;
  if (role === 'worker') return false;
  if (type === 'step/start' && isRecord(data) && typeof data.step === 'number')
    return data.step > (role === 'summary' ? 1 : maxSteps);
  if (type !== 'tool/call') return false;
  if (role === 'summary') return true;
  return (
    !isRecord(data) ||
    !['query_tasks', 'read_task_result', 'cancel_task', 'start_worker'].includes(
      typeof data.name === 'string' ? data.name : ''
    )
  );
}

function replyFormatInstruction(format?: 'plain' | 'markdown'): string {
  return format === 'markdown'
    ? '当前通道支持基础Markdown。\n'
    : '当前通道展示纯文本，最终正文不用Markdown标题和强调标记；代码可用围栏标明，交付时保留代码内容。\n';
}
function frontendInstruction(task: Task): string {
  let followup = '';
  if (task.input.followUpOf) {
    let request = '按保存的旧结果理解本次要求，已有结果可引用，不重做旧业务。';
    if (task.input.progressOnly) request = '只回复进度，不重新执行业务。';
    if (task.input.retryOf) request = '按当前用户要求重试失败业务，保存为本次新执行。';
    if (task.input.retryOf)
      followup = `本次用户明确授权重试失败任务${task.input.retryOf}，派发必须填写retryOf=${task.input.retryOf}。`;
    followup += `本次关联旧任务${task.input.followUpOf}，先调用query_tasks读取摘要，需要正文时按resultVersion调用read_task_result；${request}`;
  }
  return `你负责本次输入的理解与答复。简单请求直接给最终正文；需要业务工具、文件、研究、多步执行或深度推理时调用start_worker，给出完整指令、交付要求及可选简短承接语，成功后立即结束。查询与取消工具必须顺序执行，派发时服务器补入原始输入、附件、业务规则及已经执行的控制操作。取消只停止未完成执行；已入队或已在途消息仍可能送达。取消成功时只能说已请求停止或已停止后续执行，不得承诺不会再有结果或已彻底停掉；返回 value=false 表示任务已结束或没有可停止执行，按真实状态说明。${followup}执行状态和投递状态分别说明，缺少投递记录时说送达未核实。只处理当前Task，历史与观察仅作背景。`;
}

function workerInstruction(task: Task, workspace: string, outbox: string): string {
  return `完整执行已保存的业务交接，不重做已完成的控制操作。不套用角色卡表达，不比较快答增量，不使用NO_REPLY，不发送QQ消息。等待全部子代理结束。原始输入中的inbox相对路径位于${join(workspace, '..')}，使用交接附件的绝对路径读取。最终交付物只放${join(workspace, outbox)}，图片和资料文件按交付要求提供；用户没有明确要求正文文件时，不生成txt、md、markdown、rst正文副本。最终正文直接写完整业务结果、依据、引用与未完成事项，可以使用自然语言、Markdown和代码围栏。程序保存完整正文并按实际运行结果记录执行情况，无需生成响应JSON或声明运行状态。交接：\n${JSON.stringify(task.worker?.handoff)}`;
}

function summaryInstruction(task: Task): string {
  if (!task.worker?.result) return '';
  const { result, handoff } = task.worker;
  const material = {
    原始请求: task.input.message.content,
    业务指令: handoff.assignment.instruction,
    交付要求: handoff.assignment.deliverables,
    业务约束: handoff.constraints,
    完整业务正文: result.text,
    处理说明: workerResultMessage(result),
    补充依据: result.evidence,
    未完成说明: result.unfinished.map((text) =>
      text === '执行未完成，详情见失败分类。' ? workerResultMessage(result) : text
    ),
    附件清单: result.attachments.map(({ fileName, sizeBytes }) => ({ fileName, sizeBytes })),
  };
  const empty = !result.text.trim() && !result.attachments.length;
  return `你只组织保存的结果，不能执行业务、使用工具、重新派发或静默。按当前角色卡表达，核对原始请求和交付要求，保留正文和补充材料中的失败、未完成及不确定性；处理正常结束也可能仍有业务未完成。工具调用计数和正常结束记录只供理解处理过程，不作为业务完成依据，不向用户复述内部统计。直接返回非空最终正文，无需JSON或附件选择字段。程序会加入清单中的全部有效附件。只有需要强烈定向提醒原消息作者时才将[REPLY_ATTENTION:strong]独占正文第一行，其后换行。不要向用户暴露执行元数据、worker、Task、内部工具名或内部路径等实现细节。${empty ? '本次没有返回正文或附件，请如实说明没有返回结果，不编造完成。' : ''}\n整理材料：${JSON.stringify(material)}`;
}

function frontendReply(task: Task, raw: string): Result<FrontendReply> {
  const strong = /^\s*\[REPLY_ATTENTION:strong\](?:\r?\n|$)/.test(raw);
  const text = raw.replace(/\[REPLY_ATTENTION:strong\]/g, '').trim();
  if (!text || text === 'NO_REPLY')
    return { ok: false, error: failure('INVALID_INPUT', '前台没有有效正文') };
  return {
    ok: true,
    value: { replyId: `reply-${task.taskId}`, text, attention: strong ? 'strong' : undefined },
  };
}

async function summaryReply(
  task: Task,
  raw: string,
  delivery: { maxBytes: number; workerWorkspace: string; outboxDirectory: string }
): Promise<Result<FrontendReply>> {
  const reply = frontendReply(task, raw);
  if (!reply.ok) return reply;
  const savedAttachments = task.worker?.result?.attachments ?? [];
  if (!savedAttachments.length) return { ok: true, value: { ...reply.value, attachments: [] } };
  const root = await checkOutboxDirectory(delivery.workerWorkspace, delivery.outboxDirectory);
  if (!root.ok) return root;
  if (!root.value) return { ok: false, error: failure('INVALID_INPUT', '整理附件目录已失效') };
  const attachments: OutgoingAttachment[] = [];
  for (const saved of savedAttachments) {
    if (!(await validAttachment(saved, delivery.maxBytes, root.value)))
      return { ok: false, error: failure('INVALID_INPUT', '整理附件已失效') };
    attachments.push({ ...saved });
  }
  return { ok: true, value: { ...reply.value, attachments } };
}

async function validAttachment(
  attachment: DeepReadonly<OutgoingAttachment>,
  maxBytes: number,
  directory: string
): Promise<boolean> {
  try {
    const path = await realpath(attachment.absPath);
    const info = await stat(path);
    return (
      path === attachment.absPath &&
      containsPath(directory, path) &&
      info.isFile() &&
      info.size === attachment.sizeBytes &&
      info.size > 0 &&
      info.size <= maxBytes
    );
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function checkOutboxDirectory(
  workspace: string,
  directory: string
): Promise<Result<string | undefined>> {
  const owner = await realpath(workspace);
  const root = await realpath(directory).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw error;
  });
  if (root && !containsPath(owner, root))
    return { ok: false, error: failure('INVALID_INPUT', '交付目录越出所属工作区') };
  return { ok: true, value: root };
}

function containsPath(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

async function readInputAttachments(inbox: string): Promise<AttachmentReference[]> {
  const root = await realpath(inbox).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw error;
  });
  if (!root) return [];
  const attachments: AttachmentReference[] = [];
  for (const name of await readdir(root)) {
    const path = await realpath(join(root, name));
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !(await stat(path)).isFile())
      throw new Error('输入附件越出所属目录');
    attachments.push({
      id: createHash('sha256').update(path).digest('hex').slice(0, 24),
      name,
      path,
    });
  }
  return attachments;
}

async function readOptionalFile(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (missing(error)) return '';
    throw error;
  }
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quotaFailure(error: DeepReadonly<ContractFailure>): boolean {
  return isRecord(error.cause) && error.cause.kind === 'quota-exhausted';
}
function normalizeURL(url: string): string {
  try {
    const value = new URL(url);
    value.hash = '';
    return ['http:', 'https:'].includes(value.protocol) ? value.href : '';
  } catch {
    return '';
  }
}
function textDocumentRequested(task: Task): boolean {
  if (task.worker?.handoff.assignment.deliveryIntent !== 'text-document') return false;
  const text = task.input.message.parts
    ? task.input.message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
    : task.input.message.content;
  return (
    /(?:txt|md|markdown|rst|文本文件|正文文件|报告文件|文档|文件版|文件报告)/iu.test(text) &&
    !/(?:不要|不用|别|无需|不需要).*(?:txt|md|markdown|rst|文件|文档)/iu.test(text)
  );
}

function closingTurn(turn: TurnResultV3, events: TurnEventsV3 | undefined): TurnResultV3 {
  return turn.kind === 'failed' && events ? failedTurn(turn.failure, events.partialData) : turn;
}

function validWorkerStep(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function workerStepKey(
  request: Pick<WorkerServiceRequest, 'sessionId' | 'step' | 'turn'>
): string | undefined {
  const turn = request.turn ?? 1;
  return validWorkerStep(request.step) && validWorkerStep(turn)
    ? `${request.sessionId}:${turn}:${request.step}`
    : undefined;
}
