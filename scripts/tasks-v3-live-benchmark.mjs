import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  run: false,
  output: resolve(root, 'tmp/benchmarks/tasks-v3-live-v1'),
  cases: [],
  repeat: 1,
};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--run') options.run = true;
  else if (['--output', '--cases', '--repeat'].includes(arg)) {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`缺少 ${arg} 参数`);
    if (arg === '--output') options.output = resolve(value);
    if (arg === '--cases') options.cases = value.split(',').filter(Boolean);
    if (arg === '--repeat') options.repeat = Number(value);
  } else throw new Error(`未知参数 ${arg}`);
}
if (!Number.isSafeInteger(options.repeat) || options.repeat < 1 || options.repeat > 3)
  throw new Error('--repeat 支持1到3次');
if (options.cases.some((id) => !['L01', 'L02', 'L03'].includes(id)))
  throw new Error('live场景支持L01,L02,L03');
await mkdir(options.output, { recursive: true });
await writeFile(
  resolve(options.output, 'report.json'),
  JSON.stringify(
    {
      schemaVersion: 2,
      architectureVersion: 3,
      benchmarkVersion: 'tasks-v3-live-v1',
      mode: 'live',
      status: 'unrun',
      complete: false,
      modelEvaluation: {
        performed: false,
        modelApiRequests: 0,
        judgeApiRequests: 0,
        semantics: 'unknown',
      },
      options,
      reason: '准备完成；真实DSH模型和独立裁判需要另行费用授权后手动 --run。',
    },
    null,
    2
  )
);
await writeFile(
  resolve(options.output, 'report.md'),
  '# 前台/worker V3 live benchmark\n\n已准备，未运行。模型与裁判请求0，语义unknown。费用授权后使用 --run；默认命令只写此报告。\n'
);
if (options.run) {
  const child = spawn(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.tasks-v3-live-benchmark.config.ts',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, TASKS_V3_LIVE_OPTIONS: JSON.stringify(options) },
    }
  );
  process.exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
  });
} else process.stdout.write(`已准备，未调用模型：${options.output}/report.json\n`);
