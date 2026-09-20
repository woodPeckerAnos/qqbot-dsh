import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 全部单测必须离线可跑：不触网、不起 DSH 子进程。
    testTimeout: 15_000,
  },
});
