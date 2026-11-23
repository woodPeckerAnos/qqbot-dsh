import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDshRuntime } from '../src/runtime/index.js';
import { createNullLogger } from '../src/observability/index.js';

describe('安装版 DSH 的 V3 profile（只初始化，不请求模型）', () => {
  it.each(['frontend', 'worker', 'summary'])(
    '%s 角色完整 profile 能实际启动并关闭',
    async (role) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-v3-profile-'));
      const runtime = createDshRuntime({
        bin: resolve('node_modules/.bin/dsh'),
        profilePatch: resolve('dsh-profile/cordis.patch.yml'),
        patches: [resolve('dsh-profile/tasks-v3.patch.yml')],
        cwd: root,
        dshHome: root,
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        reasoningEffort: 'high',
        startTimeoutMs: 10000,
        shutdownTimeoutMs: 2000,
        logger: createNullLogger(),
        env: {
          DEEPSEEK_API_KEY: 'initialization-only-fake-key',
          ARC_CODE_API_KEY: 'initialization-only-fake-key',
          QQBOT_ROLE: role,
          QQBOT_TASK_CHANNEL: role === 'frontend' ? '1' : undefined,
        },
        taskControl: role === 'frontend' ? () => ({ ok: true, value: [] }) : undefined,
      });
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
});
