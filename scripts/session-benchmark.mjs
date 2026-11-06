import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function parse(args) {
  const options = {
    mode: 'offline',
    cases: [],
    seed: 42,
    full: false,
    strict: false,
    output: resolve('tmp/session-benchmark'),
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live') options.mode = 'live';
    else if (arg === '--full') options.full = true;
    else if (arg === '--strict') options.strict = true;
    else if (['--cases', '--repeat', '--seed', '--baseline', '--output'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--cases') options.cases = value.split(',').filter(Boolean);
      if (arg === '--repeat' || arg === '--seed') options[arg.slice(2)] = Number(value);
      if (arg === '--baseline') options.baseline = resolve(value);
      if (arg === '--output') options.output = resolve(value);
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 4294967295)
    throw new Error('seed must be uint32');
  if (
    options.repeat !== undefined &&
    (!Number.isSafeInteger(options.repeat) || options.repeat < 1 || options.repeat > 100)
  )
    throw new Error('repeat must be 1..100');
  return options;
}
try {
  const options = parse(process.argv.slice(2));
  const result = spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.session-benchmark.config.ts'],
    { stdio: 'inherit', env: { ...process.env, SESSION_BENCH_OPTIONS: JSON.stringify(options) } }
  );
  console.log(`Reports: ${options.output}/report.json and report.md`);
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
