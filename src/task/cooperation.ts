import { readonlySnapshot, isLaneTerminal } from '@qqbot/contracts';
import type {
  TaskCooperation as CooperationContract,
  TaskCooperationSnapshot,
  TaskLifeCycleManagerV3,
  MessageQueue,
  DeepReadonly,
  DshRuntimeOptions,
  RuntimeLease,
  TaskCooperationBinding,
} from '@qqbot/contracts';

/** fd 3 requests use the parent's execution identity, never model-provided authority. */
export function bindCooperationRequest(
  cooperation: CooperationContract | undefined,
  binding: Omit<TaskCooperationBinding, 'runtimeGeneration'>,
  currentLease: () => RuntimeLease | undefined,
  manager: TaskLifeCycleManagerV3,
  signal: AbortSignal,
  completed: AbortSignal
): DshRuntimeOptions['taskCooperation'] {
  if (!cooperation) return undefined;
  return (request, channelSignal) => {
    const lease = currentLease();
    if (!lease || signal.aborted || completed.aborted) throw new Error('协作执行身份已失效');
    const identity = { ...binding, runtimeGeneration: lease.generation };
    if (
      !Object.entries(identity).every(
        ([key, value]) => request[key as keyof TaskCooperationBinding] === value
      ) ||
      !manager.matches(binding.taskId, 'slow', identity)
    )
      throw new Error('协作执行身份不匹配');
    if (request.action === 'cooperation-read') return cooperation.read(binding.taskId);
    return cooperation.wait(binding.taskId, AbortSignal.any([signal, channelSignal, completed]));
  };
}

/** Read-only projection; neither execution nor delivery state is written here. */
export class TaskCooperation implements CooperationContract {
  private readonly listeners = new Map<
    string,
    Set<(snapshot: DeepReadonly<TaskCooperationSnapshot>) => void>
  >();
  private readonly snapshots = new Map<
    string,
    { fingerprint: string; value: TaskCooperationSnapshot }
  >();
  private readonly unsubscribe: (() => void)[];
  private closed = false;
  private readonly closeAbort = new AbortController();
  constructor(
    private readonly manager: TaskLifeCycleManagerV3,
    private readonly queue: MessageQueue
  ) {
    this.unsubscribe = [
      manager.onChange((task) => {
        this.publish(task.taskId);
      }),
      queue.onDelivery((result) => {
        this.publish(result.taskId);
      }),
    ];
  }
  read(taskId: string): DeepReadonly<TaskCooperationSnapshot> {
    this.assertOpen();
    const fast = this.manager.get(taskId)?.lanes.fast;
    const bodies = this.queue
      .messages(taskId)
      .filter(
        (row) =>
          row.candidate.lane === 'fast' &&
          !!row.candidate.body &&
          !row.candidate.notification &&
          !row.candidate.attachment
      )
      .flatMap((row) =>
        (
          row.candidate.body?.segments ?? [
            { text: row.candidate.text, index: row.candidate.body?.index ?? 0 },
          ]
        ).map((part) => ({
          messageId: row.id,
          text: part.text,
          status: row.status,
          error: row.error,
        }))
      );
    const fastStatus = fast?.status ?? 'cancelled';
    const ready =
      (!fast || isLaneTerminal(fast)) &&
      bodies.every((body) => body.status !== 'pending' && body.status !== 'sending');
    const fingerprint = JSON.stringify({ fastStatus, ready, bodies });
    const previous = this.snapshots.get(taskId);
    if (previous?.fingerprint === fingerprint) return readonlySnapshot(previous.value);
    const value: TaskCooperationSnapshot = {
      taskId,
      revision: (previous?.value.revision ?? 0) + 1,
      fastStatus,
      ready,
      bodies,
      delivered: bodies.filter((body) => body.status === 'sent'),
    };
    this.snapshots.set(taskId, { fingerprint, value });
    return readonlySnapshot(value);
  }
  subscribe(
    taskId: string,
    listener: (snapshot: DeepReadonly<TaskCooperationSnapshot>) => void
  ): () => void {
    if (this.closed) throw new Error('协作已关闭');
    const listeners = this.listeners.get(taskId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(taskId);
    };
  }
  wait(taskId: string, signal: AbortSignal): Promise<DeepReadonly<TaskCooperationSnapshot>> {
    if (this.closed || signal.aborted) return Promise.reject(new Error('协作等待已取消或关闭'));
    signal = AbortSignal.any([signal, this.closeAbort.signal]);
    return new Promise((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(new Error('协作等待已取消'));
      };
      const check = (snapshot: DeepReadonly<TaskCooperationSnapshot>) => {
        if (snapshot.ready) {
          cleanup();
          resolve(snapshot);
        }
      };
      const unsubscribe = this.subscribe(taskId, check);
      const cleanup = () => {
        unsubscribe();
        signal.removeEventListener('abort', abort);
      };
      signal.addEventListener('abort', abort, { once: true });
      check(this.read(taskId));
    });
  }
  private publish(taskId: string): void {
    if (this.closed || !this.listeners.has(taskId)) return;
    const snapshot = this.read(taskId);
    for (const listener of [...(this.listeners.get(taskId) ?? [])]) {
      try {
        listener(snapshot);
      } catch {
        /* Observers cannot prevent another subscriber's wait from resolving. */
      }
    }
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('协作已关闭');
  }
  forget(taskId: string): void {
    this.snapshots.delete(taskId);
  }
  close(): void {
    this.closed = true;
    this.closeAbort.abort();
    this.unsubscribe.forEach((fn) => {
      fn();
    });
    this.listeners.clear();
    this.snapshots.clear();
  }
}
