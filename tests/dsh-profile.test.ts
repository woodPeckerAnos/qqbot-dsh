import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DshRuntime } from '../src/dsh/process.js';
import { createNullLogger } from '../src/logger.js';

describe('已安装 DSH 的 lane profile 初始化（无模型请求、无端口）', () => {
  it.each(['fast', 'slow'])(
    '%s profile 与 Task 插件可以实际启动',
    async (lane) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-profile-'));
      const runtime = new DshRuntime({
        bin: resolve('node_modules/.bin/dsh'),
        profilePatch: resolve('dsh-profile/cordis.patch.yml'),
        patches: [resolve('dsh-profile/lanes.patch.yml')],
        cwd: root,
        dshHome: root,
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        ...(lane === 'fast' ? { reasoningEffort: 'off' } : {}),
        startTimeoutMs: 10_000,
        shutdownTimeoutMs: 2000,
        logger: createNullLogger(),
        env: {
          DEEPSEEK_API_KEY: 'initialization-only-fake-key',
          ARC_CODE_API_KEY: 'initialization-only-fake-key',
          QQBOT_TASK_CHANNEL: '1',
          QQBOT_LANE: lane,
        },
        taskControl: () => [],
      });
      try {
        const initialized = await runtime.start();
        expect(initialized.serverInfo.name).toBe('deepseek-harness-sdk-runtime');
        expect(runtime.isReady).toBe(true);
      } finally {
        await runtime.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000
  );
});
