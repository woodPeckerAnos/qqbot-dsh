/**
 * 阶段 0 诊断工具：用一个指定的 patch 驱动 DSH runtime 完成 initialize，
 * 打印完整 stdout/stderr，用于定位 profile 组合问题。
 *
 * 用法：
 *   node scripts/probe-dsh.mjs --patch <path> [--no-patch] [--workspace <dir>] [--verbose]
 *
 * 与 smoke-dsh.mjs 的区别：smoke 是「验收断言」，本脚本是「诊断」，永远把原始
 * stderr 打出来，方便看 cordis 的加载错误。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const REPO = resolve(new URL('..', import.meta.url).pathname);
const noPatch = flag('--no-patch');
const patchPath = noPatch ? undefined : resolve(value('--patch') ?? join(REPO, 'dsh-profile', 'cordis.patch.yml'));
const verbose = flag('--verbose');
const workspace = resolve(value('--workspace') ?? mkdtempSync(join(tmpdir(), 'probe-ws-')));
const dshHome = resolve(value('--dsh-home') ?? mkdtempSync(join(tmpdir(), 'probe-home-')));

mkdirSync(workspace, { recursive: true });

const args = ['--profile', 'sdk'];
if (patchPath) args.push('--patch', patchPath);

console.log(`# dsh ${args.join(' ')}`);
console.log(`# workspace=${workspace}`);
console.log(`# DSH_HOME=${dshHome}`);

const child = spawn('dsh', args, {
  cwd: workspace,
  env: { ...process.env, DSH_HOME: dshHome },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let childFailed;
child.on('error', (error) => {
  childFailed = error;
  console.error(`# spawn 失败: ${error.message}`);
});

const stdoutFrames = [];
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === '') continue;
    stdoutFrames.push(line);
    console.log(`OUT ${line.length > 900 ? `${line.slice(0, 900)}…` : line}`);
  }
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
  if (verbose) process.stderr.write(`ERR ${chunk}`);
});

const deadline = Date.now() + 30_000;

setTimeout(() => {
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { cwd: workspace, provider: 'deepseek-official', model: 'deepseek-flash' },
    })}\n`,
  );
}, 4_000);

setTimeout(() => {
  const line = stdoutFrames.find((l) => l.includes('"id":1'));
  if (childFailed) {
    console.log('VERDICT SPAWN-FAILED');
  } else if (line === undefined) {
    console.log('VERDICT NO-RESPONSE');
  } else {
    const frame = JSON.parse(line);
    console.log(frame.error ? `VERDICT ERROR ${frame.error.message}` : 'VERDICT OK');
  }
  if (line === undefined || JSON.parse(line).error) {
    const lines = stderr.split('\n').filter((l) => l.trim() !== '');
    console.log('--- stderr（末 30 行）---');
    console.log(lines.slice(-30).join('\n'));
  }
  child.kill('SIGKILL');
  process.exit(0);
}, deadline - Date.now() + 2_000);
