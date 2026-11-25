import { mkdir, writeFile, readFile, realpath, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failure } from '@qqbot/contracts';
import {
  createTaskControlBridgeV3,
  createPromptPreparerV3,
  createTaskLifeCycleManagerV3,
} from '../src/task/index.js';
import { createLogger, createPipelineStats } from '../src/observability/index.js';
import {
  createConversationStore,
  workspacePathFor,
  conversationFileFor,
  createStateWriter,
} from '../src/store/index.js';
import { createRuntimeHarness, startWorker, workerText } from './helpers/task-v3-runtime.js';

describe('V3真实运行编排、注入DSH事件与本地文件', () => {
  it('stop取消后保存同一worker的部分正文和真实文件，重复收尾与重启仍保持取消', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      const outbox = join(worker.options.cwd, h.config.media.outboxDir);
      await mkdir(outbox, { recursive: true });
      await writeFile(join(outbox, 'partial.csv'), '已完成第一项');
      worker.event('tool/call', { name: 'bash' });
      worker.event('assistant/message', {
        message: { content: [{ type: 'text', text: '已完成第一项，后续尚未完成。' }] },
      });
      expect(h.system.actor.stop('onebot:group:group')).toBe(1);
      const stopped = await handle.done;
      const collected = await h.observe(
        (task) =>
          task.taskId === handle.taskId &&
          task.worker?.result?.text === '已完成第一项，后续尚未完成。'
      );
      expect(collected).toMatchObject({
        status: 'cancelled',
        phase: 'terminal',
        cancelAccepted: true,
        endedAt: stopped.endedAt,
        worker: {
          receipt: { status: 'cancelled' },
          endedAt: stopped.worker?.endedAt,
          result: { status: 'cancelled', failure: { code: 'CANCELLED' } },
        },
      });
      expect(collected.worker?.result?.evidence).toContain('已记录工具调用：1次。');
      const result = collected.worker!.result!;
      expect(await readFile(result.attachments[0]!.absPath, 'utf8')).toBe('已完成第一项');
      const before = structuredClone(collected);
      expect(
        h.system.manager.saveWorkerResult(handle.taskId, collected.worker!.receipt.jobId, {
          ok: true,
          value: {
            ...result,
            evidence: [...result.evidence],
            attachments: result.attachments.map((attachment) => ({ ...attachment })),
            unfinished: [...result.unfinished],
          },
        }).ok
      ).toBe(true);
      expect(h.system.manager.get(handle.taskId)).toEqual(before);
      expect(h.system.manager.pendingJobs()).toEqual([]);
      expect(h.runtimes).toHaveLength(2);
      expect(worker.disposed).toBe(1);
      expect(h.connector.actions).toEqual([]);
      const restarted = createTaskLifeCycleManagerV3({
        store: createStateWriter<unknown, 'tasks'>('tasks', join(h.paths.stateDir, 'tasks.json')),
        now: h.clock.now,
      });
      expect(restarted.recover().ok).toBe(true);
      expect(restarted.get(handle.taskId)).toEqual(before);
      expect(restarted.pendingJobs()).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('说明加合法围栏JSON保留完整正文、运行证据和result.csv并实际发送', async () => {
    const h = await createRuntimeHarness();
    try {
      const body = await readFile(
        new URL('./fixtures/worker-result-with-fenced-json.txt', import.meta.url),
        'utf8'
      );
      const handle = await h.submit('计算12+8并给出报告');
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      const outbox = join(worker.options.cwd, h.config.media.outboxDir);
      await mkdir(outbox, { recursive: true });
      const content = '12+8=20\n完整计算报告\n';
      await writeFile(join(outbox, 'result.csv'), content);
      worker.event('tool/call', { name: 'bash' });
      worker.finish(body);
      const summary = await h.started('summary');
      const result = h.system.manager.get(handle.taskId)!.worker!.result!;
      expect(result.status).toBe('completed');
      expect(result.text).toBe(body.trim());
      expect(result.evidence).toContain('执行正常结束。');
      expect(result.evidence).toContain('已记录工具调用：1次。');
      expect(result.evidence.join(' ')).toContain('result.csv');
      expect(summary.prompts[0]?.blocks[0]).toMatchObject({
        text: expect.stringContaining(JSON.stringify(body.trim())),
      });
      summary.finish('结果是20，完整报告见附件。');
      expect((await handle.done).status).toBe('completed');
      await h.sent(handle.taskId);
      expect(h.connector.actions.flatMap((action) => action.attachments)).toContainEqual(
        expect.objectContaining({ fileName: 'result.csv', text: content })
      );
      expect(h.system.queue.taskDelivery(handle.taskId)).toMatchObject({
        success: true,
        pending: false,
      });
    } finally {
      await h.close();
    }
  });

  it.each([
    '普通完整报告。',
    '# 报告\n\n已完成调查，第三项待确认。',
    '{"status":"failed","text":"还缺一项业务材料"}',
    'NO_REPLY',
  ])('worker正常结束保留正文 %s，正文不改变运行分类', async (body) => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      startWorker(await h.started('frontend'));
      (await h.started('worker')).finish(body);
      const summary = await h.started('summary');
      expect(h.system.manager.get(handle.taskId)?.worker?.result).toMatchObject({
        status: 'completed',
        text: body,
        unfinished: [],
      });
      summary.finish('现有报告已返回，待确认的事项保留在说明中。');
      expect((await handle.done).status).toBe('completed');
    } finally {
      await h.close();
    }
  });

  it.each([false, true])('worker空正文、存在附件 %s 时仍正常结束并如实整理', async (hasFile) => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      if (hasFile) {
        const outbox = join(worker.options.cwd, h.config.media.outboxDir);
        await mkdir(outbox, { recursive: true });
        await writeFile(join(outbox, 'only.csv'), '只有附件');
      }
      worker.finish('  \n ');
      const summary = await h.started('summary');
      expect(h.system.manager.get(handle.taskId)?.worker?.result).toMatchObject({
        status: 'completed',
        text: '',
      });
      const prompt = summary.prompts[0]!.blocks[0]!;
      expect(prompt).toMatchObject({
        text: expect.stringContaining(hasFile ? 'only.csv' : '本次没有返回正文或附件'),
      });
      summary.finish(hasFile ? '文件已返回，见附件。' : '这次没有返回结果。');
      const task = await handle.done;
      expect(task.status).toBe('completed');
      expect(task.finalReply?.attachments).toHaveLength(hasFile ? 1 : 0);
    } finally {
      await h.close();
    }
  });

  it.each(['timeout', 'child-failed'] as const)(
    '%s 保留部分正文、运行证据及有效文件',
    async (mode) => {
      const h = await createRuntimeHarness();
      try {
        const handle = await h.submit();
        startWorker(await h.started('frontend'));
        const worker = await h.started('worker');
        const outbox = join(worker.options.cwd, h.config.media.outboxDir);
        await mkdir(outbox, { recursive: true });
        await writeFile(join(outbox, 'partial.csv'), '已完成第一项');
        worker.event('tool/call', { name: 'bash' });
        if (mode === 'timeout') {
          worker.event('assistant/message', {
            message: { content: [{ type: 'text', text: '已完成第一项，第二项未完成。' }] },
          });
          h.clock.advance(h.config.tasks.slowTimeoutMs);
        } else {
          worker.child(true, 'child');
          worker.finish('已完成第一项，第二项未完成。');
          worker.child(false, 'child', 'error');
        }
        const summary = await h.started('summary');
        const result = h.system.manager.get(handle.taskId)!.worker!.result!;
        expect(result.status).toBe('failed');
        expect(result.failure?.code).toBe(mode === 'timeout' ? 'TIMEOUT' : 'UPSTREAM_FAILED');
        expect(result.text).toBe('已完成第一项，第二项未完成。');
        expect(result.evidence).toContain('已记录工具调用：1次。');
        expect(result.attachments[0]?.fileName).toBe('partial.csv');
        summary.finish('已完成第一项，第二项未完成，现有文件见附件。');
        expect((await handle.done).status).toBe('failed');
      } finally {
        await h.close();
      }
    }
  );

  it('整理材料使用自然失败说明，排除原始异常、内部身份和路径', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit('给我当前结果');
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      const task = h.system.manager.get(handle.taskId)!;
      expect(
        h.system.manager.saveWorkerResult(handle.taskId, task.worker!.receipt.jobId, {
          ok: true,
          value: {
            status: 'failed',
            text: '第一项调查已完成。',
            evidence: ['已核对来源 https://example.com/report'],
            attachments: [],
            unfinished: ['第三项仍缺确认材料。', '执行未完成，详情见失败分类。'],
            failure: failure(
              'UPSTREAM_FAILED',
              { message: 'private-stack-secret', path: '/private/internal/path' },
              'private-error-id'
            ),
          },
        }).ok
      ).toBe(true);
      worker.finish('迟到的正文');
      const summary = await h.started('summary');
      const prompt = summary.prompts[0]!.blocks[0]!;
      expect(prompt).toMatchObject({
        text: expect.stringContaining('处理未能顺利结束，现有内容已保留。'),
      });
      expect(prompt).toMatchObject({ text: expect.stringContaining('第一项调查已完成。') });
      for (const diagnostic of [
        'private-stack-secret',
        '/private/internal/path',
        'private-error-id',
        'UPSTREAM_FAILED',
        'runtimeGeneration',
        'errorId',
        '"status":',
      ])
        expect(prompt).toMatchObject({ text: expect.not.stringContaining(diagnostic) });
      expect(prompt).toMatchObject({ text: expect.stringContaining('第三项仍缺确认材料。') });
      expect(prompt).toMatchObject({ text: expect.not.stringContaining('详情见失败分类') });
      summary.finish('第一项调查已完成，后续处理遇到问题。');
      await handle.done;
    } finally {
      await h.close();
    }
  });

  it('历史V3待整理结果重启后保留独立引用和未完成材料', async () => {
    const original = await createRuntimeHarness();
    let restored: Awaited<ReturnType<typeof createRuntimeHarness>> | undefined;
    try {
      const handle = await original.submit('整理上次调查结果');
      startWorker(await original.started('frontend'));
      await original.started('worker');
      const task = original.system.manager.get(handle.taskId)!;
      expect(
        original.system.manager.saveWorkerResult(handle.taskId, task.worker!.receipt.jobId, {
          ok: true,
          value: {
            status: 'completed',
            text: '调查正文。',
            evidence: ['引用 https://example.com/source'],
            unfinished: ['第三项待提供签字文件。'],
            attachments: [],
          },
        }).ok
      ).toBe(true);
      const saved = original.system.manager.get(handle.taskId)!;
      restored = await createRuntimeHarness(undefined, [saved]);
      expect(restored.system.actor.recover().ok).toBe(true);
      const summary = await restored.started('summary');
      expect(summary.prompts[0]?.blocks[0]).toMatchObject({
        text: expect.stringContaining('https://example.com/source'),
      });
      expect(summary.prompts[0]?.blocks[0]).toMatchObject({
        text: expect.stringContaining('第三项待提供签字文件。'),
      });
      expect(restored.system.manager.get(handle.taskId)?.worker?.result).toEqual(
        saved.worker?.result
      );
      summary.finish('调查正文已保留，第三项仍需提供签字文件。');
      await restored.observe(
        (value) => value.taskId === handle.taskId && value.status === 'completed'
      );
    } finally {
      await restored?.close();
      await original.close();
    }
  });

  it('worker拒绝指向其他任务目录的整个outbox', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      const otherOutbox = join(h.root, 'other-task', 'outbox');
      await mkdir(otherOutbox, { recursive: true });
      await writeFile(join(otherOutbox, 'other.txt'), '其他任务文件');
      await symlink(otherOutbox, join(worker.options.cwd, h.config.media.outboxDir));
      worker.finish('当前任务正文。');
      const summary = await h.started('summary');
      expect(h.system.manager.get(handle.taskId)?.worker?.result).toMatchObject({
        status: 'failed',
        text: '当前任务正文。',
        failure: { code: 'INVALID_INPUT' },
        attachments: [],
      });
      summary.finish('正文已保留，附件检查遇到问题。');
      expect((await handle.done).status).toBe('failed');
      expect(h.connector.actions.flatMap((action) => action.attachments)).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('整理拒绝保存结果中来自其他任务的真实规范文件路径', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      const outbox = join(worker.options.cwd, h.config.media.outboxDir);
      await mkdir(outbox, { recursive: true });
      const otherOutbox = join(h.root, 'other-task', 'outbox');
      await mkdir(otherOutbox, { recursive: true });
      const foreign = join(otherOutbox, 'other.txt');
      await writeFile(foreign, 'other');
      const task = h.system.manager.get(handle.taskId)!;
      expect(
        h.system.manager.saveWorkerResult(handle.taskId, task.worker!.receipt.jobId, {
          ok: true,
          value: {
            status: 'completed',
            text: '当前任务正文。',
            evidence: [],
            unfinished: [],
            attachments: [
              {
                kind: 'file',
                absPath: await realpath(foreign),
                fileName: 'other.txt',
                sizeBytes: 5,
              },
            ],
          },
        }).ok
      ).toBe(true);
      worker.finish('迟到正文');
      (await h.started('summary')).finish('报告见附件。');
      const saved = await handle.done;
      expect(saved.status).toBe('failed');
      expect(saved.frontend.failure?.code).toBe('INVALID_INPUT');
      expect(saved.finalReply?.attachments).toBeUndefined();
      expect(h.connector.actions.flatMap((action) => action.attachments)).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('outbox指向当前worker内目录、文件内部链接仍能正常交付', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      const owned = join(worker.options.cwd, 'deliverables');
      await mkdir(owned, { recursive: true });
      await writeFile(join(owned, 'report.csv'), '报告');
      await symlink(join(owned, 'report.csv'), join(owned, 'copy.csv'));
      await symlink(owned, join(worker.options.cwd, h.config.media.outboxDir));
      worker.finish('报告已完成。');
      (await h.started('summary')).finish('报告见附件。');
      const task = await handle.done;
      expect(task.status).toBe('completed');
      expect(task.finalReply?.attachments?.map((attachment) => attachment.fileName)).toEqual([
        'copy.csv',
      ]);
    } finally {
      await h.close();
    }
  });

  it('full模式读取旧背景失败时仍执行当前已授权的普通请求', async () => {
    const h = await createRuntimeHarness({
      sessionContext: { mode: 'full', maxRecentMessages: 12 },
    });
    try {
      const file = conversationFileFor(h.paths, 'onebot:group:group');
      await writeFile(file, 'corrupt-history\n');
      const handle = await h.submit('回答当前问题');
      const frontend = await h.started('frontend');
      frontend.finish('当前问题的答复');
      expect((await handle.done).finalReply?.text).toBe('当前问题的答复');
      expect(h.runtimes).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('普通前台答复不创建worker，执行结束回收进程、监听和时钟', async () => {
    const h = await createRuntimeHarness();
    try {
      expect(h.runtimes).toHaveLength(0);
      const handle = await h.submit('你好');
      const frontend = await h.started('frontend');
      expect(frontend.options).toMatchObject({
        provider: h.config.tasks.taskProvider,
        model: h.config.tasks.taskModel,
        reasoningEffort: 'high',
      });
      frontend.finish('你好，收到。');
      expect((await handle.done).finalReply?.text).toBe('你好，收到。');
      expect(h.runtimes).toHaveLength(1);
      expect(frontend.disposed).toBe(1);
      expect(frontend.listenerCount('session.event')).toBe(0);
      expect(frontend.listenerCount('task.channel.closed')).toBe(0);
      expect(h.system.pools.frontend.size).toBe(0);
    } finally {
      await h.close();
    }
    expect(h.clock.pending).toBe(0);
  });

  it('fd3断开立即结束未派发前台，超时也不自动建worker', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      const frontend = await h.started('frontend');
      frontend.emit('task.channel.closed');
      const task = await handle.done;
      expect(task.status).toBe('failed');
      expect(task.frontend.failure?.code).toBe('UPSTREAM_FAILED');
      expect(task.worker).toBeUndefined();
      const timeout = await h.submit();
      await h.started('frontend');
      h.clock.advance(h.config.tasks.fastTimeoutMs);
      expect((await timeout.done).worker).toBeUndefined();
      expect(h.runtimes).toHaveLength(2);
    } finally {
      await h.close();
    }
  });

  it('接受请求已保存即结束前台，回执缺失和通道断开仍执行一次worker', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      const frontend = await h.started('frontend');
      const task = h.system.manager.get(handle.taskId)!;
      const accepted = h.system.manager.acceptWorker({
        taskId: task.taskId,
        jobId: task.frontend.initialJob.jobId,
        execution: task.frontend.execution!,
        assignment: { instruction: '保存后回执丢失', deliverables: ['结果'] },
      });
      expect(accepted.ok).toBe(true);
      frontend.emit('task.channel.closed');
      const worker = await h.started('worker');
      expect(frontend.disposed).toBe(1);
      worker.finish(workerText());
      const summary = await h.started('summary');
      summary.finish('结果是20。');
      expect((await handle.done).status).toBe('completed');
      expect(
        h.runtimes.filter((runtime) => runtime.options.env?.QQBOT_ROLE === 'worker')
      ).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('worker等待全部子代理，完整业务结果和附件只交给新前台整理', async () => {
    const h = await createRuntimeHarness();
    try {
      const session = workspacePathFor(h.paths, 'onebot:group:group');
      await mkdir(session, { recursive: true });
      await writeFile(
        join(session, 'AGENTS.md'),
        '业务规则\n<!-- qqbot-persona:begin -->\n旧角色\n<!-- qqbot-persona:end -->'
      );
      const handle = await h.submit();
      const frontend = await h.started('frontend');
      expect(startWorker(frontend)).toMatchObject({ ok: true });
      const worker = await h.started('worker');
      expect(worker.options.taskControl).toBeUndefined();
      expect(worker.options.taskCooperation).toBeUndefined();
      expect((await readFile(join(worker.options.cwd, 'AGENTS.md'), 'utf8')).trim()).toBe(
        '业务规则'
      );
      const outbox = join(worker.options.cwd, h.config.media.outboxDir);
      await mkdir(outbox, { recursive: true });
      const file = join(outbox, 'report.csv');
      await writeFile(file, 'name,total\nA,20\n');
      worker.child(true, 'child');
      worker.emit('subagent.started', { parentSessionId: 'child', childSessionId: 'grandchild' });
      worker.finish(workerText());
      expect(worker.disposed).toBe(0);
      worker.child(false, 'child');
      expect(worker.disposed).toBe(0);
      await writeFile(
        join(session, 'AGENTS.md'),
        '只说摘要的新业务规则\n<!-- qqbot-persona:begin -->\n新角色\n<!-- qqbot-persona:end -->'
      );
      worker.emit('subagent.finished', {
        parentSessionId: 'child',
        childSessionId: 'grandchild',
        status: 'ok',
      });
      const summary = await h.started('summary');
      expect(worker.disposed).toBe(1);
      expect(await readFile(join(summary.options.cwd, 'AGENTS.md'), 'utf8')).toContain('新角色');
      expect(await readFile(join(summary.options.cwd, 'AGENTS.md'), 'utf8')).toContain('业务规则');
      expect(await readFile(join(summary.options.cwd, 'AGENTS.md'), 'utf8')).not.toContain(
        '只说摘要的新业务规则'
      );
      const result = h.system.manager.get(handle.taskId)!.worker!.result!;
      expect(result.text).toBe(workerText());
      expect(result.evidence).toContain('执行正常结束。');
      expect(result.evidence.join(' ')).toContain('report.csv');
      expect(summary.prompts[0]?.blocks[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('report.csv'),
      });
      summary.finish('已算出20，报告在附件里。');
      const task = await handle.done;
      expect(task.finalReply?.attachments?.[0]?.absPath).toBe(await realpath(file));
      expect(h.connector.actions.some((action) => action.text === '完整业务结果：20')).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('worker进程退出保留未知状态、部分正文和证据', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      const outbox = join(worker.options.cwd, h.config.media.outboxDir);
      await mkdir(outbox, { recursive: true });
      await writeFile(join(outbox, 'oversize.csv'), Buffer.alloc(h.config.media.maxFileBytes + 1));
      await writeFile(join(outbox, 'partial.csv'), 'total\n20\n');
      worker.event('tool/call', { name: 'bash' });
      worker.event('assistant/message', {
        message: { content: [{ type: 'text', text: `${workerText()}\n缺少最终确认。` }] },
      });
      worker.emit('exit', 1, null);
      const summary = await h.started('summary');
      const result = h.system.manager.get(handle.taskId)!.worker!.result!;
      expect(result.status).toBe('unknown');
      expect(result.text).toBe(`${workerText()}\n缺少最终确认。`);
      expect(result.evidence).toContain('已记录工具调用：1次。');
      expect(result.failure?.code).toBe('UNKNOWN_OUTCOME');
      expect(result.attachments.map((attachment) => attachment.fileName)).toEqual(['partial.csv']);
      expect(result.unfinished.join(' ')).toContain('完成情况暂时无法确认');
      expect(result.unfinished.join(' ')).toContain('oversize.csv');
      expect(summary.prompts[0]?.blocks[0]).toMatchObject({
        text: expect.stringContaining('oversize.csv'),
      });
      summary.finish('已完成部分计算，最后结果还没确认。');
      expect((await handle.done).status).toBe('failed');
    } finally {
      await h.close();
    }
  });

  it('排队worker读取启动时最新旧任务结果，按已完成业务继续执行', async () => {
    const h = await createRuntimeHarness();
    try {
      const old = await h.submit('计算旧结果');
      startWorker(await h.started('frontend'));
      const oldWorker = await h.started('worker');
      const followup = await h.submit('基于刚才结果补一份说明');
      const frontend = await h.started('frontend');
      expect(h.system.manager.get(followup.taskId)?.input.followUpOf).toBe(old.taskId);
      startWorker(frontend);
      oldWorker.finish(workerText());
      const worker = await h.started('worker');
      const texts = worker.prompts[0]!.blocks.filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(texts).toContain('完整业务结果：20');
      expect(texts).toContain('旧业务由原任务继续处理');
      const summary = await h.started('summary');
      summary.finish('旧结果20。');
      await old.done;
      worker.finish(workerText());
      (await h.started('summary')).finish('根据20补好了说明。');
      await followup.done;
    } finally {
      await h.close();
    }
  });

  it('伪造执行身份无法派发，worker自然正文正常保存业务未完成说明', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      const frontend = await h.started('frontend');
      const env = frontend.options.env!;
      const denied = frontend.options.taskControl!({
        action: 'start-worker',
        sessionId: frontend.prompts[0]!.sessionId,
        executionId: 'other-execution',
        runtimeGeneration: env.QQBOT_RUNTIME_GENERATION,
        assignment: { instruction: '伪造派发', deliverables: ['结果'] },
      });
      expect(denied).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
      expect(h.system.manager.get(handle.taskId)?.worker).toBeUndefined();
      startWorker(frontend);
      const worker = await h.started('worker');
      worker.finish('已完成部分调查，第三项尚未完成。');
      const summary = await h.started('summary');
      const result = h.system.manager.get(handle.taskId)?.worker?.result;
      expect(result?.status).toBe('completed');
      expect(result?.text).toBe('已完成部分调查，第三项尚未完成。');
      expect(result?.failure).toBeUndefined();
      summary.finish('调查完成了一部分，第三项还没完成。');
      expect((await handle.done).status).toBe('completed');
    } finally {
      await h.close();
    }
  });

  it('整理正文中的虚构附件ID不影响全部已保存附件交付', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      const outbox = join(worker.options.cwd, h.config.media.outboxDir);
      await mkdir(outbox, { recursive: true });
      await writeFile(join(outbox, 'first.csv'), 'first');
      await writeFile(join(outbox, 'second.csv'), 'second');
      worker.finish(workerText());
      (await h.started('summary')).finish('报告好了。正文示例：{"attachmentIds":["made-up"]}');
      const task = await handle.done;
      expect(task.status).toBe('completed');
      expect(task.worker?.result?.text).toBe(workerText());
      expect(task.frontend.summaryAttempts).toBe(1);
      expect(task.finalReply?.attachments?.map((attachment) => attachment.fileName)).toEqual([
        'first.csv',
        'second.csv',
      ]);
    } finally {
      await h.close();
    }
  });

  it('整理拒绝已被替换成符号链接的已保存附件', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      startWorker(await h.started('frontend'));
      const worker = await h.started('worker');
      const outbox = join(worker.options.cwd, h.config.media.outboxDir);
      await mkdir(outbox, { recursive: true });
      const file = join(outbox, 'report.csv');
      await writeFile(file, 'report');
      worker.finish(workerText());
      const summary = await h.started('summary');
      const alternate = join(h.root, 'other.csv');
      await writeFile(alternate, 'other!');
      await rename(file, join(outbox, 'old.csv'));
      await symlink(alternate, file);
      summary.finish('附件好了。');
      const task = await handle.done;
      expect(task.status).toBe('failed');
      expect(task.frontend.summaryAttempts).toBe(1);
      expect(task.finalReply?.attachments).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it('query_tasks从实际MessageQueue读取投递状态，缺少队列时显示unknown', async () => {
    const h = await createRuntimeHarness();
    try {
      h.connector.connected = false;
      const old = await h.submit('旧请求');
      (await h.started('frontend')).finish('旧结果');
      await old.done;
      const current = await h.submit('查进度');
      const frontend = await h.started('frontend');
      const task = h.system.manager.get(current.taskId)!;
      const control = createTaskControlBridgeV3(h.system.manager, () => {}, h.system.queue).bind(
        task,
        task.frontend.initialJob,
        task.frontend.execution!
      );
      const query = control.query(old.taskId);
      expect(query).toMatchObject({
        ok: true,
        value: [{ delivery: { status: 'pending', pending: true, success: false, count: 1 } }],
      });
      const noQueue = createTaskControlBridgeV3(h.system.manager, () => {})
        .bind(task, task.frontend.initialJob, task.frontend.execution!)
        .query(old.taskId);
      expect(noQueue).toMatchObject({ ok: true, value: [{ delivery: { status: 'unknown' } }] });
      frontend.finish('旧结果仍在等发送。');
      await current.done;
    } finally {
      await h.close();
    }
  });

  it('输入规则只冻结一次，含冒号jobID使用安全目录，共享任务模型决定整理容量', async () => {
    const h = await createRuntimeHarness();
    const logger = createLogger({ autoTick: false, sink: () => {} });
    try {
      const handle = await h.submit();
      const frontend = await h.started('frontend');
      const task = h.system.manager.get(handle.taskId)!;
      const preparer = createPromptPreparerV3({
        config: h.config,
        logger,
        paths: h.paths,
        stats: createPipelineStats(),
        conversations: createConversationStore(h.paths, logger),
      });
      const root = preparer.workspace(task);
      await writeFile(join(root, 'AGENTS.md'), '已冻结业务规则');
      await writeFile(
        join(workspacePathFor(h.paths, task.input.message.target.key), 'AGENTS.md'),
        '之后更新的规则'
      );
      expect(preparer.workspace(task)).toBe(root);
      expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('已冻结业务规则');
      expect(
        await preparer.prepareWorkspace(task, 'frontend', task.frontend.initialJob.jobId)
      ).toContain(root);
      h.config.tasks.taskProvider = 'small';
      h.config.tasks.taskModel = 'small-model';
      h.config.modelApi.providers.small = {
        api: 'openai-completions',
        apiKeyEnv: 'SMALL_KEY',
        models: [{ id: 'small-model', contextWindow: 16385, maxTokens: 8192 }],
      };
      expect(preparer.summaryCapacity(task, 'aa')).toMatchObject({ ok: false });
      h.config.tasks.taskProvider = 'deepseek-official';
      h.config.modelApi.deepseek = {
        models: [{ id: h.config.tasks.taskModel, contextWindow: 16385, maxTokens: 8192 }],
      };
      expect(preparer.summaryCapacity(task, 'aa')).toMatchObject({ ok: false });
      frontend.finish('完成');
      await handle.done;
    } finally {
      await h.close();
    }
  });
});
