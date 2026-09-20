/**
 * 阶段 0 地基验证（容器外快速版）。
 *
 * 验证四件事：
 *   1. `dsh --profile sdk --patch <qqbot patch>` 能被驱动完成一次 JSON-RPC 会话
 *   2. **审批桩是否真的让工具调用通过**（write/bash 在无头环境下能否成功）
 *   3. 工作区里是否真的出现了 agent 写的文件（即工具真的执行了，不是模型嘴上说做了）
 *   4. `shutdown` 是否能优雅退出且 stdout 全程只有协议帧
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-... node scripts/smoke-dsh.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const PATCH = join(REPO, 'dsh-profile', 'cordis.patch.yml');

/** TMPDIR 可能被指到一个还不存在的目录（例如测试时指向工作区内），先兜底创建。 */
function makeTempDir(prefix) {
  const base = tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

const DSH_HOME = makeTempDir('dsmoke-home-');
const WORKSPACE = makeTempDir('dsmoke-ws-');

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY');
  process.exit(2);
}

const child = spawn(
  'dsh',
  ['--profile', 'sdk', '--patch', PATCH],
  {
    cwd: WORKSPACE,
    env: { ...process.env, DSH_HOME, DEEPSEEK_API_KEY: apiKey },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);

/** stdout 的每一行都必须是合法 JSON-RPC 帧——这是协议通道纯净性的断言。 */
let stdoutLines = 0;
let stdoutNonJson = 0;

let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line === '') continue;
    stdoutLines += 1;
    try {
      handleFrame(JSON.parse(line));
    } catch {
      stdoutNonJson += 1;
      console.error('[stdout 非协议内容]', line.slice(0, 400));
    }
  }
});

const stderrLines = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  for (const line of chunk.split('\n')) {
    if (line.trim() === '') continue;
    stderrLines.push(line);
  }
});

let nextId = 1;
const pending = new Map();
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const SESSION_ID = 'smoke-session-1';
const assistantTexts = [];
let status = null;
let sawTurnEnd = null;

function handleFrame(frame) {
  if (frame.id !== undefined && frame.method === undefined) {
    const p = pending.get(frame.id);
    pending.delete(frame.id);
    if (!p) return;
    if (frame.error) p.reject(new Error(JSON.stringify(frame.error)));
    else p.resolve(frame.result);
    return;
  }
  if (frame.method === 'session.event') {
    const { sessionId, event } = frame.params;
    if (sessionId !== SESSION_ID) return;
    if (event.type === 'assistant/message') {
      const text = (event.data.message.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.trim() !== '') assistantTexts.push(text);
      console.log('[assistant/message]', text.slice(0, 200));
    } else if (event.type === 'turn/end') {
      sawTurnEnd = event.data.reason;
      console.log('[turn/end]', JSON.stringify(event.data.reason));
    } else if (event.type === 'tool/call') {
      console.log('[tool/call]', event.data.name);
    } else if (event.type === 'approval/asked' || event.type === 'approval/decided') {
      console.log(`[${event.type}]`, JSON.stringify(event.data));
    }
  } else if (frame.method === 'session.status') {
    status = frame.params.status;
    console.log('[session.status]', status);
  }
}

const waitFor = (predicate, timeoutMs, label) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待超时：${label}`));
      }
    }, 200);
  });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const init = await request('initialize', {
    cwd: WORKSPACE,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  });
  check('initialize 返回 wire-stable 身份', init?.serverInfo?.name === 'deepseek-harness-sdk-runtime',
    JSON.stringify(init?.serverInfo));

  await request('session/prompt', {
    sessionId: SESSION_ID,
    contentBlocks: [
      {
        type: 'text',
        text: '请在工作区里创建一个文件 ok.txt，内容写 hello-dsh，然后运行 `cat ok.txt` 确认，最后用一句话回复文件是否创建成功。',
      },
    ],
  });
  console.log('[session/prompt] 已入队');

  await waitFor(() => status === 'idle' && sawTurnEnd !== null, 240_000, 'turn 结束');
  check('收到 turn/end', sawTurnEnd !== null, JSON.stringify(sawTurnEnd));
  check('turn 正常完成', sawTurnEnd?.kind === 'completed', sawTurnEnd?.kind ?? 'n/a');
  check('收到 assistant 回复', assistantTexts.length > 0, `${assistantTexts.length} 条`);

  const okFile = join(WORKSPACE, 'ok.txt');
  const fileExists = existsSync(okFile);
  check('agent 真的写了文件（工具调用生效）', fileExists, okFile);
  if (fileExists) {
    const content = readFileSync(okFile, 'utf8').trim();
    check('文件内容正确', content === 'hello-dsh', JSON.stringify(content));
  }

  // 审批桩的行为分两种情况，都算通过：
  //   - 有可用沙箱后端（Linux + Landlock/bwrap）→ 工作区内操作无需审批，
  //     应该**看不到**审批日志。这是最理想的结果。
  //   - 没有沙箱后端（例如 macOS 无 sandbox-exec）→ DSH 会请求提权，
  //     审批桩应当放行，日志里出现 auto-approved。
  // 唯一算失败的是"出现了审批请求但没被放行"。
  const approved = stderrLines.filter((l) => l.includes('auto-approved'));
  const escalationWarnings = stderrLines.filter((l) => l.includes('sandbox escalation'));
  const pluginMounted = stderrLines.some((l) => l.includes('plugin mounted'));
  check('审批桩已挂载', pluginMounted);
  if (approved.length === 0) {
    check(
      '无需审批即可完成（沙箱后端有效）',
      escalationWarnings.length === 0,
      escalationWarnings.length > 0 ? '有提权请求但未被放行' : '工作区内操作全部被沙箱接受',
    );
  } else {
    check('审批请求被放行', true, `${approved.length} 次，其中提权 ${escalationWarnings.length} 次`);
  }

  await request('shutdown', undefined);
  await waitFor(() => child.exitCode !== null, 20_000, 'shutdown 退出');
  check('shutdown 后进程退出', child.exitCode === 0, `exitCode=${child.exitCode}`);

  check('stdout 全程只有协议帧', stdoutNonJson === 0, `${stdoutLines} 帧, ${stdoutNonJson} 条非协议`);
} catch (error) {
  check('流程未抛异常', false, String(error));
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  const sessionsDir = join(DSH_HOME, 'sessions');
  check('会话日志已落盘', existsSync(sessionsDir), sessionsDir);
  if (existsSync(sessionsDir)) {
    // 落盘形态：sessions/<规范化 cwd>/<sessionId>/session.v3.jsonl.zstd
    // （该 profile 用压缩格式，所以不是裸 .jsonl；目录名含 cwd 说明会话按 cwd 分文件夹）
    const files = readdirSync(sessionsDir, { recursive: true }).map(String);
    const sessionArtifacts = files.filter((f) => f.includes('session.v') && f.includes('jsonl'));
    check(
      '存在 JSONL 会话文件',
      sessionArtifacts.length > 0,
      sessionArtifacts.join(', ') || files.join(', '),
    );
  }
  console.log('\n--- 失败项 ---');
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) console.log('（无）');
  for (const f of failed) console.log(`- ${f.name}: ${f.detail}`);
  console.log(`\nDSH_HOME=${DSH_HOME}\nWORKSPACE=${WORKSPACE}`);
  console.log(`stderr 行数=${stderrLines.length}`);
  if (failed.length > 0) {
    console.log('\n--- stderr 末尾 40 行 ---');
    console.log(stderrLines.slice(-40).join('\n'));
  }
  if (!process.env.KEEP_SMOKE_DIRS) {
    rmSync(DSH_HOME, { recursive: true, force: true });
    rmSync(WORKSPACE, { recursive: true, force: true });
  }
  process.exit(failed.length === 0 ? 0 : 1);
}
