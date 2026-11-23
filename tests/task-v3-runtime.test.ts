import { mkdir, writeFile, readFile, realpath, symlink, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTaskControlBridgeV3, createPromptPreparerV3 } from '../src/task/index.js';
import { createLogger, createPipelineStats } from '../src/observability/index.js';
import {
  createConversationStore,
  workspacePathFor,
  conversationFileFor,
} from '../src/store/index.js';
import { createRuntimeHarness, startWorker, workerText } from './helpers/task-v3-runtime.js';

describe('V3真实运行编排、注入DSH事件与本地文件', () => {
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
      summary.finish(JSON.stringify({ text: '结果是20。', attachmentIds: [] }));
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
      expect(result.evidence).toEqual(['12+8=20']);
      const attachment = result.attachments[0]!;
      const id = createHash('sha256')
        .update(JSON.stringify([attachment.absPath, attachment.fileName, attachment.sizeBytes]))
        .digest('hex')
        .slice(0, 24);
      expect(summary.prompts[0]?.blocks[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining(id),
      });
      summary.finish(JSON.stringify({ text: '已算出20，报告在附件里。', attachmentIds: [id] }));
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
      worker.event('assistant/message', {
        message: { content: [{ type: 'text', text: workerText('unknown') }] },
      });
      worker.emit('exit', 1, null);
      const summary = await h.started('summary');
      const result = h.system.manager.get(handle.taskId)!.worker!.result!;
      expect(result.status).toBe('unknown');
      expect(result.text).toBe('完整业务结果：20');
      expect(result.evidence).toEqual(['12+8=20']);
      expect(result.unfinished).toContain('缺少最终确认');
      expect(result.unfinished.join(' ')).toContain('oversize.csv');
      summary.finish(
        JSON.stringify({ text: '已完成部分计算，最后结果还没确认。', attachmentIds: [] })
      );
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
      summary.finish(JSON.stringify({ text: '旧结果20。', attachmentIds: [] }));
      await old.done;
      worker.finish(workerText());
      (await h.started('summary')).finish(
        JSON.stringify({ text: '根据20补好了说明。', attachmentIds: [] })
      );
      await followup.done;
    } finally {
      await h.close();
    }
  });

  it('伪造执行身份无法派发，worker结果格式非法仍保留原始正文', async () => {
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
      expect(result?.status).toBe('failed');
      expect(result?.text).toBe('已完成部分调查，第三项尚未完成。');
      expect(result?.failure?.code).toBe('INVALID_INPUT');
      summary.finish(
        JSON.stringify({ text: '调查完成了一部分，第三项还没完成。', attachmentIds: [] })
      );
      await handle.done;
    } finally {
      await h.close();
    }
  });

  it('整理拒绝虚构附件ID，失败只保留已保存业务结果', async () => {
    const h = await createRuntimeHarness();
    try {
      const handle = await h.submit();
      startWorker(await h.started('frontend'));
      (await h.started('worker')).finish(workerText());
      (await h.started('summary')).finish(
        JSON.stringify({ text: '报告好了', attachmentIds: ['made-up'] })
      );
      const task = await handle.done;
      expect(task.status).toBe('failed');
      expect(task.worker?.result?.text).toBe('完整业务结果：20');
      expect(task.frontend.summaryAttempts).toBe(1);
      expect(task.finalReply?.attachments).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it('整理拒绝伪造或已被替换成符号链接的附件ID', async () => {
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
      const attachment = h.system.manager.get(handle.taskId)!.worker!.result!.attachments[0]!;
      const id = createHash('sha256')
        .update(JSON.stringify([attachment.absPath, attachment.fileName, attachment.sizeBytes]))
        .digest('hex')
        .slice(0, 24);
      const alternate = join(h.root, 'other.csv');
      await writeFile(alternate, 'other!');
      await rename(file, join(outbox, 'old.csv'));
      await symlink(alternate, file);
      summary.finish(JSON.stringify({ text: '附件好了。', attachmentIds: [id] }));
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
