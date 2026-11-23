import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let output = resolve(root, 'docs/benchmarks/tasks-v3-v1');
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg !== '--output' || !args[index + 1]) throw new Error('仅支持 --output <报告目录>');
  output = resolve(args[++index]);
}
const child = spawn(
  process.execPath,
  [
    resolve(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'vitest.tasks-v3-benchmark.config.ts',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, TASKS_V3_BENCHMARK_OUTPUT: output },
  }
);
const code = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode, signal) => resolveExit(signal ? 1 : (exitCode ?? 1)));
});
process.exitCode = code;
