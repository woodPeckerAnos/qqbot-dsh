import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { DshRuntimeOptions, SessionEventNotification } from '@qqbot/contracts';
import { createDshRuntime } from '../src/runtime/index.js';
import { createLogger } from '../src/observability/index.js';
import { deferred } from './bench/frontend-worker/harness.js';

const CHILD = `
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
const channel = new Socket({fd:3, readable:true, writable:true});
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let sessionId;
const replies = [];
const frames = JSON.parse(process.env.TEST_CONTROL_FRAMES);
createInterface({input:channel}).on('line', line => {
  replies.push(JSON.parse(line));
  if(replies.length===frames.length) send({method:'session.event',params:{sessionId,event:{type:'assistant/message',seq:0,data:{message:{content:[{type:'text',text:JSON.stringify(replies)}]}}}}});
});
channel.on('error', () => {});
createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line);
  if(request.method==='initialize') send({id:request.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'offline'}}});
  else if(request.method==='session/prompt') {
    sessionId=request.params.sessionId;
    send({id:request.id,result:{messageId:'prompt'}});
    channel.write(frames.map(frame=>JSON.stringify(frame)+'\\n').join(''));
  } else if(request.method==='shutdown') {send({id:request.id,result:{}});channel.destroy();process.exit(0);}
});
`;

function frame(id: string, action: string, assignment?: object) {
  return {
    id,
    action,
    executionId: 'execution',
    runtimeGeneration: 'generation',
    sessionId: 'session',
    ...(assignment ? { assignment } : {}),
  };
}

async function harness(frames: object[], taskControl: DshRuntimeOptions['taskControl']) {
  const directory = await mkdtemp(join(tmpdir(), 'task-v3-channel-'));
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
    env: { QQBOT_ROLE: 'frontend', TEST_CONTROL_FRAMES: JSON.stringify(frames) },
    spawnImpl: ((_bin: string, _args: string[], options: SpawnOptions) =>
      spawn(process.execPath, [file], options)) as unknown as typeof spawn,
    taskControl,
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

describe('V3 fd3真实本地子进程与公共runtime接口', () => {
  it('控制请求有界串行，保存派发后拒绝队列里后续动作', async () => {
    const gate = deferred<undefined>();
    const entered = deferred<undefined>();
    const calls: string[] = [];
    const h = await harness(
      [
        frame('query', 'query'),
        frame('worker', 'start-worker', { instruction: '完成', deliverables: ['报告'] }),
        frame('cancel', 'cancel'),
      ],
      async (request) => {
        calls.push(request.action);
        if (request.action === 'query') {
          entered.resolve(undefined);
          await gate.promise;
        }
        return { ok: true, value: request.action === 'query' ? [] : { workerId: 'accepted' } };
      }
    );
    try {
      const output = deferred<SessionEventNotification>();
      h.runtime.once('session.event', output.resolve);
      await h.runtime.prompt('session', [{ type: 'text', text: 'controls' }]);
      await entered.promise;
      expect(calls).toEqual(['query']);
      gate.resolve(undefined);
      const event = await output.promise;
      expect(calls).toEqual(['query', 'start-worker']);
      expect(event.event.data).toMatchObject({
        message: { content: [{ text: expect.stringContaining('CONFLICT') }] },
      });
    } finally {
      gate.resolve(undefined);
      await h.close();
    }
  });

  it.each([
    [
      '超长帧',
      [frame('worker', 'start-worker', { instruction: 'a'.repeat(65536), deliverables: ['结果'] })],
    ],
    ['过多排队请求', Array.from({ length: 33 }, (_, index) => frame(String(index), 'query'))],
  ])('%s在执行控制动作前关闭通道', async (_name, frames) => {
    let calls = 0;
    const h = await harness(frames, () => {
      calls++;
      return { ok: true, value: [] };
    });
    try {
      const closed = deferred<undefined>();
      const off = h.runtime.onTaskChannelClose!(() => {
        closed.resolve(undefined);
      });
      await h.runtime.prompt('session', [{ type: 'text', text: 'too large' }]);
      await closed.promise;
      off();
      expect(calls).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('完整查询结果超过回执容量时明确拒绝，不截断业务结果', async () => {
    const h = await harness([frame('query', 'query')], () => ({
      ok: true,
      value: 'a'.repeat(65536),
    }));
    try {
      const output = deferred<SessionEventNotification>();
      h.runtime.once('session.event', output.resolve);
      await h.runtime.prompt('session', [{ type: 'text', text: 'query' }]);
      expect((await output.promise).event.data).toMatchObject({
        message: { content: [{ text: expect.stringContaining('控制回执超过容量') }] },
      });
    } finally {
      await h.close();
    }
  });
});
