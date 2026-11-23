import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/bench/frontend-worker/tasks-v3.bench.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 10000,
  },
});
