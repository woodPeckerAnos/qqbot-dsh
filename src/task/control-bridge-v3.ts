import { failure, SYSTEM_CLOCK } from '@qqbot/contracts';
import type {
  AttachmentReference,
  DeepReadonly,
  JobExecutionV3,
  MessageQueue,
  QueuedMessage,
  Result,
  TaskControlBridgeV3 as ControlContract,
  TaskJobV3,
  TaskLifeCycleManagerV3,
  TaskSnapshotV3,
  WorkerAssignment,
  TaskQueryPageV1,
  TaskResultPageV1,
  TaskResultRequestV1,
  TaskQueryRequestV1,
  TaskSummaryV1,
  TaskQueryV3,
  createTaskControlBridgeFactoryV3,
} from '@qqbot/contracts';

/** 控制操作绑定原始输入和本次执行；保存接受请求后才向模型返回回执。 */
export class TaskControlBridgeV3 implements ControlContract {
  constructor(
    private readonly manager: TaskLifeCycleManagerV3,
    private readonly cancelTask: (taskId: string) => void,
    private readonly queue?: MessageQueue,
    private readonly services: NonNullable<Parameters<createTaskControlBridgeFactoryV3>[3]> = {}
  ) {}
  bind(
    caller: DeepReadonly<TaskSnapshotV3>,
    job: DeepReadonly<TaskJobV3>,
    execution: JobExecutionV3,
    handoff?: { attachments: AttachmentReference[]; constraints: string[] }
  ): ReturnType<ControlContract['bind']> {
    const operations: string[] = [];
    const current = (): Result<void> =>
      this.manager.matches(caller.taskId, job.jobId, execution)
        ? { ok: true, value: undefined }
        : { ok: false, error: failure('CANCELLED') };
    return {
      query: (taskId) => {
        const identity = current();
        if (!identity.ok) return identity;
        return this.query(caller, taskId);
      },
      querySummary: (request) => {
        const identity = current();
        return identity.ok ? this.querySummary(caller, request) : identity;
      },
      readResult: (request) => {
        const identity = current();
        return identity.ok ? this.readResult(caller, request) : identity;
      },
      cancel: (taskId) => {
        const identity = current();
        if (!identity.ok) return identity;
        const target = this.manager.get(taskId);
        if (!canCancel(caller, target)) return { ok: false, error: failure('NOT_FOUND') };
        const result = this.manager.cancel(taskId, caller.input.trace);
        if (result.ok && result.value) {
          this.cancelTask(taskId);
          operations.push(`已取消任务 ${taskId} 的未完成执行；已入队消息继续投递。`);
        }
        return result;
      },
      startWorker: (assignment) => {
        const identity = current();
        if (!identity.ok) return identity;
        return this.acceptWorker({ caller, job, execution, assignment, handoff, operations });
      },
    };
  }
  private acceptWorker(
    dispatch: WorkerDispatch
  ): ReturnType<ReturnType<ControlContract['bind']>['startWorker']> {
    const { caller, assignment, job, execution, handoff, operations } = dispatch;
    if (caller.input.progressOnly)
      return { ok: false, error: failure('INVALID_INPUT', '进度查询不能派发业务') };
    if (
      !authorizedWorkerAssignment(
        caller,
        assignment,
        this.manager.get(caller.input.followUpOf ?? '')
      )
    )
      return { ok: false, error: failure('INVALID_INPUT', '旧失败任务需要本次明确重试授权') };
    const quota = assignment.requiredCapabilities?.includes('web-search')
      ? this.services.search?.quotaFailure()
      : undefined;
    if (quota) return { ok: false, error: structuredClone(quota) };
    return this.manager.acceptWorker({
      taskId: caller.taskId,
      jobId: job.jobId,
      execution,
      assignment,
      attachments: handoff?.attachments,
      constraints: handoff?.constraints,
      controlOperations: operations,
    });
  }
  private querySummary(
    caller: DeepReadonly<TaskSnapshotV3>,
    request: TaskQueryRequestV1 = {}
  ): Result<TaskQueryPageV1> {
    if (request.limit !== undefined && !validInteger(request.limit, 1, 20))
      return { ok: false, error: failure('INVALID_INPUT', '查询数量必须在1到20之间') };
    const queried = this.query(caller, request.taskId);
    if (!queried.ok) return queried;
    const all = [...queried.value].sort((a, b) => b.creationSequence - a.creationSequence);
    const page: TaskQueryPageV1 = {
      schemaVersion: 1,
      tasks: all.slice(0, request.limit ?? 8).map(summary),
      total: all.length,
      truncated: all.length > (request.limit ?? 8),
      asOf: (this.services.clock ?? SYSTEM_CLOCK).now(),
    };
    while (serializedBytes(page) > QUERY_BYTES) {
      page.tasks.pop();
      page.truncated = true;
    }
    page.truncated ||= page.tasks.some(summaryTruncated);
    return { ok: true, value: page };
  }
  private readResult(
    caller: DeepReadonly<TaskSnapshotV3>,
    request: TaskResultRequestV1
  ): Result<TaskResultPageV1> {
    const task = this.manager.get(request.taskId);
    const offset = request.offset ?? 0;
    if (!validResultRequest(request)) return { ok: false, error: failure('INVALID_INPUT') };
    if (!task || !sameScope(caller, task, true)) return { ok: false, error: failure('NOT_FOUND') };
    if (request.resultVersion !== taskResultVersion(task))
      return { ok: false, error: failure('STALE_DATA') };
    const body = savedTaskBody(task, request.source);
    if (body === undefined) return { ok: false, error: failure('NOT_FOUND') };
    if (!validTextOffset(body, offset)) return { ok: false, error: failure('INVALID_INPUT') };
    return resultPage(task.taskId, request, body);
  }

  private query(
    caller: DeepReadonly<TaskSnapshotV3>,
    taskId?: string
  ): ReturnType<ReturnType<ControlContract['bind']>['query']> {
    const tasks = taskId
      ? [this.manager.get(taskId)].filter((task): task is DeepReadonly<TaskSnapshotV3> => !!task)
      : this.manager.list(caller.input.message.target.key);
    return {
      ok: true,
      value: tasks
        .filter((task) => sameScope(caller, task, taskId !== undefined))
        .map((task) => ({
          ...task,
          delivery: {
            ...(this.queue?.taskDelivery(task.taskId) ?? {
              success: false,
              pending: false,
              count: 0,
            }),
            status: queryDeliveryStatus(this.queue?.messages(task.taskId)),
            asOf: (this.services.clock ?? SYSTEM_CLOCK).now(),
          },
        })),
    };
  }
}

function queryDeliveryStatus(rows: DeepReadonly<QueuedMessage[]> | undefined) {
  if (!rows) return 'unknown' as const;
  if (!rows.length) return 'none' as const;
  if (rows.some((row) => row.outcome === 'unknown')) return 'unknown' as const;
  if (rows.some((row) => row.status === 'sending')) return 'sending' as const;
  if (rows.some((row) => row.status === 'pending')) return 'pending' as const;
  if (rows.some((row) => row.status === 'failed' || row.status === 'discarded'))
    return 'failed' as const;
  return 'sent' as const;
}

export function canCancel(
  caller: DeepReadonly<TaskSnapshotV3>,
  target: DeepReadonly<TaskSnapshotV3> | undefined
): boolean {
  if (!target || target.cancelAccepted) return false;
  if (target.input.message.target.key !== caller.input.message.target.key) return false;
  if (target.creationSequence >= caller.creationSequence) return false;
  if (caller.input.isAdmin) return true;
  // 主动 Task 没有“发起用户”：它的 sender 是触发时选中的原消息或合成上下文，
  // 与当前说“别查了”的人通常不同。同一会话内允许普通成员停止机器人尚未
  // 回复的主动工作，否则只能由管理员兜底。用户发起的 Task 仍只允许本人。
  return (
    target.input.source === 'proactive' ||
    target.input.message.senderId === caller.input.message.senderId
  );
}

const QUERY_BYTES = 48 * 1024;
function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify({ ok: true, value }), 'utf8');
}
function cut(text: string, length: number): string {
  return text.slice(0, length).replace(/[\uD800-\uDBFF]$/u, '');
}
function sameScope(
  caller: DeepReadonly<TaskSnapshotV3>,
  task: DeepReadonly<TaskSnapshotV3>,
  explicit: boolean
): boolean {
  return (
    task.input.message.target.key === caller.input.message.target.key &&
    task.input.generation === caller.input.generation &&
    (task.creationSequence < caller.creationSequence || (explicit && task.taskId === caller.taskId))
  );
}
function summary(task: DeepReadonly<TaskQueryV3>): TaskSummaryV1 {
  const error = task.worker?.result?.failure ?? task.frontend.failure;
  const question = cut(task.input.message.content, 500);
  return {
    taskId: task.taskId,
    status: task.status,
    phase: task.phase,
    createdAt: task.createdAt,
    endedAt: task.endedAt,
    question,
    questionOriginalChars: task.input.message.content.length,
    questionOmittedChars: task.input.message.content.length - question.length,
    worker: task.worker ? workerSummary(task.worker) : undefined,
    reply: task.finalReply ? bodySummary(task.finalReply.text) : undefined,
    failure: error ? { code: error.code, retry: error.retry } : undefined,
    delivery: { ...task.delivery },
  };
}
function bodySummary(body: string) {
  const text = cut(body, 1600);
  return { text, originalChars: body.length, omittedChars: body.length - text.length };
}
function workerSummary(
  worker: DeepReadonly<NonNullable<TaskSnapshotV3['worker']>>
): NonNullable<TaskSummaryV1['worker']> {
  const result = worker.result;
  const attachments = result?.attachments ?? [];
  return {
    status: worker.receipt.status,
    resultStatus: result?.status,
    resultVersion: worker.resultVersion,
    ...bodySummary(result?.text ?? ''),
    attachments: attachments.slice(0, 8).map((a) => cut(a.fileName, 120)),
    attachmentCount: attachments.length,
  };
}
function summaryTruncated(task: TaskSummaryV1): boolean {
  const worker = task.worker;
  if (worker && (worker.omittedChars > 0 || worker.attachmentCount > worker.attachments.length))
    return true;
  return Boolean(task.questionOmittedChars || task.reply?.omittedChars);
}
function taskResultVersion(task: DeepReadonly<TaskSnapshotV3>): number {
  return task.worker?.resultVersion ?? 0;
}
function savedTaskBody(
  task: DeepReadonly<TaskSnapshotV3>,
  source: TaskResultRequestV1['source']
): string | undefined {
  return source === 'worker' ? task.worker?.result?.text : task.finalReply?.text;
}

function validInteger(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function validResultRequest(request: TaskResultRequestV1): boolean {
  return (
    validInteger(request.offset ?? 0, 0) &&
    validInteger(request.resultVersion, 0) &&
    ['worker', 'reply'].includes(request.source)
  );
}
function validTextOffset(text: string, offset: number): boolean {
  return offset <= text.length && (offset === 0 || !/[\uDC00-\uDFFF]/u.test(text.charAt(offset)));
}
function resultPage(
  taskId: string,
  request: TaskResultRequestV1,
  body: string
): Result<TaskResultPageV1> {
  const offset = request.offset ?? 0;
  const page: TaskResultPageV1 = {
    schemaVersion: 1,
    taskId,
    resultVersion: request.resultVersion,
    source: request.source,
    offset,
    text: cut(body.slice(offset), 12_000),
    originalChars: body.length,
  };
  while (serializedBytes(page) > QUERY_BYTES) {
    if (!page.text) return { ok: false, error: failure('INVALID_INPUT', '结果标识超出查询容量') };
    page.text = cut(page.text, Math.floor(page.text.length * 0.8));
  }
  if (offset + page.text.length < body.length) page.nextOffset = offset + page.text.length;
  return { ok: true, value: page };
}
interface WorkerDispatch {
  caller: DeepReadonly<TaskSnapshotV3>;
  job: DeepReadonly<TaskJobV3>;
  execution: JobExecutionV3;
  assignment: WorkerAssignment;
  handoff?: { attachments: AttachmentReference[]; constraints: string[] };
  operations: string[];
}
function authorizedWorkerAssignment(
  caller: DeepReadonly<TaskSnapshotV3>,
  assignment: WorkerAssignment,
  previous: DeepReadonly<TaskSnapshotV3> | undefined
): boolean {
  if (assignment.retryOf !== caller.input.retryOf) return false;
  if (previous?.status !== 'failed' || caller.input.retryOf) return true;
  return derivedResultRequested(caller);
}

function derivedResultRequested(caller: DeepReadonly<TaskSnapshotV3>): boolean {
  const message = caller.input.message;
  const text = message.parts
    ? message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
    : message.content;
  return (
    /(?:基于|根据|用|把|依据|按).*(?:结果|材料|内容|正文|报告).*(?:补|说明|整理|导出|转成|转换|总结|制作|生成)/u.test(
      text
    ) &&
    !/["'“”‘’「」『』`]/u.test(text) &&
    !/(?:不要|不用|别|无需|不需要).*(?:补|说明|整理|导出|转成|转换|总结|制作|生成)/u.test(text)
  );
}
