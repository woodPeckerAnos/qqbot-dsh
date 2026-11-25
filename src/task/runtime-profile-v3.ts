import { failure, JsonRpcRequestTimeoutError, LoggedError } from '@qqbot/contracts';
import type {
  ContractFailure,
  Result,
  buildTaskRuntimeBaseV3 as BuildBase,
  buildTaskRuntimeEnvironmentV3 as BuildEnvironment,
  startTaskRuntimeCheckV3 as StartCheck,
} from '@qqbot/contracts';
import { fileURLToPath } from 'node:url';

export const buildTaskRuntimeBaseV3: BuildBase = (config, modelPatches = []) => ({
  bin: config.dsh.bin,
  profilePatch: config.dsh.profilePatch,
  patches: [
    ...modelPatches,
    fileURLToPath(new URL('../../dsh-profile/tasks-v3.patch.yml', import.meta.url)),
  ],
  dshHome: config.paths.dshHome,
  provider: config.tasks.taskProvider,
  model: config.tasks.taskModel,
  reasoningEffort: config.tasks.reasoningEffort,
  startTimeoutMs: config.dsh.runtimeStartTimeoutMs,
  shutdownTimeoutMs: config.dsh.runtimeShutdownTimeoutMs,
});

export const buildTaskRuntimeEnvironmentV3: BuildEnvironment = (
  role,
  identity,
  frontendMaxSteps
) => ({
  QQBOT_ROLE: role,
  QQBOT_TASK_CHANNEL: role === 'frontend' ? '1' : undefined,
  QQBOT_WORKER_CHANNEL: role === 'worker' ? '1' : undefined,
  QQBOT_TASK_ID: identity.taskId,
  QQBOT_EXECUTION_ID: identity.executionId,
  QQBOT_ROOT_SESSION_ID: identity.sessionId,
  QQBOT_FRONTEND_MAX_STEPS: String(frontendMaxSteps),
});

export const startTaskRuntimeCheckV3: StartCheck = async (runtime, signal) => {
  let result: Result<void>;
  try {
    signal.throwIfAborted();
    await runtime.start(signal);
    signal.throwIfAborted();
    result = { ok: true, value: undefined };
  } catch (cause) {
    result = { ok: false, error: runtimeCheckFailure(cause, signal, runtime.lastErrorId) };
  }
  try {
    await runtime.dispose();
  } catch (cause) {
    const error = result.ok
      ? runtimeCheckFailure(cause, signal, runtime.lastErrorId)
      : failure(
          result.error.code,
          new AggregateError([result.error.cause, cause], '初始化失败，关闭 runtime 也失败'),
          result.error.errorId
        );
    return { ok: false, error };
  }
  if (result.ok && signal.aborted)
    return { ok: false, error: runtimeCheckFailure(signal.reason, signal, runtime.lastErrorId) };
  return result;
};

function runtimeCheckFailure(
  cause: unknown,
  signal: AbortSignal,
  errorId?: string
): ContractFailure {
  const root = cause instanceof LoggedError ? cause.cause : cause;
  if (signal.aborted) return failure('CANCELLED', cause, errorId);
  return failure(
    root instanceof JsonRpcRequestTimeoutError ? 'TIMEOUT' : 'UPSTREAM_FAILED',
    cause,
    errorId
  );
}
