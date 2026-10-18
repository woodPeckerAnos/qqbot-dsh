/**
 * 阶段 2b 第 0 步：验证**同一 DSH 进程内两个 sessionId 是否真并发执行**。
 *
 * 这是「接待员 + 执行者」双通道方案（同 runtime 两个会话：fast lane 接待、
 * slow lane 跑长任务）成立与否的前提：
 *   - CONCURRENT  → 双通道可以在一个 runtime 进程内实现，改动面最小；
 *   - SERIALIZED  → 同进程多会话仍是串行的，双通道必须退化为「每会话两个
 *     runtime 进程（fast/slow 各一，同工作区）」，池的记账与回收相应调整。
 *
 * 方法：
 *   1. initialize 后向会话 A 派发一个"同步 sleep 25 秒再回答"的任务
 *      （显式禁止 subagent——否则模型把活派给子代理、A 的轮次秒结束，
 *      测到的就不是会话级并发了）；
 *   2. 3 秒后向会话 B 派发一个"立刻回答一句话"的任务；
 *   3. 若 B 在 A 完成之前就完成了自己的轮次 → CONCURRENT；
 *      若 B 一直等到 A 结束后才开始/完成 → SERIALIZED。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-... node scripts/probe-dual-session.mjs [--sleep 25] [--verbose]
 *
 * 注意：模型可能不听话（仍派 subagent）。一旦观测到 subagent.started，
 * 结论标记为 INCONCLUSIVE——那说明纪律挡不住，而不是并发性不存在。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const verbose = argv.includes('--verbose');
const SLEEP_SECONDS = Number(value('--sleep') ?? '25');

const REPO = new URL('..', import.meta.url).pathname;
const PATCH = join(REPO, 'dsh-profile', 'cordis.patch.yml');

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY');
  process.exit(2);
}

const base = tmpdir();
mkdirSync(base, { recursive: true });
const DSH_HOME = mkdtempSync(join(base, 'dprobe-home-'));
const WORKSPACE = mkdtempSync(join(base, 'dprobe-ws-'));

const child = spawn('dsh', ['--profile', 'sdk', '--patch', PATCH], {
  cwd: WORKSPACE,
  env: { ...process.env, DSH_HOME, DEEPSEEK_API_KEY: apiKey },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line === '') continue;
    try {
      handleFrame(JSON.parse(line));
    } catch {
      console.error('[stdout 非协议内容]', line.slice(0, 300));
    }
  }
});
const stderrLines = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  for (const line of chunk.split('\n')) {
    if (line.trim() === '') continue;
    stderrLines.push(line);
    if (verbose) process.stderr.write(`ERR ${line}\n`);
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

const SESSION_A = 'probe-slow-lane';
const SESSION_B = 'probe-fast-lane';
/** sessionId → { status, turnEndedAt, firstEventAt, texts } */
const lanes = new Map([
  [SESSION_A, { status: 'unknown', turnEndedAt: 0, firstEventAt: 0, texts: [] }],
  [SESSION_B, { status: 'unknown', turnEndedAt: 0, firstEventAt: 0, texts: [] }],
]);
let sawSubagent = false;
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

function handleFrame(frame) {
  if (frame.id !== undefined && frame.method === undefined) {
    const p = pending.get(frame.id);
    pending.delete(frame.id);
    if (!p) return;
    if (frame.error) p.reject(new Error(JSON.stringify(frame.error)));
    else p.resolve(frame.result);
    return;
  }
  if (frame.method === 'subagent.started') {
    sawSubagent = true;
    console.log(`[${elapsed()}] subagent.started（模型不守纪律，结论将降级为 INCONCLUSIVE）`);
    return;
  }
  if (frame.method === 'session.event') {
    const { sessionId, event } = frame.params;
    const lane = lanes.get(sessionId);
    if (lane === undefined) return; // 子代理等其它会话
    if (lane.firstEventAt === 0) lane.firstEventAt = Date.now();
    if (event.type === 'assistant/message') {
      const text = (event.data.message.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.trim() !== '') lane.texts.push(text);
      console.log(`[${elapsed()}] ${sessionId} assistant/message: ${text.slice(0, 120)}`);
    } else if (event.type === 'turn/end') {
      lane.turnEndedAt = Date.now();
      console.log(`[${elapsed()}] ${sessionId} turn/end ${JSON.stringify(event.data.reason)}`);
    } else if (event.type === 'tool/call') {
      console.log(`[${elapsed()}] ${sessionId} tool/call ${event.data.name}`);
    }
    return;
  }
  if (frame.method === 'session.status') {
    const lane = lanes.get(frame.params.sessionId);
    if (lane === undefined) return;
    lane.status = frame.params.status;
    console.log(`[${elapsed()}] ${frame.params.sessionId} status=${lane.status}`);
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
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const init = await request('initialize', {
    cwd: WORKSPACE,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  });
  check('initialize 返回 wire-stable 身份', init?.serverInfo?.name === 'deepseek-harness-sdk-runtime');

  await request('session/prompt', {
    sessionId: SESSION_A,
    contentBlocks: [
      {
        type: 'text',
        text:
          `请用 bash 工具在当前会话里同步执行 sleep ${SLEEP_SECONDS}（不要加 &，**不要使用 ` +
          `subagent** 派发给子代理，这是并发性测试），sleep 结束后只回复四个字：A 完成。`,
      },
    ],
  });
  console.log(`[${elapsed()}] 已派发 A（慢任务，同步 sleep ${SLEEP_SECONDS}s）`);

  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await request('session/prompt', {
    sessionId: SESSION_B,
    contentBlocks: [
      { type: 'text', text: '快速问答：请立刻只回复四个字：B 就绪。不要调用任何工具。' },
    ],
  });
  console.log(`[${elapsed()}] 已派发 B（快任务）`);

  // A 至少要跑 SLEEP_SECONDS；B 若并发，应在 A 结束前早就完成
  await waitFor(
    () => lanes.get(SESSION_A).turnEndedAt > 0 && lanes.get(SESSION_B).turnEndedAt > 0,
    SLEEP_SECONDS * 1000 + 180_000,
    '两个会话都完成',
  );

  const a = lanes.get(SESSION_A);
  const b = lanes.get(SESSION_B);
  const bFinishedBeforeA = b.turnEndedAt > 0 && b.turnEndedAt < a.turnEndedAt;

  if (sawSubagent) {
    console.log('\nVERDICT INCONCLUSIVE —— 模型把慢任务派给了子代理，测到的不是会话级并发。');
    console.log('换措辞重试（更强硬地禁止 subagent），或直接按双进程退化形态评估。');
  } else if (bFinishedBeforeA) {
    console.log('\nVERDICT CONCURRENT —— B 在 A 运行期间完成了自己的轮次。');
    console.log('双通道可以在同一 runtime 进程内实现（fast/slow 两个 sessionId）。');
  } else {
    console.log('\nVERDICT SERIALIZED —— B 等到 A 结束后才完成。');
    console.log('同进程多会话是串行的：双通道需退化为「每会话 fast/slow 两个 runtime 进程」。');
  }
  console.log(
    `时序：B 完成于 ${((b.turnEndedAt - t0) / 1000).toFixed(1)}s，` +
      `A 完成于 ${((a.turnEndedAt - t0) / 1000).toFixed(1)}s（sleep=${SLEEP_SECONDS}s）`,
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log('\n--- stderr 末尾 30 行 ---');
    console.log(stderrLines.slice(-30).join('\n'));
  }
  process.exitCode = failed.length === 0 && !sawSubagent ? 0 : 1;
} catch (error) {
  console.error('VERDICT ERROR', error instanceof Error ? error.message : String(error));
  console.log('\n--- stderr 末尾 30 行 ---');
  console.log(stderrLines.slice(-30).join('\n'));
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  if (!process.env.KEEP_PROBE_DIRS) {
    rmSync(DSH_HOME, { recursive: true, force: true });
    rmSync(WORKSPACE, { recursive: true, force: true });
  } else {
    console.log(`DSH_HOME=${DSH_HOME}\nWORKSPACE=${WORKSPACE}`);
  }
}
