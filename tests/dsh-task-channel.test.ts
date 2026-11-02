import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshRuntime } from '../src/dsh/process.js';
import { createNullLogger } from '../src/logger.js';

describe('模拟 DSH stdio + fd 3 控制通道（无端口）', () => {
  it('initialize 发送 reasoningEffort=off，管理工具通过独立通道往返', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-channel-')); const file = join(directory, 'mock.mjs');
    await writeFile(file, `
import { Socket } from 'node:net';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const control = new Socket({fd:3, readable:true, writable:true});
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let sessionId;
control.setEncoding('utf8');
control.on('data', text => {
  const result = JSON.parse(text);
  send({method:'session.event', params:{sessionId, event:{type:'assistant/message',seq:0,data:{message:{content:[{type:'text',text:JSON.stringify(result.value)}]}}}}});
});
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    writeFileSync('initialize.json', JSON.stringify(request.params));
    send({id:request.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'mock'}}});
  } else if (request.method === 'session/prompt') {
    sessionId=request.params.sessionId;
    send({id:request.id,result:{messageId:'prompt'}});
    control.write(JSON.stringify({id:'control',action:'query',sessionId})+'\\n');
  } else if (request.method === 'shutdown') {
    send({id:request.id,result:{}}); control.destroy(); process.exit(0);
  }
});
`);
    const calls: unknown[] = [];
    const runtime = new DshRuntime({ bin: 'mock', profilePatch: 'unused', cwd: directory, dshHome: directory, provider: 'mock', model: 'mock', reasoningEffort: 'off', startTimeoutMs: 1000, shutdownTimeoutMs: 1000, logger: createNullLogger(),
      spawnImpl: ((_bin, _args, options) => spawn(process.execPath, [file], options)) as typeof spawn,
      taskControl: request => { calls.push(request); return { verified: request.sessionId === 'bound-session' }; },
    });
    try {
      await runtime.start();
      const output = new Promise<{ event: { data: unknown } }>(resolve => runtime.once('session.event', resolve));
      await runtime.prompt('bound-session', [{ type: 'text', text: '查询任务' }]);
      expect((await output).event.data).toMatchObject({ message: { content: [{ type: 'text', text: '{"verified":true}' }] } });
      expect(calls).toHaveLength(1); expect(JSON.parse(await readFile(join(directory, 'initialize.json'), 'utf8')).reasoningEffort).toBe('off');
    } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
});
