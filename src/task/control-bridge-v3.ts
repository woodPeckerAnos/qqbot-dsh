import { failure } from '@qqbot/contracts';
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
} from '@qqbot/contracts';

/** 控制操作绑定原始输入和本次执行；保存接受请求后才向模型返回回执。 */
export class TaskControlBridgeV3 implements ControlContract {
  constructor(
    private readonly manager: TaskLifeCycleManagerV3,
    private readonly cancelTask: (taskId: string) => void,
    private readonly queue?: MessageQueue
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
      startWorker: (assignment: WorkerAssignment) => {
        const identity = current();
        if (!identity.ok) return identity;
        return this.manager.acceptWorker({
          taskId: caller.taskId,
          jobId: job.jobId,
          execution,
          assignment,
          attachments: handoff?.attachments,
          constraints: handoff?.constraints,
          controlOperations: operations,
        });
      },
    };
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
        .filter((task) => task.input.message.target.key === caller.input.message.target.key)
        .map((task) => ({
          ...task,
          delivery: {
            ...(this.queue?.taskDelivery(task.taskId) ?? {
              success: false,
              pending: false,
              count: 0,
            }),
            status: queryDeliveryStatus(this.queue?.messages(task.taskId)),
            asOf: Date.now(),
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

function canCancel(
  caller: DeepReadonly<TaskSnapshotV3>,
  target: DeepReadonly<TaskSnapshotV3> | undefined
): boolean {
  return (
    !!target &&
    target.input.message.target.key === caller.input.message.target.key &&
    target.creationSequence < caller.creationSequence &&
    (caller.input.isAdmin || target.input.message.senderId === caller.input.message.senderId)
  );
}
