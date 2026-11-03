/** 历史单轮实现的可写池替身；生产 RuntimePool 不提供此能力。 */
/** 历史单轮实现的可写池替身；生产 RuntimePool 不提供此能力。 */
import type { DshRuntime, DshRuntimeOptions } from '../../src/dsh/process.js';
import type { RuntimePool as CurrentRuntimePool } from '../../src/dsh/pool.js';

export interface RuntimeEntry {
  generation?: string;
  conversationKey: string;
  runtime: DshRuntime;
  sessionId: string;
  replayed: boolean;
  createdAt: number;
  lastUsedAt: number;
  busy: boolean;
  activeChildren: Set<string>;
}

export interface RuntimePool extends Pick<
  CurrentRuntimePool,
  'size' | 'activeConversationKeys' | 'on' | 'disposeAll'
> {
  acquire(
    conversationKey: string,
    workspacePath: string,
    overrides?: Partial<DshRuntimeOptions>
  ): Promise<RuntimeEntry>;
  release(conversationKey: string): void;
  drop(conversationKey: string): Promise<void>;
}
