import type { ConfigV3 } from '../config.js';
import type { RuntimePoolOptions } from '../dsh/pool.js';
import type { DshRuntime } from '../dsh/process.js';
import type { Result } from '../errors.js';
import type { TaskJobKindV3 } from './types-v3.js';

/** 与正常 Task 共用模型、patch 顺序和初始化/关闭时限。 */
export type buildTaskRuntimeBaseV3 = (
  config: ConfigV3,
  modelPatches?: readonly string[]
) => RuntimePoolOptions['base'];
export interface TaskRuntimeIdentityV3 {
  taskId: string;
  executionId: string;
  sessionId: string;
}
export type buildTaskRuntimeEnvironmentV3 = (
  role: TaskJobKindV3,
  identity: TaskRuntimeIdentityV3,
  frontendMaxSteps: number
) => Record<string, string | undefined>;
/** 仅初始化并关闭；失败保留分类和根因，关闭故障同样阻止启动。 */
export type startTaskRuntimeCheckV3 = (
  runtime: Pick<DshRuntime, 'start' | 'dispose' | 'lastErrorId'>,
  signal: AbortSignal
) => Promise<Result<void>>;
