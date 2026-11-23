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

type RunnerOptions = Parameters<createDshTaskRunnerFactoryV3>[0];
type Task = DeepReadonly<TaskSnapshotV3>;
type Job = DeepReadonly<TaskJobV3>;
interface TurnResult {
  text: string;
  failure?: ContractFailure;
  dispatched?: true;
}
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
        { type: 'text', text: frontendInstruction(task) },
        ...prepared.blocks,
      ];
      this.appendContext(task, blocks);
      const turn = await this.runTurn({ task, job, workspace, blocks, signal, handoff });
      if (signal.aborted) return { ok: false, error: failure('CANCELLED') };
      if (this.options.manager.get(task.taskId)?.worker)
        return { ok: true, value: { kind: 'dispatched' } };
      if (turn.failure) return { ok: false, error: turn.failure };
      const reply = frontendReply(task, turn.text);
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
        value: await this.collectDeliverables(workspace, workerResult(turn, signal)),
      };
    } catch (error) {
      return {
        ok: true,
        value: workerResult({ text: '', failure: this.failed(error, signal).error }, signal),
      };
    }
  }
  private async collectDeliverables(
    workspace: string,
    result: WorkerResult
  ): Promise<WorkerResult> {
    const outbox = await scanOutbox(join(workspace, this.options.config.media.outboxDir), {
      maxFileBytes: this.options.config.media.maxFileBytes,
      imageExtensions: this.options.config.media.imageExtensions,
      logger: this.options.logger,
    });
    result.attachments = outbox.attachments;
    if (outbox.skipped.length || outbox.oversize.length) {
      if (result.status === 'completed') result.status = 'failed';
      result.failure ??= failure('INVALID_INPUT', '交付物无效或超过容量');
      result.unfinished.push(`无法交付：${[...outbox.skipped, ...outbox.oversize].join('、')}`);
    }
    return result;
  }
  async runSummary(
    task: Task,
    job: Job,
    _context: MessageContext,
    signal: AbortSignal
  ): Promise<Result<FrontendReply>> {
    if (!task.worker?.result || task.worker.resultVersion !== job.resultVersion)
      return { ok: false, error: failure('STALE_DATA') };
    try {
      const workspace = await this.options.preparer.prepareWorkspace(task, 'summary', job.jobId);
      const rules = await readFile(join(workspace, 'AGENTS.md'), 'utf8');
      const material = summaryInstruction(task);
      const capacity = this.options.preparer.summaryCapacity(task, material + rules);
      if (!capacity.ok) return capacity;
      const turn = await this.runTurn({
        task,
        job,
        workspace,
        blocks: [{ type: 'text', text: material }],
        signal,
      });
      if (turn.failure) return { ok: false, error: turn.failure };
      return await summaryReply(task, turn.text, this.options.config.media.maxFileBytes);
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
  private async runTurn(work: TurnWork): Promise<TurnResult> {
    const pool = this.options.pools[work.job.kind === 'worker' ? 'worker' : 'frontend'];
    const control = controlExecution(work);
    const logger = executionLogger(this.options.logger, work, control);
    let lease: RuntimeLease | undefined;
    try {
      work.signal.throwIfAborted();
      lease = await pool.acquireLease(
        `${work.job.sessionKey}:${work.job.kind}:${work.task.worker?.receipt.workerId ?? work.job.jobId}`,
        work.workspace,
        runtimeOptions(work, logger, this.options, control),
        work.signal
      );
      const bound = this.bindExecution(work, lease, control);
      if (!bound.ok) return { text: '', failure: bound.error };
      control.events = new TurnEventsV3(lease.runtime, createTurnAccumulator(control.sessionId), {
        work,
        execution: bound.value,
        options: this.options,
        clock: this.clock,
        logger,
      });
      return await control.events.sendPrompt();
    } catch (error) {
      return {
        text: control.events?.partialText ?? '',
        failure: this.failed(error, work.signal).error,
      };
    } finally {
      control.events?.close();
      if (lease) await pool.drop(lease);
      logger.finishExecution(control.executionId);
    }
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
    env: buildTaskRuntimeEnvironmentV3(
      work.job.kind,
      { taskId: work.task.taskId, executionId: control.executionId, sessionId: control.sessionId },
      options.config.tasks.frontendMaxSteps
    ),
    taskControl:
      work.job.kind === 'frontend'
        ? (request) => executeControlRequest(request, control)
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
    case 'cancel':
      return request.taskId
        ? state.controls.cancel(request.taskId)
        : { ok: false, error: failure('INVALID_INPUT') };
    case 'start-worker': {
      if (!request.assignment) return { ok: false, error: failure('INVALID_INPUT') };
      const result = state.controls.startWorker(request.assignment);
      if (result.ok) state.events?.dispatch();
      return result;
    }
    default:
      return { ok: false, error: failure('INVALID_INPUT') };
  }
}
function authorizedControlRequest(
  request: Parameters<NonNullable<DshRuntimeOptions['taskControl']>>[0],
  state: ControlExecution
): boolean {
  return (
    !state.signal.aborted &&
    request.sessionId === state.sessionId &&
    request.executionId === state.executionId &&
    request.runtimeGeneration === state.generation
  );
}
/** Turn events and child membership have one owner and are released before the lease. */
class TurnEventsV3 {
  private readonly done = new Deferred<TurnResult>();
  private readonly children = new Map<string, string>();
  private childFailed = false;
  private lastSeq = -1;
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
    if (binding.work.job.kind === 'frontend')
      this.detachChannel = runtime.onTaskChannelClose?.(() => {
        this.fail('UPSTREAM_FAILED', '前台控制通道关闭');
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
  get partialText(): string {
    return this.accumulator.partialText;
  }
  dispatch(): void {
    this.done.resolve({ text: '', dispatched: true });
  }
  async sendPrompt(): Promise<TurnResult> {
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
      resultKind: result.failure ? 'failed' : 'reply',
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
    this.done.resolve({
      text: this.partialText,
      failure: failure(code, cause, this.runtime.lastErrorId),
    });
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
    if (
      !this.current() ||
      notification.sessionId !== this.binding.execution.sessionId ||
      notification.event.seq <= this.lastSeq
    )
      return;
    this.lastSeq = notification.event.seq;
    if (
      forbiddenEvent(
        notification,
        this.binding.work.job.kind,
        this.binding.options.config.tasks.frontendMaxSteps
      )
    ) {
      this.fail('INVALID_INPUT', '当前角色执行了未授权工具或超出step上限');
      return;
    }
    this.accumulator.observe(notification.event);
    this.finish();
  };
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
    if (outcome.kind !== 'completed' || this.childFailed)
      this.fail('UPSTREAM_FAILED', outcome.reason);
    else this.done.resolve({ text: outcome.text });
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
    !['query_tasks', 'cancel_task', 'start_worker'].includes(
      typeof data.name === 'string' ? data.name : ''
    )
  );
}

function frontendInstruction(task: Task): string {
  let followup = '';
  if (task.input.followUpOf) {
    const request = task.input.progressOnly
      ? '只回复进度，不重新执行业务。'
      : '按保存的旧结果理解本次要求，已有结果可引用，不重做旧业务。';
    followup = `本次关联旧任务${task.input.followUpOf}，先调用query_tasks；${request}`;
  }
  return `你负责本次输入的理解与答复。简单请求直接给最终正文；需要业务工具、文件、研究、多步执行或深度推理时调用start_worker，给出完整指令、交付要求及可选简短承接语，成功后立即结束。查询与取消工具必须顺序执行，派发时服务器补入原始输入、附件、业务规则及已经执行的控制操作。${followup}执行状态和投递状态分别说明，缺少投递记录时说送达未核实。只处理当前Task，历史与观察仅作背景。`;
}

function workerInstruction(task: Task, workspace: string, outbox: string): string {
  return `完整执行已保存的业务交接，不重做已完成的控制操作。不套用角色卡表达，不比较快答增量，不使用NO_REPLY，不发送QQ消息。等待全部子代理结束。原始输入中的inbox相对路径位于${join(workspace, '..')}，使用交接附件的绝对路径读取。最终交付物只放${join(workspace, outbox)}。返回完整业务结果、证据与未完成事项；最终正文必须是严格JSON {"status":"completed|failed|unknown","text":"完整业务结果","evidence":["可核对证据"],"unfinished":["未完成事项"]}。交接：\n${JSON.stringify(task.worker?.handoff)}`;
}

function summaryInstruction(task: Task): string {
  const result = task.worker?.result;
  return `你只组织保存结果，不能执行业务、工具、重新派发或静默。按当前AGENTS.md角色卡表达，核对原始请求和交付要求，保留失败、未完成及未知状态。返回严格JSON {"text":"最终回复正文","attention":"strong（可省略）","attachmentIds":["选择交付的附件ID"]}，不得返回路径或虚构附件ID。没有附件时attachmentIds为[]。原始请求：${JSON.stringify(task.input)}\n交接：${JSON.stringify(task.worker?.handoff)}\n完整业务结果：${JSON.stringify(result)}\n附件清单：${JSON.stringify(result?.attachments.map((attachment) => ({ id: attachmentId(attachment), fileName: attachment.fileName, sizeBytes: attachment.sizeBytes })))}`;
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

function workerResult(turn: TurnResult, signal: AbortSignal): WorkerResult {
  const parsed = parseWorkerText(turn.text);
  const result: WorkerResult = {
    status: 'completed',
    text: turn.text.trim(),
    evidence: [],
    attachments: [],
    unfinished: [],
  };
  if (parsed) Object.assign(result, parsed);
  else {
    result.status = 'failed';
    result.failure = failure('INVALID_INPUT', 'worker结果缺少证据或未完成事项字段');
  }
  if (!result.text || result.text === 'NO_REPLY') {
    result.status = 'failed';
    result.failure = failure('INVALID_INPUT', 'worker没有完整结果');
  }
  if (turn.failure) {
    result.status = turn.failure.code === 'UNKNOWN_OUTCOME' ? 'unknown' : 'failed';
    result.failure = turn.failure;
  }
  if (signal.aborted) {
    result.status = 'cancelled';
    result.failure = failure('CANCELLED');
  }
  return result;
}

function parseWorkerText(
  raw: string
): Pick<WorkerResult, 'status' | 'text' | 'evidence' | 'unfinished'> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  if (
    !isRecord(value) ||
    typeof value.text !== 'string' ||
    !isStrings(value.evidence) ||
    !isStrings(value.unfinished) ||
    !['completed', 'failed', 'unknown'].includes(String(value.status))
  )
    return;
  return {
    status: value.status as 'completed' | 'failed' | 'unknown',
    text: value.text,
    evidence: value.evidence,
    unfinished: value.unfinished,
  };
}

async function summaryReply(
  task: Task,
  raw: string,
  maxBytes: number
): Promise<Result<FrontendReply>> {
  const value = parseSummarySelection(raw);
  if (!value) return { ok: false, error: failure('INVALID_INPUT', '整理结果无效或静默') };
  const attachments: OutgoingAttachment[] = [];
  for (const id of new Set(value.attachmentIds)) {
    const saved = task.worker?.result?.attachments.find(
      (attachment) => attachmentId(attachment) === id
    );
    if (!saved || !(await validAttachment(saved, maxBytes)))
      return { ok: false, error: failure('INVALID_INPUT', '整理选择了无效附件') };
    attachments.push({ ...saved });
  }
  return {
    ok: true,
    value: {
      replyId: `reply-${task.taskId}`,
      text: value.text.trim(),
      attention: value.attention,
      attachments,
    },
  };
}

interface SummarySelection {
  text: string;
  attention?: 'strong';
  attachmentIds: string[];
}
function parseSummarySelection(raw: string): SummarySelection | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(value) || !isStrings(value.attachmentIds) || typeof value.text !== 'string') return;
  if (!value.text.trim() || value.text.trim() === 'NO_REPLY') return;
  if (value.attention !== undefined && value.attention !== 'strong') return;
  return { text: value.text, attention: value.attention, attachmentIds: value.attachmentIds };
}

function attachmentId(attachment: DeepReadonly<OutgoingAttachment>): string {
  return createHash('sha256')
    .update(JSON.stringify([attachment.absPath, attachment.fileName, attachment.sizeBytes]))
    .digest('hex')
    .slice(0, 24);
}

async function validAttachment(
  attachment: DeepReadonly<OutgoingAttachment>,
  maxBytes: number
): Promise<boolean> {
  try {
    const path = await realpath(attachment.absPath);
    const info = await stat(path);
    return (
      path === attachment.absPath &&
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
function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}
