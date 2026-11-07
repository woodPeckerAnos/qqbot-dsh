import type { TaskCooperationRequest, TaskCooperationUpdate } from '../task/cooperation.js';
import type { DshRuntime } from './process.js';

/** Trusted host identity; targetTaskId is separate from the caller's taskId. */
export interface ExecutionBinding {
  readonly taskId: string;
  readonly executionId: string;
  readonly runtimeGeneration: string;
  readonly sessionId: string;
  readonly sessionEpoch: number;
}
export interface ExecutionControlRequest extends ExecutionBinding {
  readonly action: 'query' | 'cancel';
  readonly targetTaskId?: string;
}
export interface ExecutionHandlers {
  control(request: ExecutionControlRequest): unknown;
  cooperation?(request: TaskCooperationRequest, signal: AbortSignal): unknown;
}
export interface ExecutionAck {
  readonly binding: ExecutionBinding;
  readonly idle: boolean;
}
export interface DshRuntimeV2 extends DshRuntime {
  bindExecution(binding: ExecutionBinding, handlers: ExecutionHandlers): Promise<ExecutionAck>;
  unbindExecution(binding: ExecutionBinding): Promise<ExecutionAck>;
  cancelExecution(binding: ExecutionBinding): Promise<ExecutionAck>;
  quiesceExecution(binding: ExecutionBinding): Promise<ExecutionAck>;
  notifyTaskCooperation(update: TaskCooperationUpdate): void;
}
export type createDshRuntimeFactoryV2 = (
  options: import('./process.js').DshRuntimeOptions
) => DshRuntimeV2;
