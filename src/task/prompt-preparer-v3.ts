import { failure } from '@qqbot/contracts';
import type {
  createPromptPreparerFactoryV3,
  DeepReadonly,
  MessageContext,
  PromptContentBlock,
  PromptPreparerV2,
  Result,
  TaskJobKindV3,
  TaskSnapshotV3,
  ConfigV3,
} from '@qqbot/contracts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspacePathFor, splitPersonaSections } from '../store/index.js';
import { PromptPreparer } from './prompt-preparer.js';

/** 复用同一次媒体摄取；规则在初始输入冻结，整理时重新读取当前人设。 */
export class PromptPreparerV3 extends PromptPreparer {
  constructor(private readonly dependencies: Parameters<createPromptPreparerFactoryV3>[0]) {
    super(dependencies);
  }
  override workspace(task: DeepReadonly<TaskSnapshotV3>): string {
    if (!/^[A-Za-z0-9_-]+$/.test(task.taskId)) throw new Error('无效 Task 工作区 ID');
    const session = workspacePathFor(this.dependencies.paths, task.input.message.target.key);
    const root = join(session, 'tasks', task.taskId);
    const rules = join(root, 'AGENTS.md');
    mkdirSync(root, { recursive: true });
    if (!existsSync(rules)) {
      const source = join(session, 'AGENTS.md');
      writeFileSync(rules, existsSync(source) ? readFileSync(source) : '');
    }
    return root;
  }
  override async prepare(
    task: DeepReadonly<TaskSnapshotV3>,
    context: MessageContext
  ): ReturnType<PromptPreparerV2['prepare']> {
    const root = join(
      workspacePathFor(this.dependencies.paths, task.input.message.target.key),
      'tasks',
      task.taskId
    );
    const file = join(root, 'input-prompt.json');
    const saved = await readRules(file);
    if (saved) return savedPrompt(saved);
    const prepared = await super.prepare(task, context);
    await writeFile(file, JSON.stringify(prepared.blocks));
    return prepared;
  }
  async prepareWorkspace(
    task: DeepReadonly<TaskSnapshotV3>,
    role: TaskJobKindV3,
    jobId: string
  ): Promise<string> {
    if (!jobId || !/^[A-Za-z0-9_-]+$/.test(task.taskId)) throw new Error('无效执行工作区 ID');
    const session = workspacePathFor(this.dependencies.paths, task.input.message.target.key);
    const root = join(session, 'tasks', task.taskId);
    const workspace = join(
      root,
      role === 'worker' ? 'worker' : createHash('sha256').update(jobId).digest('hex').slice(0, 24)
    );
    const rules = await this.readRoleRules(task, role, root, session);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, '.qqbot-task-root'), '');
    await writeFile(join(workspace, 'AGENTS.md'), rules);
    return workspace;
  }
  private async readRoleRules(
    task: DeepReadonly<TaskSnapshotV3>,
    role: TaskJobKindV3,
    root: string,
    session: string
  ): Promise<string> {
    const frozen = await readRules(join(root, 'AGENTS.md'));
    if (role === 'frontend') return frozen;
    const business =
      task.worker?.handoff.constraints.join('\n') || splitPersonaSections(frozen).business;
    if (role === 'worker') return business;
    const current = splitPersonaSections(await readRules(join(session, 'AGENTS.md'))).persona;
    return [business, current].filter(Boolean).join('\n');
  }
  summaryCapacity(_task: DeepReadonly<TaskSnapshotV3>, text: string): Result<void> {
    const { config, maxPromptChars } = this.dependencies;
    if (text.length > (maxPromptChars ?? 1_000_000))
      return { ok: false, error: failure('INVALID_INPUT', '整理材料超过配置容量') };
    if (Buffer.byteLength(text, 'utf8') > modelInputCapacity(config))
      return { ok: false, error: failure('INVALID_INPUT', '整理材料超过所选模型容量') };
    return { ok: true, value: undefined };
  }
}

function savedPrompt(raw: string): Awaited<ReturnType<PromptPreparerV2['prepare']>> {
  const blocks: unknown = JSON.parse(raw);
  if (!Array.isArray(blocks) || !blocks.every(isPromptBlock)) throw new Error('保存的输入材料无效');
  return {
    blocks,
    totalImages: 0,
    inlinedImages: 0,
    windowImagesInlined: 0,
    windowImagesSkipped: 0,
    windowFilesFetched: 0,
    files: { fetched: 0, extracted: 0, savedOnly: 0, skipped: 0, charsInlined: 0 },
  };
}

function isPromptBlock(value: unknown): value is PromptContentBlock {
  if (typeof value !== 'object' || value === null) return false;
  if (!('type' in value)) return false;
  if (value.type === 'text') return 'text' in value && typeof value.text === 'string';
  return isImageBlock(value);
}

function isImageBlock(
  value: object & { type: unknown }
): value is Extract<PromptContentBlock, { type: 'image' }> {
  return (
    value.type === 'image' &&
    'data' in value &&
    typeof value.data === 'string' &&
    'mimeType' in value &&
    typeof value.mimeType === 'string' &&
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mimeType)
  );
}

function inputCapacity(limits: { contextWindow?: number; maxTokens?: number }): number {
  return limits.contextWindow === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, limits.contextWindow - (limits.maxTokens ?? 8192) - 8192);
}
function deepseekInputCapacity(config: ConfigV3): number {
  const route = config.modelApi.deepseek;
  const model = route?.models?.find((entry) => entry.id === config.tasks.taskModel);
  return inputCapacity({
    contextWindow: model?.contextWindow ?? route?.defaultContextWindow,
    maxTokens: model?.maxTokens ?? route?.maxTokens,
  });
}
function modelInputCapacity(config: ConfigV3): number {
  if (config.tasks.taskProvider === 'deepseek-official') return deepseekInputCapacity(config);
  const provider = config.modelApi.providers[config.tasks.taskProvider];
  if (!provider) return Number.POSITIVE_INFINITY;
  const model =
    provider.models?.find((entry) => entry.id === config.tasks.taskModel) ??
    provider.modelOverrides?.[config.tasks.taskModel];
  return inputCapacity({
    contextWindow: model?.contextWindow ?? provider.defaultContextWindow,
    maxTokens: model?.maxTokens,
  });
}

async function readRules(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }
}
