import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readonlySnapshot } from '@qqbot/contracts';
import type {
  DshRuntimeV2,
  DshRuntimeOptions,
  RuntimePoolOptionsV2,
  RuntimeLeaseV2,
  RuntimeHandleV2,
  RuntimeExecutionGate,
  ExecutionBinding,
  ExecutionHandlers,
  PromptContentBlock,
  DshRuntimeEvents,
} from '@qqbot/contracts';
import { DshRuntime } from './process.js';

/** Fair execution semaphore. Slots count executions, never resident processes. */
export class ExecutionGate implements RuntimeExecutionGate {
  private active = 0;
  private readonly queue: {
    signal?: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    abort: () => void;
  }[] = [];
  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('执行并发必须 >= 1');
  }
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          signal?.removeEventListener('abort', waiter.abort);
          reject(new Error('执行额度等待已取消'));
        },
      };
      if (signal?.aborted) {
        waiter.abort();
        return;
      }
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.queue.push(waiter);
      this.pump();
    });
  }
  private pump(): void {
    while (this.active < this.capacity && this.queue.length) {
      const waiter = this.queue.shift();
      if (!waiter) return;
      waiter.signal?.removeEventListener('abort', waiter.abort);
      this.active++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      });
    }
  }
}

interface Entry {
  key: string;
  epoch: number;
  generation: string;
  sessionId: string;
  runtime: DshRuntimeV2;
  ready: Promise<unknown>;
  createdAt: number;
  closing: boolean;
  occupied: boolean;
  disposal?: Promise<void>;
  lease?: RuntimeLeaseV2;
  replayed: boolean;
  seq: number;
  turn: number;
  children: Set<string>;
  disposers: (() => void)[];
}

/** One resident per session/lane. Reset fences are local to the selected key. */
export class PersistentRuntimePool extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  private readonly epochs = new Map<string, number>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly leases = new WeakMap<RuntimeLeaseV2, Entry>();
  private readonly releases = new WeakMap<RuntimeLeaseV2, () => void>();
  private readonly closeAbort = new AbortController();
  private readonly gate: RuntimeExecutionGate;
  private queued = 0;
  private readonly acquisitions = new Set<Promise<RuntimeLeaseV2>>();
  constructor(private readonly options: RuntimePoolOptionsV2) {
    super();
    this.gate = new ExecutionGate(options.maxRuntimes);
  }
  get size(): number {
    return this.entries.size;
  }
  activeConversationKeys(): string[] {
    return [...this.entries.keys()];
  }
  activeSubagents(): number {
    return [...this.entries.values()].reduce((n, e) => n + e.children.size, 0);
  }
  health() {
    return readonlySnapshot({
      resident: this.size,
      running: [...this.entries.values()].filter((e) => e.occupied).length,
      queued: this.queued,
    });
  }
  acquireLease(
    key: string,
    workspace: string,
    overrides: Partial<DshRuntimeOptions> = {},
    signal?: AbortSignal,
    epoch = 1
  ): Promise<RuntimeLeaseV2> {
    const work = this.acquire(key, workspace, overrides, signal, epoch);
    this.acquisitions.add(work);
    void work.then(
      () => this.acquisitions.delete(work),
      () => this.acquisitions.delete(work)
    );
    return work;
  }
  private async acquire(
    key: string,
    workspace: string,
    overrides: Partial<DshRuntimeOptions>,
    signal: AbortSignal | undefined,
    epoch: number
  ): Promise<RuntimeLeaseV2> {
    const combined = AbortSignal.any([this.closeAbort.signal, ...(signal ? [signal] : [])]);
    this.assertEpoch(key, epoch, combined);
    if (epoch > (this.epochs.get(key) ?? 1)) this.reset(key, epoch);
    this.queued++;
    let release: (() => void) | undefined;
    try {
      await this.closing.get(key);
      release = await this.reserve(combined);
      const entry = await this.readyEntry(key, workspace, overrides, epoch, combined);
      const lease = this.issueLease(entry);
      this.releases.set(lease, release);
      release = undefined;
      return lease;
    } finally {
      this.queued--;
      release?.();
    }
  }
  private assertEpoch(key: string, epoch: number, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (epoch < (this.epochs.get(key) ?? 1)) throw new Error('会话 epoch 已失效');
  }
  private async reserve(signal: AbortSignal): Promise<() => void> {
    const lane = await this.gate.acquire(signal);
    try {
      const total = await this.options.executionGate?.acquire(signal);
      return () => {
        total?.();
        lane();
      };
    } catch (error) {
      lane();
      throw error;
    }
  }
  private async readyEntry(
    key: string,
    workspace: string,
    overrides: Partial<DshRuntimeOptions>,
    epoch: number,
    signal: AbortSignal
  ): Promise<Entry> {
    await this.closing.get(key);
    this.assertEpoch(key, epoch, signal);
    const entry = await this.availableEntry(key, workspace, overrides, epoch);
    entry.occupied = true;
    try {
      await entry.ready;
      this.assertEpoch(key, epoch, signal);
      if (entry.closing || this.entries.get(key) !== entry) throw new Error('常驻 lane 已淘汰');
      return entry;
    } catch (error) {
      await this.dropEntry(entry);
      throw error;
    }
  }
  private async availableEntry(
    key: string,
    workspace: string,
    overrides: Partial<DshRuntimeOptions>,
    epoch: number
  ): Promise<Entry> {
    const entry = this.entries.get(key);
    if (entry?.occupied) throw new Error('常驻 lane 已占用');
    if (entry?.runtime.isReady) return entry;
    if (entry) await this.dropEntry(entry);
    return this.create(key, workspace, overrides, epoch);
  }
  private issueLease(entry: Entry): RuntimeLeaseV2 {
    const lease: RuntimeLeaseV2 = Object.freeze({
      leaseId: this.id(),
      generation: entry.generation,
      conversationKey: entry.key,
      sessionEpoch: entry.epoch,
      runtime: this.handle(entry, () => lease),
      sessionId: entry.sessionId,
      createdAt: entry.createdAt,
      replayed: entry.replayed,
      seq: entry.seq,
      turn: entry.turn,
    });
    entry.lease = lease;
    this.leases.set(lease, entry);
    return lease;
  }
  private handle(entry: Entry, lease: () => RuntimeLeaseV2): RuntimeHandleV2 {
    const runtime = entry.runtime;
    const assertCurrent = () => {
      if (this.current(lease()) !== entry) throw new Error('执行租约已失效');
    };
    const confirmed = (ack: import('@qqbot/contracts').ExecutionAck) => {
      if (ack.idle) entry.children.clear();
      return ack;
    };
    return Object.freeze({
      get isReady() {
        return runtime.isReady;
      },
      get state() {
        return runtime.state;
      },
      get pid() {
        return runtime.pid;
      },
      get lastErrorId() {
        return runtime.lastErrorId;
      },
      prompt: (sessionId: string, blocks: PromptContentBlock[]) => {
        assertCurrent();
        if (sessionId !== entry.sessionId) throw new Error('根 session 不匹配');
        return runtime.prompt(sessionId, structuredClone(blocks));
      },
      bindExecution: (binding: ExecutionBinding, handlers: ExecutionHandlers) => {
        assertCurrent();
        return runtime.bindExecution(binding, handlers);
      },
      unbindExecution: (binding: ExecutionBinding) => {
        assertCurrent();
        return runtime.unbindExecution(binding);
      },
      cancelExecution: (binding: ExecutionBinding) => {
        assertCurrent();
        return runtime.cancelExecution(binding).then(confirmed);
      },
      quiesceExecution: (binding: ExecutionBinding) => {
        assertCurrent();
        return runtime.quiesceExecution(binding).then(confirmed);
      },
      notifyTaskCooperation: (update: import('@qqbot/contracts').TaskCooperationUpdate) => {
        assertCurrent();
        runtime.notifyTaskCooperation(update);
      },
      ...this.eventCapabilities(runtime),
    });
  }
  private eventCapabilities(runtime: DshRuntimeV2) {
    return {
      onTaskChannelClose: (listener: () => void) =>
        runtime.onTaskChannelClose?.(listener) ?? (() => {}),
      on: <K extends keyof DshRuntimeEvents>(event: K, listener: DshRuntimeEvents[K]) => {
        runtime.on(event, listener);
      },
      off: <K extends keyof DshRuntimeEvents>(event: K, listener: DshRuntimeEvents[K]) => {
        runtime.off(event, listener);
      },
    };
  }
  reset(key: string, epoch: number): void {
    if (epoch <= (this.epochs.get(key) ?? 1)) return;
    this.epochs.set(key, epoch);
    const entry = this.entries.get(key);
    if (entry) void this.dropEntry(entry);
  }
  markReplayed(lease: RuntimeLeaseV2): void {
    const entry = this.current(lease);
    if (entry) entry.replayed = true;
  }
  release(lease: RuntimeLeaseV2): void {
    const entry = this.current(lease);
    if (!entry) return;
    if (entry.children.size) throw new Error('子代理尚未静止');
    entry.lease = undefined;
    entry.occupied = false;
    this.releases.get(lease)?.();
    this.releases.delete(lease);
  }
  async drop(lease: RuntimeLeaseV2): Promise<void> {
    const entry = this.leases.get(lease);
    if (entry && this.current(lease)) await this.dropEntry(entry);
    else await entry?.disposal;
  }
  snapshot(lease: RuntimeLeaseV2) {
    const entry = this.current(lease);
    return (
      entry &&
      readonlySnapshot({
        busy: !!entry.lease,
        replayed: entry.replayed,
        activeChildren: [...entry.children],
      })
    );
  }
  private current(lease: RuntimeLeaseV2): Entry | undefined {
    const entry = this.leases.get(lease);
    return entry && !entry.closing && entry.lease === lease && this.entries.get(entry.key) === entry
      ? entry
      : undefined;
  }
  private create(
    key: string,
    cwd: string,
    overrides: Partial<DshRuntimeOptions>,
    epoch: number
  ): Entry {
    const generation = this.id();
    const options: DshRuntimeOptions = {
      ...this.options.base,
      ...overrides,
      cwd,
      logger: this.options.logger.child({ conversation: key, runtimeGeneration: generation }),
      env: { ...this.options.base.env, ...overrides.env, QQBOT_RUNTIME_GENERATION: generation },
    };
    const runtime = this.options.runtimeFactory?.(options) ?? new DshRuntime(options);
    const entry: Entry = {
      key,
      epoch,
      generation,
      runtime,
      sessionId: `qq-${key.replace(/[^A-Za-z0-9._-]/g, '_')}-${generation}`,
      ready: Promise.resolve(),
      createdAt: this.options.now?.() ?? Date.now(),
      closing: false,
      occupied: true,
      replayed: false,
      seq: -1,
      turn: 0,
      children: new Set(),
      disposers: [],
    };
    this.entries.set(key, entry);
    this.wire(entry);
    entry.ready = Promise.resolve().then(() => runtime.start());
    return entry;
  }
  private wire(entry: Entry): void {
    const { runtime, key } = entry;
    const listen = <K extends keyof DshRuntimeEvents>(event: K, listener: DshRuntimeEvents[K]) => {
      runtime.on(event, listener);
      entry.disposers.push(() => {
        runtime.off(event, listener);
      });
    };
    listen('session.event', (n) => {
      if (n.sessionId === entry.sessionId && n.event.seq > entry.seq) {
        entry.seq = Math.max(entry.seq, n.event.seq);
        const turn = (n.event.data as { turn?: number }).turn;
        if (
          typeof turn === 'number' &&
          (n.event.type === 'turn/start' || n.event.type === 'turn/end')
        )
          entry.turn = Math.max(entry.turn, turn);
      }
      this.emit('session.event', key, n);
    });
    listen('subagent.started', (n) => {
      entry.children.add(n.childSessionId);
      this.emit('subagent.started', key, n);
    });
    listen('subagent.finished', (n) => {
      entry.children.delete(n.childSessionId);
      this.emit('subagent.finished', key, n);
    });
    listen('exit', (code, signal) => {
      this.emit('runtime.exit', key, code, signal);
    });
  }
  private dropEntry(entry: Entry): Promise<void> {
    if (entry.disposal) return entry.disposal;
    entry.closing = true;
    const lease = entry.lease;
    entry.lease = undefined;
    entry.disposal = (async () => {
      await entry.runtime.dispose().catch((error: unknown) => {
        this.options.logger.cause(error, 'runtime-dispose');
      });
      await entry.ready.catch(() => {});
      await entry.runtime.dispose().catch((error: unknown) => {
        this.options.logger.cause(error, 'runtime-dispose');
      });
      entry.disposers.forEach((fn) => {
        fn();
      });
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      if (lease) {
        this.releases.get(lease)?.();
        this.releases.delete(lease);
      }
    })();
    this.closing.set(entry.key, entry.disposal);
    void entry.disposal.then(() => {
      if (this.closing.get(entry.key) === entry.disposal) this.closing.delete(entry.key);
    });
    return entry.disposal;
  }
  async disposeAll(): Promise<void> {
    this.closeAbort.abort();
    await Promise.allSettled([...this.entries.values()].map((entry) => this.dropEntry(entry)));
    await Promise.allSettled([...this.acquisitions]);
  }
  private id(): string {
    return this.options.idFactory?.() ?? randomUUID();
  }
}
