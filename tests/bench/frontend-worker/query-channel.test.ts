import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import type { SessionEventNotification, TaskInput } from '@qqbot/contracts';
import {
  createTaskLifeCycleManagerV3,
  createTaskControlBridgeV3,
} from '../../../src/task/index.js';
import { createDshRuntime } from '../../../src/runtime/index.js';
import { createNullLogger } from '../../../src/observability/index.js';
import { deferred } from './harness.js';
import { recordBenchmarkEvidence } from './evidence.js';

const childSource = `
import {Socket} from 'node:net';
import {createInterface} from 'node:readline';
const channel=new Socket({fd:3,readable:true,writable:true});
let sessionId;const frames=JSON.parse(process.env.TEST_FRAMES),responses=[];
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:channel}).on('line',line=>{responses.push({bytes:Buffer.byteLength(line),value:JSON.parse(line)});if(responses.length===frames.length)send({method:'session.event',params:{sessionId,event:{type:'assistant/message',seq:0,data:{responses}}}})});
channel.on('error',()=>{});
createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.method==='initialize')send({id:request.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'offline'}}});else if(request.method==='session/prompt'){sessionId=request.params.sessionId;send({id:request.id,result:{messageId:'prompt'}});channel.write(frames.map(frame=>JSON.stringify(frame)+'\\n').join(''))}else if(request.method==='shutdown'){send({id:request.id,result:{}});channel.destroy();process.exit(0)}});
`;

it('30个中文转义大快照经真实fd3紧凑投影并按版本分段读取，伪造大响应被同一通道拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'task-query-channel-'));
  const file = join(directory, 'child.mjs');
  await writeFile(file, childSource);
  const manager = createTaskLifeCycleManagerV3({
    maxPerSession: 100,
    maxGlobal: 100,
    now: () => 1_700_000_000_000,
  });
  const body = '完整正文中文👩‍💻"\\\n'.repeat(12_000);
  const inputBody = body.slice(0, 8000);
  const input: TaskInput = {
    source: 'user',
    generation: 1,
    isAdmin: false,
    message: {
      kind: 'group-message',
      target: { platform: 'onebot', kind: 'group', id: 'group', key: 'onebot:group:group' },
      senderId: 'member',
      content: inputBody,
      msgId: 'message',
      eventId: 'message',
      ts: 1_700_000_000_000,
      raw: { untrusted: inputBody },
    },
    reference: {
      messageId: 'message',
      senderId: 'member',
      excerpt: inputBody,
      ts: 1_700_000_000_000,
    },
    context: { replay: inputBody, window: [] },
  };
  for (let i = 0; i < 30; i++) {
    const created = manager.create(input, `old-${i}`);
    expect(created.ok).toBe(true);
    const task = manager.get(`old-${i}`)!;
    expect(manager.claimJob(task.frontend.initialJob.jobId).ok).toBe(true);
    const frontendExecution = {
      jobId: task.frontend.initialJob.jobId,
      executionId: `frontend-${i}`,
      runtimeGeneration: 'generation',
      sessionId: `frontend-${i}`,
    };
    expect(manager.bindExecution(task.taskId, frontendExecution.jobId, frontendExecution).ok).toBe(
      true
    );
    expect(
      manager.acceptWorker({
        taskId: task.taskId,
        jobId: frontendExecution.jobId,
        execution: frontendExecution,
        assignment: { instruction: inputBody, deliverables: ['结果'], deliveryIntent: 'chat' },
      })
    ).toMatchObject({ ok: true });
    expect(
      manager.finishFrontend(task.taskId, frontendExecution.jobId, {
        ok: true,
        value: { kind: 'dispatched' },
      }).ok
    ).toBe(true);
    const workerJob = manager
      .pendingJobs()
      .find((job) => job.taskId === task.taskId && job.kind === 'worker')!;
    expect(manager.claimJob(workerJob.jobId).ok).toBe(true);
    const workerExecution = {
      jobId: workerJob.jobId,
      executionId: `worker-${i}`,
      runtimeGeneration: 'generation',
      sessionId: `worker-${i}`,
    };
    expect(manager.bindExecution(task.taskId, workerJob.jobId, workerExecution).ok).toBe(true);
    expect(
      manager.saveWorkerResult(task.taskId, workerJob.jobId, {
        ok: true,
        value: {
          status: 'completed',
          text: body,
          evidence: [body],
          attachments: [],
          unfinished: [],
        },
      }).ok
    ).toBe(true);
    const summaryJob = manager.get(task.taskId)!.frontend.summaryJob!;
    expect(manager.claimJob(summaryJob.jobId).ok).toBe(true);
    expect(
      manager.saveFinalReply(task.taskId, summaryJob.jobId, {
        ok: true,
        value: { replyId: `reply-${i}`, text: body },
      }).ok
    ).toBe(true);
    expect(
      manager.confirmEnqueued(task.taskId, manager.get(task.taskId)!.finalReply!.replyId).ok
    ).toBe(true);
  }
  expect(Buffer.byteLength(JSON.stringify(manager.list()))).toBeGreaterThan(10 * 1024 * 1024);
  const caller = manager.create(
    { ...input, message: { ...input.message, content: '查询结果' } },
    'caller'
  );
  expect(caller.ok).toBe(true);
  const task = manager.get('caller')!;
  expect(manager.claimJob(task.frontend.initialJob.jobId).ok).toBe(true);
  const execution = {
    jobId: task.frontend.initialJob.jobId,
    executionId: 'execution',
    runtimeGeneration: 'generation',
    sessionId: 'session',
  };
  expect(manager.bindExecution(task.taskId, execution.jobId, execution).ok).toBe(true);
  const controls = createTaskControlBridgeV3(manager, () => {}).bind(
    manager.get('caller')!,
    task.frontend.initialJob,
    execution
  );
  const frames = [
    { id: 'compact', action: 'query-summary' },
    { id: 'bounded', action: 'query-summary', query: { limit: 20 } },
    {
      id: 'first',
      action: 'read-result',
      resultRequest: { taskId: 'old-29', source: 'reply', resultVersion: 1 },
    },
    {
      id: 'stale',
      action: 'read-result',
      resultRequest: { taskId: 'old-29', source: 'reply', resultVersion: 99 },
    },
    { id: 'malformed-large', action: 'query' },
  ].map((frame) => ({
    ...frame,
    sessionId: 'session',
    executionId: 'execution',
    runtimeGeneration: 'generation',
  }));
  const runtime = createDshRuntime({
    bin: 'offline',
    profilePatch: 'unused',
    cwd: directory,
    dshHome: directory,
    provider: 'offline',
    model: 'offline',
    startTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    logger: createNullLogger(),
    env: { QQBOT_ROLE: 'frontend', TEST_FRAMES: JSON.stringify(frames) },
    spawnImpl: ((_bin: string, _args: string[], options: SpawnOptions) =>
      spawn(process.execPath, [file], options)) as unknown as typeof spawn,
    taskControl: (request) => {
      if (request.action === 'query-summary') return controls.querySummary(request.query);
      if (request.action === 'read-result') return controls.readResult(request.resultRequest!);
      return { ok: true, value: { text: body } };
    },
  });
  try {
    await runtime.start();
    const event = deferred<SessionEventNotification>();
    runtime.once('session.event', event.resolve);
    await runtime.prompt('session', [{ type: 'text', text: '查询旧结果' }]);
    const raw: unknown = (await event.promise).event.data.responses;
    expect(Array.isArray(raw)).toBe(true);
    if (!Array.isArray(raw)) throw new Error('fd3响应缺失');
    const responses = raw.map((row: unknown) => {
      const record = channelRecord(row);
      const frame = channelRecord(record.value);
      const result = channelRecord(frame.value);
      if (
        typeof record.bytes !== 'number' ||
        typeof frame.id !== 'string' ||
        typeof result.ok !== 'boolean'
      )
        throw new Error('fd3响应字段无效');
      return {
        bytes: record.bytes,
        result,
        projection: result.ok ? channelRecord(result.value) : undefined,
      };
    });
    expect(responses.every((response) => response.bytes < 64 * 1024)).toBe(true);
    expect(responses[0]?.bytes).toBeLessThanOrEqual(48 * 1024);
    expect(responses[0]?.projection?.total).toBe(30);
    const tasks = responses[0]?.projection?.tasks;
    expect(Array.isArray(tasks)).toBe(true);
    if (!Array.isArray(tasks)) throw new Error('紧凑查询缺少任务数组');
    expect(tasks.length).toBeLessThanOrEqual(8);
    expect(tasks.length).toBeGreaterThan(0);
    expect(responses[0]?.result).toMatchObject({ ok: true, value: { truncated: true } });
    const boundedTasks = responses[1]?.projection?.tasks;
    expect(Array.isArray(boundedTasks)).toBe(true);
    if (!Array.isArray(boundedTasks)) throw new Error('上限查询缺少任务数组');
    expect(boundedTasks.length).toBeLessThanOrEqual(20);
    expect(responses[1]?.result).toMatchObject({ ok: true, value: { truncated: true } });
    expect(responses[1]?.bytes).toBeLessThanOrEqual(48 * 1024);
    const pageText = responses[2]?.projection?.text;
    expect(typeof pageText).toBe('string');
    if (typeof pageText !== 'string') throw new Error('正文分段缺少text');
    expect(pageText.length).toBeLessThan(body.length);
    expect(responses[2]?.projection?.nextOffset).toBeGreaterThan(0);
    expect(responses[3]?.result).toMatchObject({ ok: false, error: { code: 'STALE_DATA' } });
    expect(responses[4]?.result.ok).toBe(false);
    await recordBenchmarkEvidence('actual-query-fd3', {
      snapshots: 30,
      savedSnapshotBytes: Buffer.byteLength(JSON.stringify(manager.list())),
      responseBytes: responses.map((response) => response.bytes),
      statuses: responses.map((response) => response.result.ok),
    });
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  await recordBenchmarkEvidence('actual-query-fd3-closed', {
    runtimeState: runtime.state,
    eventListeners: runtime.listenerCount('session.event'),
  });
});

function channelRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('fd3响应不是对象');
  return value as Record<string, unknown>;
}
