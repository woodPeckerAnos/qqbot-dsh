import type { DeepReadonly } from '../readonly.js';
import type { ConfigV3 } from '../config.js';
import type { Result } from '../errors.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { TaskJobKindV3, TaskSnapshotV3 } from './types-v3.js';
import type { PromptPreparerV2, createPromptPreparerFactoryV2 } from './prompt-preparer-v2.js';
export interface PromptPreparerV3 extends Pick<PromptPreparerV2, 'capture' | 'judge' | 'release'> {
  workspace(task: DeepReadonly<TaskSnapshotV3>): string;
  prepare(
    task: DeepReadonly<TaskSnapshotV3>,
    context: MessageContext
  ): ReturnType<PromptPreparerV2['prepare']>;
  prepareWorkspace(
    task: DeepReadonly<TaskSnapshotV3>,
    role: TaskJobKindV3,
    jobId: string
  ): Promise<string>;
  summaryCapacity(task: DeepReadonly<TaskSnapshotV3>, text: string): Result<void>;
  removeWorkspace(task: DeepReadonly<TaskSnapshotV3>): Promise<void>;
}
export type createPromptPreparerFactoryV3 = (
  deps: Omit<Parameters<createPromptPreparerFactoryV2>[0], 'config'> & {
    config: ConfigV3;
    maxPromptChars?: number;
  }
) => PromptPreparerV3;
