import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import type { DshRuntimeOptions, SessionEventNotification } from '@qqbot/contracts';
import { describe, expect, it } from 'vitest';
import { createDshRuntime } from '../src/runtime/index.js';
import { createLogger } from '../src/observability/index.js';
import { deferred } from './bench/frontend-worker/harness.js';
import { recordBenchmarkEvidence } from './bench/frontend-worker/evidence.js';

const CHILD = `
import {Socket} from 'node:net';import {createInterface} from 'node:readline';
const channel=new Socket({fd:3,readable:true,writable:true});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let sessionId;const replies=[];const frames=JSON.parse(process.env.TEST_WORKER_FRAMES);const expected=frames.filter(frame=>frame.type!=='worker-cancel').length;
createInterface({input:channel}).on('line',line=>{const frame=JSON.parse(line);replies.push({...frame,bytes:Buffer.byteLength(line)+1});if(frame.type==='worker-budget'||replies.length===expected)send({method:'session.event',params:{sessionId,event:{type:'assistant/message',seq:replies.length,data:{message:{content:[{type:'text',text:JSON.stringify(replies)}]}}}}});});
channel.on('error',()=>{});
createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.method==='initialize')send({id:request.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'offline'}}});else if(request.method==='session/prompt'){sessionId=request.params.sessionId;send({id:request.id,result:{messageId:'prompt'}});channel.write(frames.map(frame=>JSON.stringify(frame)+'\\n').join(''));}else if(request.method==='shutdown'){send({id:request.id,result:{}});channel.destroy();process.exit(0);}});
`;
const frame = (id: string, action: string, extra: object = {}) => ({
  id,
  action,
  sessionId: 'root',
  executionId: 'execution',
  runtimeGeneration: 'generation',
  ...extra,
});
async function harness(
  frames: object[],
  workerServices: NonNullable<DshRuntimeOptions['workerServices']>
) {
  const directory = await mkdtemp(join(tmpdir(), 'worker-fd3-'));
  const file = join(directory, 'child.mjs');
  await writeFile(file, CHILD);
  const runtime = createDshRuntime({
    bin: 'offline',
    profilePatch: 'unused',
    cwd: directory,
    dshHome: directory,
    provider: 'offline',
    model: 'offline',
    startTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    logger: createLogger({ autoTick: false, sink: () => {} }),
    env: { QQBOT_ROLE: 'worker', TEST_WORKER_FRAMES: JSON.stringify(frames) },
    spawnImpl: ((_bin: string, _args: string[], options: SpawnOptions) =>
      spawn(process.execPath, [file], options)) as unknown as typeof spawn,
    workerServices,
  });
  await runtime.start();
  return {
    runtime,
    async close() {
      await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
function content(event: SessionEventNotification) {
  const message = event.event.data.message as { content: { text: string }[] };
  return message.content[0]!.text;
}
describe('worker fd3 的真实子进程能力通道', () => {
  it('单个搜索取消释放 HTTP 等待且保留其他 worker 请求', async () => {
    const calls: string[] = [];
    const h = await harness(
      [
        frame('cancelled', 'search', { request: { query: '挂起' } }),
        { type: 'worker-cancel', id: 'cancelled' },
        frame('healthy', 'authorize-step', { turn: 2, step: 1 }),
      ],
      async (request, signal) => {
        calls.push(request.action);
        if (request.action === 'authorize-step') {
          expect(request.turn).toBe(2);
          return { ok: true, value: { kind: 'execute' } };
        }
        return new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              resolve({ ok: false, error: { code: 'CANCELLED' } });
            },
            { once: true }
          );
        });
      }
    );
    try {
      const output = deferred<SessionEventNotification>();
      h.runtime.once('session.event', output.resolve);
      await h.runtime.prompt('root', [{ type: 'text', text: '取消某次查询' }]);
      const rows = JSON.parse(content(await output.promise)) as { id: string; value: unknown }[];
      expect(rows.find((row) => row.id === 'cancelled')?.value).toMatchObject({
        ok: false,
        error: { code: 'CANCELLED' },
      });
      expect(rows.find((row) => row.id === 'healthy')?.value).toMatchObject({ ok: true });
      expect(calls).toEqual(['search', 'authorize-step']);
      expect(h.runtime.isReady).toBe(true);
    } finally {
      await h.close();
    }
  });
  it('搜索和步骤请求通过独立 worker 通道按身份回传', async () => {
    const calls: string[] = [];
    const h = await harness(
      [
        frame('search', 'search', { request: { query: '资料', maxResults: 2 } }),
        frame('step', 'authorize-step', { step: 1 }),
      ],
      async (request) => {
        calls.push(request.action);
        expect(request).toMatchObject({
          sessionId: 'root',
          executionId: 'execution',
          runtimeGeneration: 'generation',
        });
        return {
          ok: true,
          value:
            request.action === 'search'
              ? { sources: [{ url: 'https://example.com' }], truncated: false }
              : undefined,
        };
      }
    );
    try {
      const output = deferred<SessionEventNotification>();
      h.runtime.once('session.event', output.resolve);
      await h.runtime.prompt('root', [{ type: 'text', text: '请求能力' }]);
      const response = JSON.parse(content(await output.promise));
      expect(calls).toEqual(['search', 'authorize-step']);
      expect(response.map((x: { id: string }) => x.id)).toEqual(['search', 'step']);
      expect(response[0].value.ok).toBe(true);
      await recordBenchmarkEvidence('worker-channel-responses', {
        calls,
        frameBytes: response.map((frame: { bytes: number }) => frame.bytes),
      });
    } finally {
      await h.close();
    }
  });
  it('worker 不能通过服务通道请求前台派发工具', async () => {
    let calls = 0;
    const h = await harness(
      [
        frame('forged', 'start-worker', {
          assignment: { instruction: '伪造', deliverables: ['结果'] },
        }),
      ],
      async () => {
        calls++;
        return { ok: true };
      }
    );
    try {
      const closed = deferred<undefined>();
      const off = h.runtime.onTaskChannelClose!(() => {
        closed.resolve(undefined);
      });
      await h.runtime.prompt('root', [{ type: 'text', text: '越权' }]);
      await closed.promise;
      off();
      expect(calls).toBe(0);
    } finally {
      await h.close();
    }
  });
  it('预算通知可在搜索等待期间送到 worker 且携带执行身份', async () => {
    const entered = deferred<undefined>(),
      release = deferred<undefined>();
    const h = await harness(
      [frame('search', 'search', { request: { query: '等待' } })],
      async () => {
        entered.resolve(undefined);
        await release.promise;
        return { ok: true, value: { sources: [], truncated: false } };
      }
    );
    try {
      const output = deferred<SessionEventNotification>();
      h.runtime.once('session.event', output.resolve);
      await h.runtime.prompt('root', [{ type: 'text', text: '预算' }]);
      await entered.promise;
      h.runtime.notifyWorkerBudget!({
        kind: 'finish',
        reason: 'time-budget',
        sessionId: 'root',
        executionId: 'execution',
        runtimeGeneration: 'generation',
      });
      expect(JSON.parse(content(await output.promise))[0]).toMatchObject({
        type: 'worker-budget',
        update: { kind: 'finish', reason: 'time-budget', executionId: 'execution' },
      });
    } finally {
      release.resolve(undefined);
      await h.close();
    }
  });
  it('超大 worker 回执明确失败且实际传输不超过 64 KiB', async () => {
    const h = await harness(
      [frame('search', 'search', { request: { query: '大返回' } })],
      async () => ({ ok: true, value: '中'.repeat(65536) })
    );
    try {
      const output = deferred<SessionEventNotification>();
      h.runtime.once('session.event', output.resolve);
      await h.runtime.prompt('root', [{ type: 'text', text: '容量' }]);
      const response = JSON.parse(content(await output.promise))[0];
      expect(response.value).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(response.bytes).toBeLessThan(65536);
      await recordBenchmarkEvidence('worker-channel-oversize', {
        frameBytes: response.bytes,
        code: response.value.error.code,
      });
    } finally {
      await h.close();
    }
  });
  it('runtime 关闭取消通道中的 HTTP 等待', async () => {
    const entered = deferred<undefined>(),
      cancelled = deferred<undefined>();
    const h = await harness(
      [frame('search', 'search', { request: { query: '挂起' } })],
      async (_request, signal) => {
        entered.resolve(undefined);
        return new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              cancelled.resolve(undefined);
              resolve({ ok: false });
            },
            { once: true }
          );
        });
      }
    );
    try {
      await h.runtime.prompt('root', [{ type: 'text', text: '取消' }]);
      await entered.promise;
      await h.runtime.dispose();
      await cancelled.promise;
      expect(h.runtime.state).toBe('closed');
      await recordBenchmarkEvidence('worker-channel-shutdown', {
        state: h.runtime.state,
        cancelled: true,
      });
    } finally {
      await h.close();
    }
  });
});
