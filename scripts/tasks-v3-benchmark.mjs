import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let output = resolve(root, 'tmp/benchmarks/tasks-v3-v2');
let cases = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (
    !['--output', '--cases'].includes(arg) ||
    !args[index + 1] ||
    args[index + 1].startsWith('--')
  )
    throw new Error('支持 --output <报告目录> 和 --cases F01,F10');
  const value = args[++index];
  if (arg === '--output') output = resolve(value);
  else cases = value.split(',').filter(Boolean);
}
await mkdir(output, { recursive: true });
// 中断后也不能把前一轮同目录的完整报告当成这一轮成功。
await writeFile(
  resolve(output, 'report.json'),
  JSON.stringify(
    {
      schemaVersion: 2,
      benchmarkVersion: 'tasks-v3-v2',
      status: 'incomplete',
      complete: false,
      scenarios: [],
    },
    null,
    2
  )
);
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
    env: {
      ...process.env,
      TASKS_V3_BENCHMARK_OUTPUT: output,
      TASKS_V3_BENCHMARK_CASES: cases.join(','),
    },
  }
);
const code = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode, signal) => resolveExit(signal ? 1 : (exitCode ?? 1)));
});
const report = JSON.parse(await readFile(resolve(output, 'report.json'), 'utf8'));
const passed =
  report.schemaVersion === 2 &&
  report.benchmarkVersion === 'tasks-v3-v2' &&
  report.status === 'passed' &&
  report.complete === true;
process.exitCode = code === 0 && passed ? 0 : 1;
