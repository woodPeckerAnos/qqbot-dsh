import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/bench/session/session.bench.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});
