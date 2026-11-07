import type { EventEmitter } from 'node:events';
import type { DeepReadonly } from '../readonly.js';
import type { RuntimeHandle, RuntimePoolOptions } from './pool.js';
import type { DshRuntimeOptions } from './process.js';
import type {
  DshRuntimeV2,
  ExecutionBinding,
  ExecutionHandlers,
  ExecutionAck,
} from './execution.js';

export interface RuntimeHandleV2 extends RuntimeHandle {
  bindExecution(binding: ExecutionBinding, handlers: ExecutionHandlers): Promise<ExecutionAck>;
  unbindExecution(binding: ExecutionBinding): Promise<ExecutionAck>;
  cancelExecution(binding: ExecutionBinding): Promise<ExecutionAck>;
  quiesceExecution(binding: ExecutionBinding): Promise<ExecutionAck>;
}
export interface RuntimeLeaseV2 {
  readonly leaseId: string;
  readonly generation: string;
  readonly conversationKey: string;
  readonly sessionEpoch: number;
  readonly runtime: RuntimeHandleV2;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly replayed: boolean;
  readonly seq: number;
  readonly turn: number;
}
/** The shared execution gate constrains fast+slow; residence is unlimited. */
export interface RuntimeExecutionGate {
  acquire(signal?: AbortSignal): Promise<() => void>;
}
export type createRuntimeExecutionGateFactory = (capacity: number) => RuntimeExecutionGate;
export interface RuntimePoolOptionsV2 extends RuntimePoolOptions {
  runtimeFactory?: (options: DshRuntimeOptions) => DshRuntimeV2;
  executionGate?: RuntimeExecutionGate;
}
export interface RuntimePoolV2 extends EventEmitter {
  readonly size: number;
  activeConversationKeys(): string[];
  activeSubagents(): number;
  acquireLease(
    conversationKey: string,
    workspacePath: string,
    overrides?: Partial<DshRuntimeOptions>,
    signal?: AbortSignal,
    sessionEpoch?: number
  ): Promise<RuntimeLeaseV2>;
  /** Revoke old epochs synchronously, then close only this lane's resources. */
  reset(conversationKey: string, sessionEpoch: number): void;
  markReplayed(lease: RuntimeLeaseV2): void;
  release(lease: RuntimeLeaseV2): void;
  drop(lease: RuntimeLeaseV2): Promise<void>;
  snapshot(lease: RuntimeLeaseV2):
    | DeepReadonly<{
        busy: boolean;
        replayed: boolean;
        activeChildren: string[];
      }>
    | undefined;
  health(): DeepReadonly<{ resident: number; running: number; queued: number }>;
  disposeAll(): Promise<void>;
}
export type createRuntimePoolFactoryV2 = (options: RuntimePoolOptionsV2) => RuntimePoolV2;
