import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { failure } from '@qqbot/contracts';
import type { SearchService, ContractFailure, WorkerServiceRequest } from '@qqbot/contracts';
import { createTaskControlBridgeV3, createTaskLifeCycleManagerV3 } from '../src/task/index.js';
import { createStateWriter } from '../src/store/index.js';
import { classifyTaskFollowUpV3, createSessionContextViewV3 } from '../src/session/index.js';
import { createRuntimeHarness, startWorker } from './helpers/task-v3-runtime.js';
import type { BenchmarkRuntime } from './bench/session/mock-runtime.js';

function service(
  runtime: BenchmarkRuntime,
  action: WorkerServiceRequest['action'],
  fields: Partial<WorkerServiceRequest> = {}
) {
  const env = runtime.options.env!;
  return runtime.options.workerServices!(
    {
      action,
      sessionId: runtime.prompts[0]!.sessionId,
      executionId: env.QQBOT_EXECUTION_ID!,
      runtimeGeneration: env.QQBOT_RUNTIME_GENERATION!,
      ...fields,
    },
    new AbortController().signal
  );
}
function searchService(error?: ContractFailure): SearchService {
  return {
    search: vi.fn(async () =>
      error
        ? { ok: false as const, error }
        : {
            ok: true as const,
            value: { sources: [{ url: 'https://source.example/a' }], truncated: false },
          }
    ),
    quotaFailure: () => undefined,
    close: () => {},
  };
}
const quota = (): ContractFailure => ({
  ...failure('UPSTREAM_FAILED', {
    kind: 'quota-exhausted',
    provider: 'offline',
    message: 'Monthly search quota exceeded',
    resetAt: '2026-12-01',
  }),
  retry: 'after-change',
  errorId: 'upstream-quota-error',
});

describe('V3查询授权和共享执行预算', () => {
  it('查询默认8条同代旧任务，UTF8序列化不超过48KiB，正文分页绑定版本', async () => {
    const h = await createRuntimeHarness();
    try {
      let oldId = '';
      const body = '正文😀\\"\n'.repeat(4000);
      for (let i = 0; i < 30; i++) {
        const old = await h.submit(`旧请求${i}`);
        (await h.started('frontend')).finish(body);
        await old.done;
        oldId = old.taskId;
      }
      const handle = await h.submit('查询旧结果');
      const frontend = await h.started('frontend');
      const task = h.system.manager.get(handle.taskId)!;
      const controls = createTaskControlBridgeV3(h.system.manager, () => {}, h.system.queue, {
        clock: h.clock,
      }).bind(task, task.frontend.initialJob, task.frontend.execution!);
      const compact = controls.querySummary();
      expect(compact.ok).toBe(true);
      if (!compact.ok) throw new Error('query failed');
      expect(compact.value.total).toBe(30);
      expect(compact.value.tasks).toHaveLength(8);
      expect(compact.value.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(48 * 1024);
      expect(JSON.stringify(compact)).not.toContain('originalInput');
      expect(JSON.stringify(compact)).not.toContain('assignment');
      const first = controls.readResult({ taskId: oldId, resultVersion: 0, source: 'reply' });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('read failed');
      expect(first.value.nextOffset).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(48 * 1024);
      const second = controls.readResult({
        taskId: oldId,
        resultVersion: 0,
        source: 'reply',
        offset: first.value.nextOffset,
      });
      expect(second).toMatchObject({ ok: true, value: { offset: first.value.nextOffset } });
      expect(
        controls.readResult({ taskId: oldId, resultVersion: 1, source: 'reply' })
      ).toMatchObject({ ok: false, error: { code: 'STALE_DATA' } });
      frontend.finish('旧结果保留。');
      await handle.done;
    } finally {
      await h.close();
    }
  });

  it('失败后闲聊只带摘要，明确重试绑定旧目标，引用和否定不授权', async () => {
    const h = await createRuntimeHarness();
    try {
      const old = await h.submit('调查这个问题');
      startWorker(await h.started('frontend'));
      (await h.started('worker')).finish('失败材料'.repeat(500), 'error');
      (await h.started('summary')).finish('本次调查未完成。');
      await old.done;
      const saved = h.system.manager.get(old.taskId)!;
      const classify = (content: string, parts?: import('@qqbot/contracts').MessagePart[]) =>
        classifyTaskFollowUpV3({
          message: { ...saved.input.message, content, parts },
          generation: saved.input.generation,
          tasks: [saved],
          now: h.clock.now(),
        });
      expect(classify('重试刚才那个任务')).toMatchObject({ retryOf: old.taskId });
      expect(classify('不要重试刚才那个任务').retryOf).toBeUndefined();
      expect(classify('他说“重试刚才那个任务”').retryOf).toBeUndefined();
      expect(
        classify('看看进度', [
          { type: 'text', text: '看看进度' },
          { type: 'quote', parts: [{ type: 'text', text: '重试刚才那个任务' }] },
        ]).retryOf
      ).toBeUndefined();
      const derived = await h.submit('基于刚才结果补一份说明');
      const derivedFrontend = await h.started('frontend');
      expect(h.system.manager.get(derived.taskId)?.input.followUpOf).toBe(old.taskId);
      expect(startWorker(derivedFrontend)).toMatchObject({ ok: true });
      (await h.started('worker')).finish('旧结果补充说明');
      (await h.started('summary')).finish('旧结果补充说明');
      await derived.done;
      const chat = await h.submit('你好');
      const frontend = await h.started('frontend');
      expect(JSON.stringify(frontend.prompts)).not.toContain('失败材料'.repeat(500));
      expect(JSON.stringify(frontend.prompts)).toContain('omittedChars');
      frontend.finish('你好');
      await chat.done;
      const retry = await h.submit('重试刚才那个任务');
      const retryFrontend = await h.started('frontend');
      expect(h.system.manager.get(retry.taskId)?.input.retryOf).toBe(old.taskId);
      expect(startWorker(retryFrontend)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
      expect(
        startWorker(retryFrontend, {
          instruction: '重试调查',
          deliverables: ['结果'],
          retryOf: old.taskId,
        })
      ).toMatchObject({ ok: true });
      expect(h.system.manager.get(retry.taskId)?.worker?.handoff.assignment.retryOf).toBe(
        old.taskId
      );
      const recovered = createTaskLifeCycleManagerV3({
        store: createStateWriter<unknown, 'tasks'>('tasks', join(h.paths.stateDir, 'tasks.json')),
        now: h.clock.now,
      });
      expect(recovered.get(retry.taskId)?.input.retryOf).toBe(old.taskId);
      expect(recovered.get(retry.taskId)?.worker?.handoff.assignment.retryOf).toBe(old.taskId);
      (await h.started('worker')).finish('已完成。');
      (await h.started('summary')).finish('已完成。');
      await retry.done;
    } finally {
      await h.close();
    }
  });

  it('进度查询被恶意模型派发时控制桥与生命周期都拒绝', async () => {
    const h = await createRuntimeHarness();
    try {
      const old = await h.submit('调查问题');
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      const progress = await h.submit('刚才那个任务好了没？');
      const frontend = await h.started('frontend');
      const task = h.system.manager.get(progress.taskId)!;
      expect(task.input.progressOnly).toBe(true);
      expect(startWorker(frontend)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(
        h.system.manager.acceptWorker({
          taskId: task.taskId,
          jobId: task.frontend.initialJob.jobId,
          execution: task.frontend.execution!,
          assignment: { instruction: '恶意重跑', deliverables: ['结果'] },
        })
      ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      frontend.finish('还在处理。');
      await progress.done;
      worker.finish('结果');
      (await h.started('summary')).finish('结果');
      await old.done;
    } finally {
      await h.close();
    }
  });

  it('根和子代理共享40个业务step，只给根一次无工具收尾', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      worker.child(true, 'child');
      expect(
        await service(worker, 'authorize-step', { sessionId: 'outsider', step: 1 })
      ).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
      for (let step = 1; step <= 20; step++) {
        expect(await service(worker, 'authorize-step', { step })).toMatchObject({
          ok: true,
          value: { kind: 'execute' },
        });
        expect(
          await service(worker, 'authorize-step', {
            sessionId: 'child',
            step: step <= 10 ? step : step - 10,
            turn: step <= 10 ? 1 : 2,
          })
        ).toMatchObject({ ok: true, value: { kind: 'execute' } });
      }
      expect(await service(worker, 'authorize-step', { step: 20 })).toMatchObject({
        ok: true,
        value: { kind: 'execute' },
      });
      expect(
        await service(worker, 'authorize-step', { sessionId: 'child', step: 21 })
      ).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
      expect(await service(worker, 'authorize-step', { step: 21 })).toMatchObject({
        ok: true,
        value: { kind: 'finish' },
      });
      expect(await service(worker, 'authorize-step', { step: 22 })).toMatchObject({
        ok: false,
        error: { code: 'CANCELLED' },
      });
      expect(worker.workerBudgets).toMatchObject([{ reason: 'step-budget' }]);
      worker.child(false, 'child');
      worker.finish('已完成部分结果。');
      (await h.started('summary')).finish('已完成部分结果。');
      const finished = await handle.done;
      expect(finished.worker?.result?.failure).toMatchObject({
        code: 'TIMEOUT',
        cause: { kind: 'execution-budget', reason: 'step-budget' },
      });
      expect(finished.worker?.result?.text).toBe('已完成部分结果。');
    } finally {
      await h.close();
    }
  });

  it('80%时间通知收尾，保留原硬截止和关闭时写下的部分正文', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      worker.event('assistant/message', {
        message: { content: [{ type: 'text', text: '前半段' }] },
      });
      worker.onDispose = async () => {
        worker.event('assistant/message', {
          interrupted: true,
          message: { content: [{ type: 'text', text: '关闭时保存的完整前缀' }] },
        });
        worker.finish('迟到成功');
        await mkdir(join(worker.options.cwd, h.config.media.outboxDir), { recursive: true });
        await writeFile(join(worker.options.cwd, h.config.media.outboxDir, 'partial.csv'), 'a,b');
      };
      const soft = h.config.tasks.slowTimeoutMs * h.config.tasks.workerSoftTimeoutRatio;
      h.clock.advance(soft);
      expect(worker.workerBudgets).toMatchObject([{ reason: 'time-budget' }]);
      expect(worker.disposed).toBe(0);
      h.clock.advance(h.config.tasks.slowTimeoutMs - soft);
      const summary = await h.started('summary');
      const result = h.system.manager.get(handle.taskId)?.worker?.result;
      expect(result?.status).toBe('failed');
      expect(result?.failure?.code).toBe('TIMEOUT');
      expect(result?.text).toBe('关闭时保存的完整前缀');
      expect(result?.attachments[0]?.fileName).toBe('partial.csv');
      summary.finish('处理超时，保留部分结果。');
      await handle.done;
    } finally {
      await h.close();
    }
  });

  it('搜索额度耗尽保存类型原因并停止工具，缓存额度直接拒绝必需搜索的派发', async () => {
    const provider = searchService(quota());
    const h = await createRuntimeHarness(undefined, undefined, provider);
    try {
      const handle = await h.submit('搜索资料');
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      expect(await service(worker, 'search', { request: { query: '资料' } })).toMatchObject({
        ok: false,
        error: { code: 'UPSTREAM_FAILED', retry: 'after-change' },
      });
      const summary = await h.started('summary');
      const result = h.system.manager.get(handle.taskId)?.worker?.result;
      expect(result?.failure?.cause).toMatchObject({ kind: 'quota-exhausted' });
      expect(JSON.stringify(summary.prompts)).toContain('Monthly search quota exceeded');
      expect(worker.workerBudgets).toMatchObject([{ reason: 'quota-exhausted' }]);
      summary.finish('搜索额度已用完。');
      await handle.done;
      provider.quotaFailure = () => quota();
      const next = await h.submit('再搜索资料');
      const frontend = await h.started('frontend');
      expect(
        startWorker(frontend, {
          instruction: '搜索资料',
          deliverables: ['结果'],
          requiredCapabilities: ['web-search'],
        })
      ).toMatchObject({ ok: false, error: { retry: 'after-change' } });
      expect((await next.done).frontend.failure?.cause).toMatchObject({ kind: 'quota-exhausted' });
    } finally {
      await h.close();
    }
  });

  it('正文文件只有当前用户明确要求且前台选择text-document时交付，规范路径去重', async () => {
    const h = await createRuntimeHarness();
    try {
      for (const requested of [false, true]) {
        const handle = await h.submit(requested ? '请生成txt报告文件' : '回答我的问题');
        const frontend = await h.started('frontend');
        const assignment = {
          instruction: '回答问题并制作文件',
          deliverables: ['结果'],
          deliveryIntent: 'text-document' as const,
          requiredCapabilities: ['web-search' as const],
        };
        expect(startWorker(frontend, assignment)).toMatchObject({ ok: true });
        const task = h.system.manager.get(handle.taskId)!;
        const request = {
          taskId: task.taskId,
          jobId: task.frontend.initialJob.jobId,
          execution: task.frontend.execution!,
        };
        expect(
          h.system.manager.acceptWorker({
            ...request,
            assignment: { ...assignment, deliveryIntent: 'chat' },
          })
        ).toMatchObject({
          ok: false,
          error: { code: 'CONFLICT' },
        });
        expect(
          h.system.manager.acceptWorker({
            ...request,
            assignment: { ...assignment, requiredCapabilities: [] },
          })
        ).toMatchObject({
          ok: false,
          error: { code: 'CONFLICT' },
        });
        const worker = await h.started('worker');
        const outbox = join(worker.options.cwd, h.config.media.outboxDir);
        await mkdir(outbox, { recursive: true });
        await writeFile(join(outbox, 'body.txt'), '完整正文');
        await writeFile(join(outbox, 'result.csv'), 'a,b');
        worker.finish('完整正文');
        (await h.started('summary')).finish('完整正文');
        const saved = await handle.done;
        expect(saved.worker?.handoff.assignment.deliveryIntent).toBe('text-document');
        expect(saved.worker?.handoff.assignment.requiredCapabilities).toEqual(['web-search']);
        const recovered = createTaskLifeCycleManagerV3({
          store: createStateWriter<unknown, 'tasks'>('tasks', join(h.paths.stateDir, 'tasks.json')),
          now: h.clock.now,
        });
        expect(recovered.get(handle.taskId)?.worker?.handoff.assignment).toEqual(
          saved.worker?.handoff.assignment
        );
        expect(recovered.get(handle.taskId)?.worker?.assignmentKey).toBe(
          saved.worker?.assignmentKey
        );
        expect(saved.finalReply?.attachments?.map((a) => a.fileName)).toEqual(
          requested ? ['body.txt', 'result.csv'] : ['result.csv']
        );
      }
    } finally {
      await h.close();
    }
  });

  it('已送达正文按保存的文本格式转换后核对，plain转换不会误报unknown', async () => {
    const h = await createRuntimeHarness();
    try {
      const old = await h.submit('输出带标题的结果');
      (await h.started('frontend')).finish('# 标题\n\n**结果**：20');
      await old.done;
      await h.sent(old.taskId);
      const current = await h.submit('基于刚才结果补充说明');
      const frontend = await h.started('frontend');
      const task = h.system.manager.get(current.taskId)!;
      const view = createSessionContextViewV3({
        tasks: (key) => h.system.manager.list(key),
        messages: (id) => h.system.queue.messages(id),
        generation: () => task.input.generation,
        now: h.clock.now,
      });
      expect(
        view.read(task).tasks.find((entry) => entry.taskId === old.taskId)?.frontend.delivery
      ).toBe('sent');
      frontend.finish('结果是20。');
      await current.done;
    } finally {
      await h.close();
    }
  });

  it('终态日志保留错误分类和原因类别，不输出正文与上游错误原文', async () => {
    const provider = searchService(quota());
    const h = await createRuntimeHarness(undefined, undefined, provider);
    try {
      const handle = await h.submit('用户正文秘密XYZ');
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      await service(worker, 'search', { request: { query: '秘密搜索' } });
      (await h.started('summary')).finish('额度已用完。');
      await handle.done;
      const records = h.logRecords.filter(
        (record) => record.event === 'task.terminal' || record.msg === 'task.terminal'
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        code: 'UPSTREAM_FAILED',
        retry: 'after-change',
        errorId: 'upstream-quota-error',
        causeKind: 'quota-exhausted',
      });
      expect(JSON.stringify(records)).not.toContain('用户正文秘密XYZ');
      expect(JSON.stringify(records)).not.toContain('Monthly search quota exceeded');
    } finally {
      await h.close();
    }
  });

  it('普通搜索故障只允许3个当前用户或本次来源链接，拒绝猜测地址', async () => {
    const provider = searchService();
    const h = await createRuntimeHarness(undefined, undefined, provider);
    try {
      const handle = await h.submit(
        '读取 https://user.example/a https://user.example/b https://user.example/c'
      );
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      expect(await service(worker, 'search', { request: { query: '资料' } })).toMatchObject({
        ok: true,
      });
      provider.search = vi.fn(async () => ({
        ok: false as const,
        error: failure('UPSTREAM_FAILED', {
          kind: 'service-error',
          provider: 'offline',
          message: 'temporary outage',
        }),
      }));
      expect(await service(worker, 'search', { request: { query: '补充' } })).toMatchObject({
        ok: false,
      });
      expect(
        await service(worker, 'authorize-fetch', { url: 'https://guessed.example/a' })
      ).toMatchObject({ ok: false });
      for (const url of [
        'https://user.example/a',
        'https://user.example/b',
        'https://source.example/a',
      ])
        expect(await service(worker, 'authorize-fetch', { url })).toMatchObject({ ok: true });
      expect(
        await service(worker, 'authorize-fetch', { url: 'https://user.example/c' })
      ).toMatchObject({ ok: false });
      const before = vi.mocked(provider.search).mock.calls.length;
      await service(worker, 'search', { request: { query: '再搜' } });
      expect(vi.mocked(provider.search)).toHaveBeenCalledTimes(before);
      worker.finish('部分来源已读取。');
      (await h.started('summary')).finish('部分来源已读取。');
      await handle.done;
      const repeated = await h.submit('读取 https://user.example/repeat');
      startWorker(await h.started('frontend'));
      const repeatedWorker = await h.started('worker');
      repeatedWorker.child(true, 'repeat-child');
      await service(repeatedWorker, 'search', { request: { query: '再次资料' } });
      for (const sessionId of [
        repeatedWorker.prompts[0]!.sessionId,
        'repeat-child',
        repeatedWorker.prompts[0]!.sessionId,
      ])
        expect(
          await service(repeatedWorker, 'authorize-fetch', {
            sessionId,
            url: 'https://user.example/repeat',
          })
        ).toMatchObject({ ok: true });
      expect(
        await service(repeatedWorker, 'authorize-fetch', {
          sessionId: 'repeat-child',
          url: 'https://user.example/repeat',
        })
      ).toMatchObject({ ok: false });
      repeatedWorker.child(false, 'repeat-child');
      repeatedWorker.finish('保留已有资料。');
      (await h.started('summary')).finish('保留已有资料。');
      await repeated.done;
    } finally {
      await h.close();
    }
  });
});
