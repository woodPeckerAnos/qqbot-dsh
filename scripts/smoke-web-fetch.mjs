/**
 * 联网能力验证：确认 dsh 的 web_fetch 真的能抓到网页正文。
 *
 * 与 smoke-dsh.mjs 一样驱动真实的 `dsh --profile sdk --patch <qqbot patch>`，
 * 但问的是一个**必须抓正文才能答对**的问题，并断言回复里出现了该页面独有的
 * 事实、且没有出现 WEB_BLOCKED_URL 一类失败措辞。
 *
 * 背景：宿主若开了 fake-IP 代理，DSH 的 http fetch provider 会把域名解析成
 * 198.18.0.0/15 并拒绝，表现为"能搜索、抓不到原文"。修法是给 dsh 进程设
 * HTTPS_PROXY/HTTP_PROXY（见 docs/DEPLOY.md 第 9 节）。
 *
 * 用法（容器内）：
 *   docker compose exec qqbot node scripts/smoke-web-fetch.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.env.SMOKE_REPO_ROOT ?? new URL('..', import.meta.url).pathname;
const PATCH = join(REPO, 'dsh-profile', 'cordis.patch.yml');

function makeTempDir(prefix) {
  const base = tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

const DSH_HOME = makeTempDir('dweb-home-');
const WORKSPACE = makeTempDir('dweb-ws-');

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY');
  process.exit(2);
}

// 目标页面：内容稳定、纯文本、不需要 JS 渲染。
const TARGET = 'https://www.iana.org/help/example-domains';
// 该页面正文里确实出现的字符串（用来判断"是否真的读到了正文"，而不是凭记忆答）。
const EXPECTED = ['Example Domains', 'example.com'];

console.log(`[smoke-web-fetch] 代理: HTTPS_PROXY=${process.env.HTTPS_PROXY ?? '(未设置)'}`);
if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY && !process.env.ALL_PROXY) {
  console.log('[smoke-web-fetch] 警告: 没有代理变量，fake-IP 环境下 web_fetch 预期会失败');
}

const child = spawn('dsh', ['--profile', 'sdk', '--patch', PATCH], {
  cwd: WORKSPACE,
  env: { ...process.env, DSH_HOME, DEEPSEEK_API_KEY: apiKey },
  stdio: ['pipe', 'pipe', 'pipe'],
});

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

const SESSION_ID = 'smoke-web-fetch-1';
const assistantTexts = [];
const toolCalls = [];
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
    } else if (event.type === 'turn/end') {
      sawTurnEnd = event.data.reason;
    } else if (event.type === 'tool/call') {
      toolCalls.push(event.data.name);
      console.log('[tool/call]', event.data.name);
    }
  } else if (frame.method === 'session.status') {
    status = frame.params.status;
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

const FAILURE_WORDS = ['WEB_BLOCKED_URL', '网络策略', '抓不到', '无法访问', 'non-public IP'];

try {
  const init = await request('initialize', {
    cwd: WORKSPACE,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  });
  check(
    'initialize 返回 wire-stable 身份',
    init?.serverInfo?.name === 'deepseek-harness-sdk-runtime',
    JSON.stringify(init?.serverInfo),
  );

  await request('session/prompt', {
    sessionId: SESSION_ID,
    contentBlocks: [
      {
        type: 'text',
        text:
          `请用 web_fetch 抓取 ${TARGET} 的正文，然后回答两个问题：` +
          '1) 这个页面介绍的对象叫什么（英文原名）？' +
          '2) 页面上给出的其中一个示例域名是什么？' +
          '只根据抓到的正文回答，不要凭记忆猜。',
      },
    ],
  });

  await waitFor(() => status === 'idle' && sawTurnEnd !== null, 300_000, 'turn 结束');

  const answer = assistantTexts.join('\n');
  console.log('\n--- 模型回复 ---');
  console.log(answer.slice(0, 1200));
  console.log('--- 回复结束 ---\n');

  check('收到 turn/end', sawTurnEnd !== null, JSON.stringify(sawTurnEnd));
  check('turn 正常完成', sawTurnEnd?.kind === 'completed', sawTurnEnd?.kind ?? 'n/a');
  check('调用了 web_fetch', toolCalls.includes('web_fetch'), toolCalls.join(', ') || '无工具调用');

  const hitExpected = EXPECTED.filter((s) => answer.includes(s));
  check('回复包含页面正文独有内容', hitExpected.length > 0, `命中: ${hitExpected.join(', ') || '无'}`);

  const hitFailure = FAILURE_WORDS.filter((s) => answer.includes(s));
  check('回复没有失败措辞', hitFailure.length === 0, hitFailure.join(', '));

  await request('shutdown', undefined);
  await waitFor(() => child.exitCode !== null, 20_000, 'shutdown 退出');
  check('shutdown 后进程退出', child.exitCode === 0, `exitCode=${child.exitCode}`);
  check('stdout 全程只有协议帧', stdoutNonJson === 0, `${stdoutLines} 帧`);
} catch (error) {
  check('流程未抛异常', false, String(error));
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  const failed = results.filter((r) => !r.ok);
  console.log('\n--- 失败项 ---');
  if (failed.length === 0) console.log('（无）');
  for (const f of failed) console.log(`- ${f.name}: ${f.detail}`);
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
