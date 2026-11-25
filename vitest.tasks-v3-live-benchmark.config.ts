import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/bench/frontend-worker/live.bench.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 2 * 60 * 60 * 1000,
  },
});
