/**
 * 沙箱后端验证（阶段 0 的第二项硬指标）。
 *
 * 要回答的问题：**在 workspace-write 模式下，agent 执行命令会不会被迫提权？**
 *
 * 为什么这决定 A 方案的成败：
 *   - 有可用沙箱后端（Linux 上的 bubblewrap）→ 工作区内的读写/命令正常工作，
 *     工作区之外被挡住。此时 "workspace-write" 是一道真闸。
 *   - 没有后端（macOS 无 sandbox-exec、容器里缺 bubblewrap）→ DSH 连 `cat` 都
 *     跑不了，会主动请求提权到 danger-full-access。审批桩若放行，
 *     **实际权限就等于完全访问**，workspace-write 名存实亡。
 *
 * 判定方法：让 agent 只做工作区内的事，然后看事件流里有没有提权请求。
 *   没有提权  → SANDBOX-EFFECTIVE
 *   出现提权  → DEGRADED（实际为完全访问）
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-... node scripts/verify-sandbox.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(new URL('..', import.meta.url).pathname);
const PATCH = join(REPO, 'dsh-profile', 'cordis.patch.yml');

function makeTempDir(prefix) {
  const base = tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

const DSH_HOME = makeTempDir('vsb-home-');
const WORKSPACE = makeTempDir('vsb-ws-');

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY');
  process.exit(2);
}

const child = spawn('dsh', ['--profile', 'sdk', '--patch', PATCH], {
  cwd: WORKSPACE,
  env: { ...process.env, DSH_HOME },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdoutBuf = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk;
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const SESSION_ID = 'sandbox-check';
const escalationReasons = [];
const toolCalls = [];
let sawAssistantText = '';
let turnEnd = null;
let status = null;

function handleFrame(frame) {
  if (frame.method === 'session.event') {
    const { sessionId, event } = frame.params;
    if (sessionId !== SESSION_ID) return;
    if (event.type === 'assistant/message') {
      const text = (event.data.message.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.trim() !== '') sawAssistantText = text;
    } else if (event.type === 'tool/call') {
      toolCalls.push(event.data.name);
    } else if (event.type === 'turn/end') {
      turnEnd = event.data.reason;
    }
  } else if (frame.method === 'session.status') {
    status = frame.params.status;
  }
}

let nextId = 1;
const pending = new Map();
function request(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

/** 逐帧消费 stdout（协议纯净性同时被检查）。 */
function pumpStdout() {
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (line === '') continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      nonJsonStdout += 1;
      continue;
    }
    if (frame.id !== undefined && frame.method === undefined) {
      const p = pending.get(frame.id);
      pending.delete(frame.id);
      if (p) (frame.error ? p.rej(new Error(JSON.stringify(frame.error))) : p.res(frame.result));
    } else if (frame.method !== undefined) {
      handleFrame(frame);
    }
  }
}
let nonJsonStdout = 0;

const waitFor = (predicate, timeoutMs, label) =>
  new Promise((res, rej) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        res();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        rej(new Error(`等待超时：${label}`));
      }
    }, 150);
  });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const tick = setInterval(pumpStdout, 100);

try {
  await waitFor(() => true, 1, 'start');
  await request('initialize', { cwd: WORKSPACE, provider: 'deepseek-official', model: 'deepseek-flash' });

  await request('session/prompt', {
    sessionId: SESSION_ID,
    contentBlocks: [
      {
        type: 'text',
        text: '在当前工作区执行这三步：1) 运行 `pwd`；2) 运行 `echo sandbox-ok > probe.txt`；3) 运行 `cat probe.txt`。全部完成后用一句话汇报。不要使用工作区之外的任何路径。',
      },
    ],
  });

  await waitFor(() => status === 'idle' && turnEnd !== null, 300_000, 'turn 结束');

  // 从 stderr 里读审批桩的日志：提权请求会被打成 sandbox escalation auto-approved
  for (const line of stderr.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (typeof rec.message === 'string' && rec.message.includes('sandbox escalation')) {
        escalationReasons.push(rec.reason ?? rec.message);
      }
    } catch {
      /* 非 JSON 行忽略 */
    }
  }

  const probeFile = join(WORKSPACE, 'probe.txt');
  check('工具被真实调用', toolCalls.length > 0, toolCalls.join(', '));
  check('工作区内文件已创建', existsSync(probeFile));
  check('turn 正常完成', turnEnd?.kind === 'completed', turnEnd?.kind ?? 'n/a');
  check('stdout 只有协议帧', nonJsonStdout === 0, `${nonJsonStdout} 条非协议`);

  const degraded = escalationReasons.length > 0;
  check(
    '沙箱后端有效（工作区内操作无需提权）',
    !degraded,
    degraded ? `出现 ${escalationReasons.length} 次提权请求` : '未出现提权请求',
  );

  await request('shutdown', undefined);
  await waitFor(() => child.exitCode !== null, 20_000, 'shutdown');
  check('shutdown 后正常退出', child.exitCode === 0, `exitCode=${child.exitCode}`);

  console.log('\n================ 结论 ================');
  if (degraded) {
    console.log('VERDICT: DEGRADED —— 沙箱后端不可用，workspace-write 实际等于完全访问。');
    console.log('提权原因（去重）：');
    for (const r of [...new Set(escalationReasons)]) console.log(`  - ${r}`);
    console.log('修复：在镜像里安装 bubblewrap（本仓库 Dockerfile 已安装），');
    console.log('      或把 allowEscalation 设为 false 让提权被拒绝（机器人将无法执行命令）。');
  } else {
    console.log('VERDICT: SANDBOX-EFFECTIVE —— workspace-write 是一道真闸，A 方案成立。');
  }
  console.log(`\n工作区=${WORKSPACE}`);
} catch (error) {
  check('流程未抛异常', false, String(error));
} finally {
  clearInterval(tick);
  if (child.exitCode === null) child.kill('SIGKILL');
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log('\n--- 失败项 ---');
    for (const f of failed) console.log(`- ${f.name}: ${f.detail}`);
    console.log('\n--- stderr 末 25 行 ---');
    console.log(stderr.split('\n').filter(Boolean).slice(-25).join('\n'));
  }
  if (!process.env.KEEP_SMOKE_DIRS) {
    rmSync(DSH_HOME, { recursive: true, force: true });
    rmSync(WORKSPACE, { recursive: true, force: true });
  }
  process.exit(failed.some((f) => !f.ok && f.name.startsWith('沙箱后端有效')) ? 3 : failed.length ? 1 : 0);
}
