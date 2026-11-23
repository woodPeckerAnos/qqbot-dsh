import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TaskJobKindV3 } from '@qqbot/contracts';
import { loadConfigV3, writeModelApiPatch } from '../src/config/index.js';
import { createDshRuntime } from '../src/runtime/index.js';
import { createNullLogger } from '../src/observability/index.js';
import {
  buildTaskRuntimeBaseV3,
  buildTaskRuntimeEnvironmentV3,
  startTaskRuntimeCheckV3,
} from '../src/task/index.js';

const env = {
  BOT_CONNECTORS: 'onebot',
  ONEBOT_ACCESS_TOKEN: 'offline',
  DEEPSEEK_API_KEY: 'initialization-only-fake-key',
  ARC_CODE_API_KEY: 'initialization-only-fake-key',
  QWEN_INIT_TEST_KEY: 'initialization-only-fake-key',
};

function profileRuntime(
  root: string,
  role: TaskJobKindV3,
  provider: string,
  effort: 'medium' | 'high'
) {
  const config = loadConfigV3(env, {
    dsh: {
      bin: resolve('node_modules/.bin/dsh'),
      profilePatch: resolve('dsh-profile/cordis.patch.yml'),
    },
    paths: { dshHome: root },
    tasks: {
      taskProvider: provider,
      taskModel: provider === 'qwen-token-plan' ? 'qwen3.8-flash' : 'deepseek-flash',
      reasoningEffort: effort,
    },
    models: { providers: { 'qwen-token-plan': { apiKeyEnv: 'QWEN_INIT_TEST_KEY' } } },
  });
  const patch = writeModelApiPatch(config.modelApi, root)!;
  return createDshRuntime({
    ...buildTaskRuntimeBaseV3(config, [patch]),
    cwd: root,
    startTimeoutMs: 10000,
    shutdownTimeoutMs: 2000,
    logger: createNullLogger(),
    env: {
      ...env,
      ...buildTaskRuntimeEnvironmentV3(
        role,
        { taskId: 'init-only', executionId: 'init-only', sessionId: 'init-only' },
        config.tasks.frontendMaxSteps
      ),
    },
    taskControl: role === 'frontend' ? () => ({ ok: true, value: [] }) : undefined,
  });
}

describe('安装版 DSH 的 V3 profile（只初始化，不请求模型）', () => {
  it.each(['frontend', 'worker', 'summary'] as const)(
    '%s 角色默认 DeepSeek high 能启动并关闭',
    async (role) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-v3-profile-'));
      const runtime = profileRuntime(root, role, 'deepseek-official', 'high');
      try {
        const initialized = await runtime.start().catch((cause: unknown) => {
          throw new Error(runtime.recentStderr.join('\n'), { cause });
        });
        expect(initialized.serverInfo.name).toBe('deepseek-harness-sdk-runtime');
        expect(runtime.isReady).toBe(true);
      } finally {
        await runtime.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    15000
  );

  it.each(['frontend', 'worker', 'summary'] as const)(
    '%s 角色继承 Qwen 目录后 medium 初始化成功',
    async (role) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-v3-qwen-'));
      const runtime = profileRuntime(root, role, 'qwen-token-plan', 'medium');
      try {
        const checked = await startTaskRuntimeCheckV3(runtime, new AbortController().signal);
        expect(checked, runtime.recentStderr.join('\n')).toEqual({ ok: true, value: undefined });
        expect(runtime.serverInfo?.name).toBe('deepseek-harness-sdk-runtime');
        expect(runtime.state).toBe('closed');
      } finally {
        await runtime.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    15000
  );

  it('继承 Qwen 目录的 high 在初始化检查失败，模型请求尚未发送', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-v3-qwen-high-'));
    const runtime = profileRuntime(root, 'frontend', 'qwen-token-plan', 'high');
    try {
      const checked = await startTaskRuntimeCheckV3(runtime, new AbortController().signal);
      expect(checked).toMatchObject({
        ok: false,
        error: {
          code: 'UPSTREAM_FAILED',
          cause: {
            cause: {
              code: -32603,
              message: expect.stringContaining('does not support reasoning effort "high"'),
            },
          },
        },
      });
      expect(runtime.isReady).toBe(false);
      expect(runtime.state).toBe('closed');
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
});
