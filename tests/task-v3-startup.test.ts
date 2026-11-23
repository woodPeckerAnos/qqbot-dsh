import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { JsonRpcRequestTimeoutError, LoggedError } from '@qqbot/contracts';
import { startTaskRuntimeCheckV3 } from '../src/task/index.js';

function runtimeStub() {
  return {
    lastErrorId: 'startup-error',
    start: vi.fn(async (_signal?: AbortSignal) => ({
      serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'offline' },
    })),
    dispose: vi.fn(async () => {}),
    prompt: vi.fn(),
  };
}

describe('启动初始化检查的失败与关闭', () => {
  it('只初始化一次并关闭，不调用 prompt，传递同一个取消信号', async () => {
    const runtime = runtimeStub();
    const signal = new AbortController().signal;
    expect(await startTaskRuntimeCheckV3(runtime, signal)).toEqual({ ok: true, value: undefined });
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.start).toHaveBeenCalledWith(signal);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.prompt).not.toHaveBeenCalled();
  });

  it('开始前已取消不启动，仍关闭资源', async () => {
    const runtime = runtimeStub();
    const controller = new AbortController();
    controller.abort();
    expect(await startTaskRuntimeCheckV3(runtime, controller.signal)).toMatchObject({
      ok: false,
      error: { code: 'CANCELLED', errorId: 'startup-error' },
    });
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it('保留被 LoggedError 包装的初始化超时分类', async () => {
    const runtime = runtimeStub();
    const cause = new LoggedError('startup-error', 'initialize failed', {
      cause: new JsonRpcRequestTimeoutError('initialize', 60000),
    });
    runtime.start.mockRejectedValue(cause);
    expect(await startTaskRuntimeCheckV3(runtime, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: 'TIMEOUT', cause, errorId: 'startup-error' },
    });
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it('初始化成功但关闭失败仍阻止启动', async () => {
    const runtime = runtimeStub();
    const cause = new Error('dispose failed');
    runtime.dispose.mockRejectedValue(cause);
    expect(await startTaskRuntimeCheckV3(runtime, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_FAILED', cause },
    });
  });

  it('初始化和关闭都失败时保留两个根因', async () => {
    const runtime = runtimeStub();
    const first = new Error('initialize failed');
    const second = new Error('dispose failed');
    runtime.start.mockRejectedValue(first);
    runtime.dispose.mockRejectedValue(second);
    const checked = await startTaskRuntimeCheckV3(runtime, new AbortController().signal);
    expect(checked).toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_FAILED', errorId: 'startup-error' },
    });
    if (checked.ok) throw new Error('预期初始化失败');
    expect(checked.error.cause).toBeInstanceOf(AggregateError);
    expect((checked.error.cause as AggregateError).errors).toEqual([first, second]);
  });

  it('关闭期间收到取消仍完成关闭并阻止启动', async () => {
    const runtime = runtimeStub();
    const controller = new AbortController();
    runtime.dispose.mockImplementation(async () => {
      controller.abort();
    });
    expect(await startTaskRuntimeCheckV3(runtime, controller.signal)).toMatchObject({
      ok: false,
      error: { code: 'CANCELLED' },
    });
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });
});

it('生产入口初始化失败时退出，持久恢复和连接器尚未构造，临时目录已清理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qqbot-startup-test-'));
  const stateDir = join(root, 'state');
  await mkdir(stateDir);
  const originals = new Map<string, string>();
  // 非法内容会在持久恢复时抛错；预检失败应保留它们原封不动。
  for (const name of ['tasks.json', 'messages.json', 'task-budgets.json', 'personas.json']) {
    originals.set(name, `do-not-restore-${name}`);
    await writeFile(join(stateDir, name), originals.get(name)!);
  }
  const binary = join(root, 'dsh.cjs');
  const logFile = join(root, 'calls.jsonl');
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  fs.appendFileSync(process.env.DSH_TEST_LOG, JSON.stringify(frame) + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'unsupported reasoning effort' } }) + '\\n');
});
`,
    { mode: 0o700 }
  );
  const configPath = join(root, 'qqbot.yml');
  await writeFile(
    configPath,
    stringify({
      dsh: {
        bin: binary,
        profilePatch: resolve('dsh-profile/cordis.patch.yml'),
      },
      paths: { stateDir, workspacesRoot: join(root, 'workspaces'), dshHome: join(root, 'dsh') },
      tasks: {
        taskProvider: 'qwen-token-plan',
        taskModel: 'qwen3.8-flash',
        reasoningEffort: 'high',
      },
    })
  );
  const child = spawn(
    process.execPath,
    [resolve('node_modules/vite-node/vite-node.mjs'), resolve('src/main.ts')],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        QQ_CONFIG_FILE: configPath,
        BOT_CONNECTORS: 'onebot',
        ONEBOT_ACCESS_TOKEN: 'offline',
        DEEPSEEK_API_KEY: 'offline',
        DSH_TEST_LOG: logFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const [code, signal] = await once(child, 'exit');
    expect({ code, signal }, stderr).toEqual({ code: 1, signal: null });
    expect(stdout + stderr).toContain('任务模型初始化检查失败');
    const calls = (await readFile(logFile, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            params: { cwd: string; provider: string; model: string; reasoningEffort: string };
          }
      );
    expect(calls.map((call) => call.method)).toEqual(['initialize']);
    const initialized = calls[0]!;
    expect(initialized.params).toMatchObject({
      provider: 'qwen-token-plan',
      model: 'qwen3.8-flash',
      reasoningEffort: 'high',
    });
    await expect(access(initialized.params.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const [name, text] of originals)
      expect(await readFile(join(stateDir, name), 'utf8')).toBe(text);
    await expect(access(join(stateDir, 'task-sessions.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(stdout).not.toContain('连接器');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(root, { recursive: true, force: true });
  }
});
