import { it, expect } from 'vitest';
import { runBenchmark } from './runner.js';
import type { BenchmarkOptions } from './types.js';

it(
  'SessionActor benchmark',
  async () => {
    const raw = process.env.SESSION_BENCH_OPTIONS;
    if (!raw) throw new Error('Use npm run bench:session or bench:session:live');
    const report = await runBenchmark(JSON.parse(raw) as BenchmarkOptions);
    expect(report.passed, `See ${report.options.output}/report.md`).toBe(true);
  },
  24 * 60 * 60 * 1000
);
