import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { writeFile, rm, readFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createDocumentExtractor } from '../src/dsh/document.js';
import { OnebotConnector } from '../src/adapters/onebot/connector.js';
import type { BotConnector, NormalizedMessage } from '../src/core/connector.js';
import { createNullLogger } from '../src/logger.js';
import { PipelineStats } from '../src/pipeline/stats.js';
import { Orchestrator } from '../src/pipeline/orchestrator.js';
import type { TopicJudge } from '../src/pipeline/topic-judge.js';
import { SessionCommandRouter } from '../src/pipeline/ingress/session-command.js';
import { createDedupeStage } from '../src/pipeline/ingress/dedupe.js';
import { createRecordStage } from '../src/pipeline/ingress/record.js';
import { ConversationStore } from '../src/store/conversations.js';
import { ObservationWindowStore } from '../src/store/window.js';
import { resolveStorePaths, ensureStoreDirs } from '../src/store/paths.js';
import { SeenStore } from '../src/store/seen.js';
import { TaskSystem } from '../src/task/system.js';
import { TaskLifeCycleManager } from '../src/task/lifecycle.js';
import { TaskControlBridge } from '../src/task/control-bridge.js';
import { TaskBudget, type BudgetRecord } from '../src/task/budget.js';
import { MessageQueue, type QueuedMessage } from '../src/task/message-queue.js';
import { TaskStore } from '../src/store/tasks.js';
import type { Lane, ReplyCandidate, TaskInput, TaskSnapshot } from '../src/task/types.js';
import { ManualClock, MockDshRuntime, UnifiedOnebotMock } from './helpers/task-mocks.js';

const cleanups: (() => Promise<void>)[] = [];
const logger = createNullLogger();
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function message(id = '1', senderId = '123', platform = 'onebot'): NormalizedMessage {
  return {
    kind: 'group-at-message',
    target: { platform, key: 'ob11:g8888', id: '8888', kind: 'group' },
    msgId: id,
    eventId: `${platform}:${id}`,
    senderId,
    content: `问题${id}`,
    ts: Date.now(),
    raw: {},
  };
}
function input(id = '1', senderId = '123', isAdmin = false): TaskInput {
  const m = message(id, senderId);
  return {
    message: m,
    isAdmin,
    source: 'user',
    generation: 1,
    reference: { messageId: m.msgId, excerpt: m.content, senderId, ts: m.ts },
    context: { window: [], replay: '' },
  };
}
async function harness(
  overrides: {
    fastRuntimes?: number;
    slowRuntimes?: number;
    maxPerSession?: number;
    fastTimeoutMs?: number;
    slowTimeoutMs?: number;
    clock?: ManualClock;
    topicJudge?: TopicJudge;
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'task-system-'));
  const paths = resolveStorePaths({
    stateDir: join(root, 'state'),
    workspacesRoot: join(root, 'workspaces'),
  });
  ensureStoreDirs(paths);
  const config = loadConfig({
    BOT_CONNECTORS: 'onebot',
    ONEBOT_ACCESS_TOKEN: 'test-token',
    DEEPSEEK_API_KEY: 'mock-key',
    BOT_LISTEN_GROUPS: 'ob11:g8888',
  });
  const { clock, topicJudge, ...taskSettings } = overrides;
  Object.assign(config.tasks, taskSettings);
  config.dsh.profilePatch = join(root, 'profile.yml');
  const mock = new UnifiedOnebotMock();
  const connector = new OnebotConnector({
    host: '127.0.0.1',
    port: 0,
    accessToken: '',
    acceptsC2C: true,
    autoAcceptFriend: false,
    autoAcceptGroupInvite: false,
    fileTransport: 'base64',
    forward: config.attachments.forward,
    replyPolicy: {
      maxChars: 2000,
      maxRepliesPerMsg: 1,
      progressMax: 0,
      progressAfterMs: 1,
      progressIntervalMs: 1,
      turnTimeoutMs: 10,
      passiveWindowMs: Infinity,
    },
    logger,
    transport: mock,
  });
  await connector.start();
  const runtimes: MockDshRuntime[] = [];
  const stats = new PipelineStats();
  const windows = new ObservationWindowStore({
    allowlist: ['ob11:g8888'],
    maxMessages: 100,
    maxAgeMs: 86400_000,
  });
  const conversations = new ConversationStore(paths, logger);
  const system = new TaskSystem({
    config,
    paths,
    stats,
    logger,
    windows,
    conversations,
    connectors: new Map([['onebot', connector]]),
    clock,
    topicJudge,
    extractDocument: createDocumentExtractor({ logger }),
    runtimeFactory: (options) => {
      const r = new MockDshRuntime(options);
      runtimes.push(r);
      return r.asRuntime();
    },
  });
  const orchestrator = new Orchestrator({
    logger,
    connectors: new Map([['onebot', connector]]),
    admins: ['onebot:999'],
    stats,
    stages: [
      createDedupeStage({ seen: new SeenStore({ paths, logger }), stats }),
      new SessionCommandRouter({ actor: system.actor, stats }).stage(),
      createRecordStage({ conversations }),
    ],
    terminal: async (ctx) => {
      await system.actor.submit(ctx);
    },
    createResponder: (m) => system.context(m).responder,
    status: () => ({
      inFlight: system.actor.snapshot().unfinished,
      queued: system.actor.snapshot().slow.queued,
      offpeak: {} as never,
    }),
  });
  connector.on((e) => {
    if (e.kind === 'group-at-message' || e.kind === 'group-message' || e.kind === 'c2c-message') {
      system.queue.observe(e);
      windows.observeAddressed(e);
    }
    void orchestrator.handleEvent(e);
  });
  const runtime = async (lane: Lane, index = 0) => {
    await vi.waitFor(() =>
      expect(
        runtimes.filter((r) => r.options.env?.QQBOT_LANE === lane && r.prompts.length).length
      ).toBeGreaterThan(index)
    );
    return runtimes.filter((r) => r.options.env?.QQBOT_LANE === lane && r.prompts.length)[index]!;
  };
  cleanups.push(async () => {
    await system.close();
    await connector.stop();
    await rm(root, { recursive: true, force: true });
  });
  return {
    system,
    mock,
    connector,
    config,
    paths,
    stats,
    runtimes,
    windows,
    conversations,
    runtime,
    root,
  };
}

describe('双 lane Task 生产装配（模拟 DSH + 统一 OneBot mock，无端口）', () => {
  it('每次有效输入恰好一个 Task，进入两个 lane；重复事件不创建', async () => {
    const h = await harness();
    h.mock.input(1, '你好');
    h.mock.input(1, '你好');
    const fast = await h.runtime('fast'),
      slow = await h.runtime('slow');
    expect(h.system.manager.list()).toHaveLength(1);
    expect(h.stats.deduplicated).toBe(1);
    expect(fast.prompts[0]!.sessionId).not.toBe(slow.prompts[0]!.sessionId);
    expect(fast.options.reasoningEffort).toBe('off');
    expect(slow.options.reasoningEffort).toBeUndefined();
    fast.finish('你好');
    slow.finish('NO_REPLY');
    const task = await h.system.manager.handle(h.system.manager.list()[0]!.taskId).done;
    expect(task.status).toBe('completed');
    expect(task.lanes.slow.result?.kind).toBe('silent');
    await vi.waitFor(() => expect(h.mock.sentTexts).toEqual(['你好']));
  });
  it('旧慢任务未完，新输入快回复已送达；各 lane 同 Session 串行', async () => {
    const h = await harness();
    h.mock.input(1, '做报告');
    const fast = await h.runtime('fast'),
      slow = await h.runtime('slow');
    fast.finish('报告开始了');
    h.mock.input(2, '今天几号');
    const fast2 = await h.runtime('fast', 1);
    fast2.finish('今天 2 号');
    await vi.waitFor(() => expect(h.mock.sentTexts).toContain('今天 2 号'));
    expect(h.runtimes.filter((r) => r.options.env?.QQBOT_LANE === 'slow')).toHaveLength(1);
    expect(h.system.manager.list()[0]!.status).toBe('running');
    slow.finish('报告完成');
    const slow2 = await h.runtime('slow', 1);
    slow2.finish('NO_REPLY');
    await vi.waitFor(() => expect(h.mock.sentTexts).toContain('报告完成'));
    const action = h.mock.actions.find((a) => JSON.stringify(a.params).includes('报告完成'))!;
    expect(action.params.message).toEqual([
      { type: 'reply', data: { id: '1' } },
      { type: 'text', data: { text: '报告完成' } },
    ]);
  });
  it.each(['error', 'blocked', 'max-tokens'])(
    '实际慢执行 %s 有失败回复，投递失败不改执行终态',
    async (reason) => {
      const h = await harness();
      h.mock.input(1, '执行');
      const fast = await h.runtime('fast'),
        slow = await h.runtime('slow');
      fast.finish('已开始');
      slow.event('tool/call', { name: 'bash' });
      slow.finish('', reason);
      const task = await h.system.manager.handle(h.system.manager.list()[0]!.taskId).done;
      expect(task.status).toBe('failed');
      expect(task.lanes.slow.result?.kind).toBe('failed');
      await vi.waitFor(() =>
        expect(h.mock.sentTexts.some((t) => t.includes('执行失败'))).toBe(true)
      );
    }
  );
  it.each(['', 'NO_REPLY'])('执行后返回 %j 属于契约错误', async (text) => {
    const h = await harness();
    h.mock.input(1, '执行');
    const fast = await h.runtime('fast'),
      slow = await h.runtime('slow');
    fast.finish('开始');
    slow.event('tool/call', { name: 'web_search' });
    slow.finish(text);
    expect((await h.system.manager.handle(h.system.manager.list()[0]!.taskId).done).status).toBe(
      'failed'
    );
  });
  it('父执行结束仍等待所属子代理；子代理失败不能静默', async () => {
    const h = await harness();
    h.mock.input(1, '调研');
    const fast = await h.runtime('fast'),
      slow = await h.runtime('slow');
    fast.finish('开始');
    const parentSessionId = slow.prompts[0]!.sessionId;
    slow.emit('subagent.started', { parentSessionId, childSessionId: 'child' });
    slow.finish('调研结果');
    expect(h.system.manager.list()[0]!.lanes.slow.status).toBe('running');
    slow.emit('subagent.finished', {
      parentSessionId,
      childSessionId: 'child',
      status: 'error',
      stopReason: 'error',
    });
    expect((await h.system.manager.handle(h.system.manager.list()[0]!.taskId).done).status).toBe(
      'failed'
    );
  });
  it('旧 runtime / session 的迟到事件不能结算新执行', async () => {
    const h = await harness();
    h.mock.input(1, 'A');
    const f = await h.runtime('fast'),
      s = await h.runtime('slow');
    f.finish('A');
    s.finish('NO_REPLY');
    await h.system.manager.handle(h.system.manager.list()[0]!.taskId).done;
    h.mock.input(2, 'B');
    const next = await h.runtime('slow', 1);
    s.event('turn/end', { reason: { kind: 'error' } }, next.prompts[0]!.sessionId);
    next.event('turn/end', { reason: { kind: 'error' } }, s.prompts[0]!.sessionId);
    expect(h.system.manager.list()[1]!.lanes.slow.status).toBe('running');
    (await h.runtime('fast', 1)).finish('B');
    next.finish('NO_REPLY');
  });
  it('/stop 取消当前执行 Task，保留其他排队 Task；/new 清空未完成 Task', async () => {
    const h = await harness();
    h.mock.input(1, 'A');
    await h.runtime('fast');
    await h.runtime('slow');
    h.mock.input(2, 'B');
    await vi.waitFor(() => expect(h.system.manager.list()).toHaveLength(2));
    h.system.actor.stop('ob11:g8888');
    const tasks = h.system.manager.list();
    expect((await h.system.manager.handle(tasks[0]!.taskId).done).status).toBe('cancelled');
    expect(h.system.manager.get(tasks[1]!.taskId)?.cancelAccepted).toBe(false);
    h.system.actor.reset('ob11:g8888');
    await h.system.manager.handle(tasks[1]!.taskId).done;
    expect(h.system.actor.snapshot().unfinished).toBe(0);
    h.mock.input(3, 'C');
    await vi.waitFor(() => expect(h.system.manager.list()).toHaveLength(3));
    expect(h.system.manager.list()[2]!.input.generation).toBeGreaterThan(
      tasks[1]!.input.generation
    );
    expect(h.system.manager.list()[2]!.input.context.replay).not.toContain('开始 A');
  });
  it('准入超限不创建只进入一个 lane 的 Task', async () => {
    const h = await harness({ maxPerSession: 1 });
    h.mock.input(1, 'A');
    await h.runtime('slow');
    await expect(h.system.actor.submit(h.system.context(message('2')))).rejects.toThrow('上限');
    expect(h.system.manager.list()).toHaveLength(1);
  });
  it('至少五分钟且慢 lane 正执行时最多提醒一次', async () => {
    const clock = new ManualClock();
    const h = await harness({ clock });
    h.mock.input(1, '长任务');
    const f = await h.runtime('fast');
    await h.runtime('slow');
    f.finish('已开始');
    await vi.waitFor(() => expect(h.mock.sentTexts).toContain('已开始'));
    clock.advance(299_999);
    expect(h.mock.sentTexts.some((t) => t.includes('还在执行'))).toBe(false);
    clock.advance(1);
    await vi.waitFor(() =>
      expect(h.mock.sentTexts.filter((t) => t.includes('还在执行'))).toHaveLength(1)
    );
    clock.advance(300_000);
    expect(h.mock.sentTexts.filter((t) => t.includes('还在执行'))).toHaveLength(1);
  });
  it('快 lane 静默时不提醒；无即时出口时放弃提醒', async () => {
    const clock = new ManualClock();
    const h = await harness({ clock });
    h.mock.input(1, 'A');
    const f = await h.runtime('fast');
    await h.runtime('slow');
    f.finish('NO_REPLY');
    clock.advance(300_000);
    expect(h.system.queue.messages().some((r) => r.candidate.kind === 'progress')).toBe(false);
    h.system.actor.reset('ob11:g8888');
    await h.system.manager.handle(h.system.manager.list()[0]!.taskId).done;
    h.mock.input(2, 'B');
    (await h.runtime('fast', 1)).finish('B');
    await h.runtime('slow', 1);
    await vi.waitFor(() => expect(h.mock.sentTexts).toContain('B'));
    await h.mock.stop();
    clock.advance(300_000);
    expect(h.system.queue.messages().some((r) => r.candidate.kind === 'progress')).toBe(false);
  });
  it('慢超时发失败结果；排队时间不计执行超时', async () => {
    const clock = new ManualClock();
    const h = await harness({ clock, slowTimeoutMs: 1000 });
    h.mock.input(1, 'A');
    (await h.runtime('fast')).finish('A');
    await h.runtime('slow');
    h.mock.input(2, 'B');
    (await h.runtime('fast', 1)).finish('B');
    clock.advance(1000);
    await h.system.manager.handle(h.system.manager.list()[0]!.taskId).done;
    const s2 = await h.runtime('slow', 1);
    expect(h.system.manager.list()[1]!.lanes.slow.status).toBe('running');
    s2.finish('NO_REPLY');
    await vi.waitFor(() => expect(h.mock.sentTexts.some((t) => t.includes('超时'))).toBe(true));
  });
  it('两个 lane 完全相同正文精确去重，不同正文分别发送', async () => {
    const h = await harness();
    h.mock.input(1, 'A');
    const f = await h.runtime('fast'),
      s = await h.runtime('slow');
    f.finish('相同结论');
    s.finish('相同结论');
    await h.system.manager.handle(h.system.manager.list()[0]!.taskId).done;
    await vi.waitFor(() => expect(h.mock.sentTexts).toEqual(['相同结论']));
    h.mock.input(2, 'B');
    (await h.runtime('fast', 1)).finish('快结论');
    (await h.runtime('slow', 1)).finish('慢结论');
    await vi.waitFor(() => expect(h.mock.sentTexts).toContain('慢结论'));
    expect(h.mock.sentTexts).toContain('快结论');
  });
  it('附件只属于自己的 Task；稳定文件独立保存，上传阻塞时快正文仍发', async () => {
    const h = await harness();
    h.mock.hold = (action) => action === 'upload_group_file';
    h.mock.input(1, 'A');
    const f = await h.runtime('fast'),
      s = await h.runtime('slow');
    f.finish('A 开始');
    const outbox = join(s.options.cwd, 'outbox');
    await import('node:fs/promises').then((fs) => fs.mkdir(outbox, { recursive: true }));
    await writeFile(join(outbox, 'A.txt'), 'Task A 内容');
    s.finish('A 完成');
    await vi.waitFor(() =>
      expect(h.mock.actions.some((a) => a.action === 'upload_group_file')).toBe(true)
    );
    const attachment = h.system.queue.messages().find((r) => r.candidate.attachment)
      ?.candidate.attachment!;
    expect(await readFile(attachment.absPath, 'utf8')).toBe('Task A 内容');
    h.mock.input(2, 'B');
    (await h.runtime('fast', 1)).finish('B 快回复');
    (await h.runtime('slow', 1)).finish('NO_REPLY');
    await vi.waitFor(() => expect(h.mock.sentTexts).toContain('B 快回复'));
    expect(h.system.queue.messages().filter((r) => r.candidate.attachment)).toHaveLength(1);
    expect(h.conversations.readAll('ob11:g8888').some((t) => t.reference?.messageId === '1')).toBe(
      true
    );
  });
  it('主动 Task 在后来翻篇或已答后仍发送原引用，预算提交一次', async () => {
    const h = await harness();
    h.mock.input(50, '旁听上下文', 123, false);
    const reserve = vi.fn(),
      commit = vi.fn(),
      release = vi.fn(),
      onSpoke = vi.fn();
    expect(
      await h.system.proactive.submit({
        input: {
          target: message().target,
          scene: 'scene-3',
          directive: '调查原问题',
          reason: '无人答',
          evidence: '原问题',
        },
        reference: message('original'),
        scope: { id: 'old-topic', limit: 1, reserve, commit, release },
        onSpoke,
      })
    ).toBe(true);
    (await h.runtime('fast')).finish('NO_REPLY');
    const slow = await h.runtime('slow');
    h.mock.input(51, '旧问题已经答了，换个话题');
    (await h.runtime('fast', 1)).finish('新问题快回复');
    slow.finish('原调查结果');
    (await h.runtime('slow', 1)).finish('NO_REPLY');
    await vi.waitFor(() => expect(h.mock.sentTexts).toContain('原调查结果'));
    const result = h.mock.actions.find((a) => JSON.stringify(a.params).includes('原调查结果'))!;
    expect(result.params.message).toContainEqual({ type: 'reply', data: { id: 'original' } });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(onSpoke).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });
  it('主动 Task 全静默释放；取消后已入队产物继续结算预留', async () => {
    const h = await harness();
    h.mock.input(50, '旁听', 123, false);
    const reserve = vi.fn(),
      commit = vi.fn(),
      release = vi.fn(),
      onSpoke = vi.fn();
    const request = {
      input: {
        target: message().target,
        scene: 'scene-2' as const,
        directive: '插话',
        reason: '触发',
      },
      reference: message('original'),
      scope: { id: 'scope', limit: 1, reserve, commit, release },
      onSpoke,
    };
    await h.system.proactive.submit(request);
    (await h.runtime('fast')).finish('NO_REPLY');
    (await h.runtime('slow')).finish('NO_REPLY');
    await h.system.manager.handle(h.system.manager.list()[0]!.taskId).done;
    expect(release).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    await h.system.proactive.submit(request);
    const fast = await h.runtime('fast', 1);
    await h.runtime('slow', 1);
    await h.connector.stop();
    fast.finish('已入队结果');
    await vi.waitFor(() => expect(h.system.queue.snapshot().pending).toBe(1));
    const task = h.system.manager.list()[1]!;
    h.system.actor.cancel(task.taskId);
    await h.system.manager.handle(task.taskId).done;
    expect(h.system.budget.get(task.taskId)?.status).toBe('reserved');
    await h.connector.start();
    h.mock.input(51, '新话题', 123, false);
    await vi.waitFor(() => expect(h.mock.sentTexts).toContain('已入队结果'));
    expect(h.system.budget.get(task.taskId)?.status).toBe('committed');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(onSpoke).toHaveBeenCalledTimes(1);
  });
  it('正常执行已完成时，所有发送失败也不改写 completed；主动预算释放', async () => {
    const h = await harness();
    h.mock.input(50, '旁听', 123, false);
    h.mock.fail = () => true;
    const release = vi.fn();
    await h.system.proactive.submit({
      input: { target: message().target, scene: 'scene-2', directive: '插话', reason: '触发' },
      reference: message('original'),
      scope: { id: 'scope', limit: 1, reserve: vi.fn(), commit: vi.fn(), release },
      onSpoke: vi.fn(),
    });
    (await h.runtime('fast')).finish('正常结果');
    (await h.runtime('slow')).finish('NO_REPLY');
    const task = await h.system.manager.handle(h.system.manager.list()[0]!.taskId).done;
    await vi.waitFor(() => expect(h.system.queue.snapshot().failed).toBe(2));
    expect(h.system.manager.get(task.taskId)?.status).toBe('completed');
    expect(h.system.budget.get(task.taskId)?.status).toBe('released');
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('重启不重跑未完成执行；保留快结果，只生成一次中断结果', async () => {
    const h = await harness();
    h.mock.input(1, '长任务');
    (await h.runtime('fast')).finish('已经开始');
    await h.runtime('slow');
    await vi.waitFor(() => expect(h.mock.sentTexts).toContain('已经开始'));
    const interrupted = h.system.manager.list()[0]!;
    h.system.actor.reset('ob11:g8888');
    await h.system.close();
    new TaskStore<TaskSnapshot>(join(h.paths.stateDir, 'tasks.json')).save([interrupted]);
    const factory = vi.fn((options) => new MockDshRuntime(options).asRuntime());
    const restart = () =>
      new TaskSystem({
        config: h.config,
        paths: h.paths,
        logger,
        stats: h.stats,
        windows: h.windows,
        conversations: h.conversations,
        connectors: new Map([['onebot', h.connector]]),
        runtimeFactory: factory,
      });
    const recovered = restart();
    const task = await recovered.manager.handle(interrupted.taskId).done;
    expect(task.status).toBe('failed');
    expect(task.lanes.fast.result).toEqual({ kind: 'reply', text: '已经开始' });
    expect(task.lanes.slow.result).toMatchObject({ kind: 'failed', error: 'restart-interrupted' });
    await vi.waitFor(() =>
      expect(h.mock.sentTexts.filter((t) => t.includes('重启而中断'))).toHaveLength(1)
    );
    await recovered.close();
    const again = restart();
    cleanups.push(() => again.close());
    again.queue.wake();
    await Promise.resolve();
    await Promise.resolve();
    expect(factory).not.toHaveBeenCalled();
    expect(h.mock.sentTexts.filter((t) => t.includes('重启而中断'))).toHaveLength(1);
    const next = await again.actor.submit(again.context(message('after-restart')));
    expect(again.manager.get(next.taskId)!.input.generation).toBeGreaterThan(
      interrupted.input.generation
    );
    expect(again.manager.get(next.taskId)!.input.context.replay).not.toContain('已经开始');
  });
  it('主动 Task 的正文、附件和不同 lane 结果只提交一次预算', async () => {
    const h = await harness();
    const reserve = vi.fn(),
      commit = vi.fn(),
      release = vi.fn(),
      onSpoke = vi.fn();
    await h.system.proactive.submit({
      input: { target: message().target, scene: 'scene-2', directive: '制作报告', reason: '讨论' },
      reference: message('original'),
      scope: { id: 'report-scope', limit: 1, reserve, commit, release },
      onSpoke,
    });
    (await h.runtime('fast')).finish('开始制作');
    const slow = await h.runtime('slow');
    await mkdir(join(slow.options.cwd, 'outbox'), { recursive: true });
    await writeFile(join(slow.options.cwd, 'outbox', '报告.txt'), '报告');
    slow.finish('制作完成');
    await h.system.manager.handle(h.system.manager.list()[0]!.taskId).done;
    await vi.waitFor(() =>
      expect(h.system.queue.messages().filter((r) => r.status === 'sent')).toHaveLength(4)
    );
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(onSpoke).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });
  it('终态到期清理 Task 工作区，已入队待发附件继续可靠保存', async () => {
    const clock = new ManualClock();
    const h = await harness({ clock });
    h.mock.input(1, '报告');
    const fast = await h.runtime('fast'),
      slow = await h.runtime('slow');
    await h.connector.stop();
    await mkdir(join(slow.options.cwd, 'outbox'), { recursive: true });
    await writeFile(join(slow.options.cwd, 'outbox', 'report.txt'), '可靠内容');
    fast.finish('开始');
    slow.finish('完成');
    await h.system.manager.handle(h.system.manager.list()[0]!.taskId).done;
    const attachment = h.system.queue.messages().find((r) => r.candidate.attachment)!.candidate
      .attachment!;
    clock.advance(h.config.tasks.retentionMs + 1);
    await h.system.prune();
    expect(h.system.manager.list()).toEqual([]);
    await expect(access(dirname(slow.options.cwd))).rejects.toThrow();
    expect(await readFile(attachment.absPath, 'utf8')).toBe('可靠内容');
    await h.connector.start();
    h.system.queue.wake();
    await vi.waitFor(() =>
      expect(h.mock.actions.some((a) => a.action === 'upload_group_file')).toBe(true)
    );
  });
  it('快消息未送达或慢 lane 仍排队时不提醒；慢执行结束后撤销提醒', async () => {
    const clock = new ManualClock();
    const h = await harness({ clock });
    h.mock.input(1, 'A');
    const fast = await h.runtime('fast'),
      slow = await h.runtime('slow');
    h.mock.hold = (action) => action === 'send_group_msg';
    fast.finish('A 开始');
    await vi.waitFor(() => expect(h.system.queue.snapshot().sending).toBe(1));
    clock.advance(300_000);
    expect(h.system.queue.messages().some((r) => r.candidate.kind === 'progress')).toBe(false);
    h.mock.hold = () => false;
    await vi.waitFor(() => expect(h.system.queue.snapshot().sending).toBe(0));
    h.mock.input(2, 'B');
    (await h.runtime('fast', 1)).finish('B 开始');
    await vi.waitFor(() => expect(h.mock.sentTexts).toContain('B 开始'));
    const second = h.system.manager.list()[1]!;
    expect(second.lanes.slow.status).toBe('queued');
    clock.advance(300_000);
    expect(
      h.system.queue.messages(second.taskId).some((r) => r.candidate.kind === 'progress')
    ).toBe(false);
    slow.finish('A 完成');
    const nextSlow = await h.runtime('slow', 1);
    // Artifact finalization may retain a running lane after model execution ends.
    h.system.manager.endExecution(second.taskId, 'slow');
    clock.advance(300_000);
    expect(
      h.system.queue.messages(second.taskId).some((r) => r.candidate.kind === 'progress')
    ).toBe(false);
    nextSlow.finish('NO_REPLY');
  });
  it('存活提醒发送失败只尝试一次，失败通知也不递归', async () => {
    const clock = new ManualClock();
    const h = await harness({ clock });
    h.mock.input(1, '长任务');
    (await h.runtime('fast')).finish('开始');
    await h.runtime('slow');
    await vi.waitFor(() => expect(h.mock.sentTexts).toContain('开始'));
    h.mock.fail = () => true;
    clock.advance(300_000);
    await vi.waitFor(() => expect(h.system.queue.snapshot().failed).toBe(2));
    clock.advance(300_000);
    h.system.queue.wake();
    await Promise.resolve();
    expect(h.system.queue.messages().filter((r) => r.candidate.kind === 'progress')).toHaveLength(
      1
    );
    expect(h.mock.sentTexts.filter((t) => t.includes('还在执行'))).toHaveLength(1);
    expect(h.mock.sentTexts.filter((t) => t.includes('发送 存活提醒'))).toHaveLength(1);
  });
  it('输入上下文按 generation 固定，同 Task 媒体只摄取解析一次', async () => {
    const h = await harness();
    const fetchMedia = vi.fn(async () => ({ data: Buffer.from('原始文件内容') }));
    h.connector.fetchMedia = fetchMedia;
    const original = message('file');
    original.parts = [
      {
        type: 'media',
        mediaKind: 'file',
        filename: 'source.txt',
        url: 'https://example.invalid/source.txt',
      },
    ];
    h.windows.observeAddressed({ ...message('context'), content: '原话题资料' });
    const handle = await h.system.actor.submit(h.system.context(original));
    const fast = await h.runtime('fast'),
      slow = await h.runtime('slow');
    expect(fetchMedia).toHaveBeenCalledTimes(1);
    expect(h.stats.filesFetched).toBe(1);
    expect(h.stats.filesExtracted).toBe(1);
    expect(fast.prompts[0]!.blocks.slice(1)).toEqual(slow.prompts[0]!.blocks.slice(1));
    await new Promise((resolve) => setTimeout(resolve, 2));
    h.system.actor.reset(original.target.key);
    await handle.done;
    h.windows.observeAddressed({ ...message('later'), content: '新话题资料', ts: Date.now() + 1 });
    const next = await h.system.actor.submit(h.system.context(message('next')));
    const task = h.system.manager.get(next.taskId)!;
    expect(task.input.generation).toBeGreaterThan(
      h.system.manager.get(handle.taskId)!.input.generation
    );
    expect(task.input.context.window.some((e) => e.text.includes('原话题资料'))).toBe(false);
    expect(
      h.system.manager
        .get(handle.taskId)!
        .input.context.window.some((e) => e.text.includes('原话题资料'))
    ).toBe(true);
  });
  it('主动提交等待另一输入判定期间仍固定触发时的窗口和 generation', async () => {
    let resolveJudge!: (result: { related: boolean; mentionsChatRecord: boolean }) => void;
    const judged = vi.fn(
      () =>
        new Promise<{ related: boolean; mentionsChatRecord: boolean }>((resolve) => {
          resolveJudge = resolve;
        })
    );
    const h = await harness({ topicJudge: judged });
    h.conversations.append('ob11:g8888', {
      role: 'user',
      speaker: '123',
      text: '历史问题',
      ts: Date.now() - 1000,
    });
    h.windows.observeAddressed({ ...message('context'), content: '触发时资料' });
    const first = h.system.actor.submit(h.system.context(message('blocking')));
    await vi.waitFor(() => expect(judged).toHaveBeenCalledTimes(1));
    const submitting = h.system.proactive.submit({
      input: { target: message().target, scene: 'scene-2', directive: '研究', reason: '讨论' },
      reference: message('trigger'),
      scope: { id: 'frozen-topic', limit: 1, reserve: vi.fn(), commit: vi.fn(), release: vi.fn() },
      onSpoke: vi.fn(),
    });
    h.system.actor.reset('ob11:g8888');
    h.windows.observeAddressed({ ...message('later'), content: '后来话题资料' });
    resolveJudge({ related: true, mentionsChatRecord: false });
    await first;
    expect(await submitting).toBe(true);
    const task = h.system.manager.list().find((t) => t.input.source === 'proactive')!;
    expect(task.input.generation).toBe(1);
    expect(task.input.context.window.map((e) => e.text)).toContain('触发时资料');
    expect(task.input.context.window.map((e) => e.text)).not.toContain('后来话题资料');
  });
  it('恢复释放孤立预留，但 Task 已清理的待发消息仍可提交原预算', async () => {
    const h = await harness();
    await h.system.close();
    new TaskStore<BudgetRecord>(join(h.paths.stateDir, 'task-budgets.json')).save([
      { taskId: 'orphan', scope: 'old-scope', limit: 2, status: 'reserved' },
      {
        taskId: 'retained',
        scope: 'old-scope',
        limit: 2,
        status: 'reserved',
        executionFinished: true,
      },
    ]);
    new TaskStore<QueuedMessage>(join(h.paths.stateDir, 'messages.json')).save([
      {
        id: 'retained-message',
        candidate: {
          taskId: 'retained',
          lane: 'slow',
          message: message('original'),
          text: '旧消息仍可发送',
          kind: 'final',
        },
        status: 'pending',
        createdAt: Date.now(),
      },
    ]);
    const recovered = new TaskSystem({
      config: h.config,
      paths: h.paths,
      logger,
      stats: h.stats,
      windows: h.windows,
      conversations: h.conversations,
      connectors: new Map([['onebot', h.connector]]),
      runtimeFactory: (options) => new MockDshRuntime(options).asRuntime(),
    });
    cleanups.push(() => recovered.close());
    expect(recovered.budget.get('orphan')!.status).toBe('released');
    expect(recovered.budget.get('retained')!.status).toBe('reserved');
    recovered.queue.wake();
    await vi.waitFor(() => expect(h.mock.sentTexts).toContain('旧消息仍可发送'));
    expect(recovered.budget.get('retained')!.status).toBe('committed');
    expect(recovered.manager.list()).toEqual([]);
  });
  it('附件编码期间超时取消，编码结束后不再向平台派发', async () => {
    const h = await harness();
    let encoded!: (text: string) => void;
    vi.spyOn(
      h.connector as unknown as { encodeAttachment(): Promise<string> },
      'encodeAttachment'
    ).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          encoded = resolve;
        })
    );
    const controller = new AbortController();
    const sending = h.connector.reply(
      { target: message().target, seq: 0, kind: 'final', signal: controller.signal },
      {
        text: '',
        attachments: [
          { kind: 'file', absPath: '/unused', fileName: 'file.txt', mimeType: 'text/plain' },
        ],
      }
    );
    controller.abort();
    encoded('base64://content');
    await expect(sending).rejects.toThrow();
    expect(h.mock.actions).toHaveLength(0);
  });
});

describe('生命周期、控制与预算', () => {
  it('快成功后仍可取消慢；已完成返回终态及结果；快照不可写', () => {
    const manager = new TaskLifeCycleManager();
    const a = manager.create(input());
    manager.finish(a.taskId, 'fast', { kind: 'reply', text: '快结果' });
    expect(manager.get(a.taskId)?.status).toBe('pending');
    expect(manager.cancel(a.taskId).accepted).toBe(true);
    manager.finish(a.taskId, 'slow', { kind: 'cancelled' });
    expect(manager.get(a.taskId)?.status).toBe('cancelled');
    expect(manager.cancel(a.taskId).accepted).toBe(false);
    expect(() => {
      manager.get(a.taskId)!.input.message.content = '修改';
    }).toThrow();
  });
  it('普通成员只取消本人旧 Task，管理员可取消本 Session 其他成员；跨 Session 拒绝', () => {
    const manager = new TaskLifeCycleManager();
    const owner = manager.create(input('1', '123'));
    const other = manager.create(input('2', '456'));
    const caller = manager.create(input('3', '123'));
    const cancel = vi.fn();
    const bridge = new TaskControlBridge(manager, cancel).bind(manager.get(caller.taskId)!);
    expect(bridge.cancel(other.taskId).accepted).toBe(false);
    expect(bridge.cancel(owner.taskId).accepted).toBe(true);
    const admin = manager.create(input('4', '999', true));
    const adminBridge = new TaskControlBridge(manager, cancel).bind(manager.get(admin.taskId)!);
    expect(adminBridge.cancel(other.taskId).accepted).toBe(true);
    const foreignInput = input('5');
    foreignInput.message.target.key = 'other';
    const foreign = manager.create(foreignInput);
    expect(adminBridge.cancel(foreign.taskId).accepted).toBe(false);
    expect(adminBridge.cancel(admin.taskId).accepted).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  it('全局准入限额、7 天保留与持久化恢复，NO_REPLY 算成功', () => {
    let now = 1;
    const manager = new TaskLifeCycleManager({ maxGlobal: 1, now: () => now });
    const a = manager.create(input());
    const b = input('2');
    b.message.target.key = 'other';
    expect(() => manager.create(b)).toThrow('上限');
    manager.finish(a.taskId, 'fast', { kind: 'silent', reason: 'no-long-skill' });
    manager.finish(a.taskId, 'slow', { kind: 'silent', reason: 'no-long-skill' });
    expect(manager.get(a.taskId)?.status).toBe('completed');
    now += 7 * 86400_000 + 1;
    manager.prune();
    expect(manager.list()).toEqual([]);
  });
  it('预算按 Task 首次成功提交一次，静默释放；旧范围不影响新范围', () => {
    const budget = new TaskBudget();
    expect(budget.reserve('A', 'old', 1)).toBe(true);
    expect(budget.reserve('B', 'old', 1)).toBe(false);
    expect(budget.settle('A', true, false)).toBe('committed');
    expect(budget.settle('A', true, true)).toBeUndefined();
    expect(budget.reserve('C', 'new', 1)).toBe(true);
    expect(budget.settle('C', false, true)).toBe('released');
    expect(budget.reserve('D', 'new', 1)).toBe(true);
  });
  it('同毫秒创建的后续 Task 也不属于调用者可取消的旧任务', () => {
    const manager = new TaskLifeCycleManager({ now: () => 100 });
    const caller = manager.create(input());
    const later = manager.create(input('2'));
    expect(
      new TaskControlBridge(manager, vi.fn()).bind(manager.get(caller.taskId)!).cancel(later.taskId)
        .accepted
    ).toBe(false);
  });
});

describe('独立消息投递', () => {
  function queueHarness(official = false, file?: string, hold = false) {
    const clock = new ManualClock();
    const sent: { context: unknown; candidate: ReplyCandidate }[] = [];
    let connected = true;
    let fail = false;
    const m = message('original', '123', official ? 'qq-official' : 'onebot');
    const connector = {
      health: () => ({ connected, state: 'test' }),
      policy: () => ({ passiveWindowMs: official ? 1000 : Infinity, maxRepliesPerMsg: 5 }),
      reply: vi.fn(),
    } as unknown as BotConnector;
    const queue = new MessageQueue({
      clock,
      timeoutMs: 100,
      connectors: new Map([[m.target.platform, connector]]),
      logger,
      store: new TaskStore<QueuedMessage>(file),
      transport: async (_c, context, candidate) => {
        sent.push({ context, candidate });
        if (fail) throw new Error('失败');
        if (hold) await new Promise<void>(() => {});
      },
    });
    cleanups.push(async () => queue.close());
    const candidate: ReplyCandidate = {
      taskId: 'task-A',
      lane: 'slow',
      message: m,
      reference: { messageId: 'original', excerpt: '原问题', senderId: '123', ts: m.ts },
      text: '结果',
      kind: 'final',
    };
    return {
      clock,
      sent,
      queue,
      candidate,
      connected: (value: boolean) => {
        connected = value;
      },
      fail: (value: boolean) => {
        fail = value;
      },
    };
  }
  it('发送失败一次，不借下一条输入重发；通知只尝试一次，不递归', async () => {
    const h = queueHarness();
    h.fail(true);
    h.queue.enqueue(h.candidate);
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    h.queue.observe(message('next'));
    h.queue.wake();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent).toHaveLength(2);
    expect(h.queue.snapshot().failed).toBe(2);
    expect(h.sent[1]!.candidate.notification).toBe(true);
  });
  it('从未尝试消息等待出口；用新锚点发送，仍引用原消息', async () => {
    const h = queueHarness(true);
    h.clock.advance(1001);
    h.queue.enqueue(h.candidate);
    await Promise.resolve();
    expect(h.sent).toHaveLength(0);
    const next = message('new-anchor', '123', 'qq-official');
    next.ts = h.clock.now();
    h.queue.observe(next);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.context).toMatchObject({ msgId: 'new-anchor', seq: 1 });
    expect(h.sent[0]!.candidate.reference?.messageId).toBe('original');
  });
  it('重启不重发发送中消息，未尝试消息仍可发送', async () => {
    const root = mkdtempSync(join(tmpdir(), 'queue-recover-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const file = join(root, 'messages.json');
    const h = queueHarness(false, file);
    h.connected(false);
    h.queue.enqueue(h.candidate, 'pending');
    new TaskStore<QueuedMessage>(file).save([
      ...h.queue.messages().map((r) => structuredClone(r)),
      {
        id: 'sending',
        candidate: { ...h.candidate, text: '结果未知' },
        status: 'sending',
        createdAt: 1,
        attemptedAt: 2,
      },
    ]);
    const fresh = queueHarness(false, file);
    fresh.queue.wake();
    await vi.waitFor(() => expect(fresh.sent).toHaveLength(2));
    expect(fresh.sent.map((s) => s.candidate.text)).toContain('结果');
    expect(fresh.sent.map((s) => s.candidate.text)).not.toContain('结果未知');
    expect(fresh.queue.messages().find((r) => r.id === 'sending')?.status).toBe('failed');
  });
  it('传输超时原消息不重试，通知也只尝试一次', async () => {
    const h = queueHarness(false, undefined, true);
    h.queue.enqueue(h.candidate);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    h.clock.advance(100);
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    h.clock.advance(100);
    await vi.waitFor(() => expect(h.queue.snapshot().failed).toBe(2));
    h.queue.observe(message('next'));
    await Promise.resolve();
    expect(h.sent).toHaveLength(2);
  });
  it('QQ 的序号与平台条数由两个 lane、附件和命令共享', async () => {
    const h = queueHarness(true);
    for (let i = 0; i < 7; i++)
      h.queue.enqueue({
        ...h.candidate,
        taskId: i === 2 ? 'ingress-command' : `task-${i}`,
        lane: i % 2 ? 'fast' : 'slow',
        text: `消息${i}`,
        ...(i === 3
          ? {
              attachment: {
                absPath: '/unused',
                fileName: 'file.txt',
                mimeType: 'text/plain',
                kind: 'file' as const,
              },
            }
          : {}),
      });
    await vi.waitFor(() => expect(h.sent).toHaveLength(5));
    expect(h.queue.snapshot().pending).toBe(2);
    expect(h.sent.map((s) => (s.context as { seq: number }).seq).sort()).toEqual([1, 2, 3, 4, 5]);
    const next = message('next-anchor', '123', 'qq-official');
    next.ts = h.clock.now();
    h.queue.observe(next);
    await vi.waitFor(() => expect(h.sent).toHaveLength(7));
    expect(h.sent.slice(5).map((s) => s.context)).toEqual([
      expect.objectContaining({ msgId: 'next-anchor', seq: 1 }),
      expect.objectContaining({ msgId: 'next-anchor', seq: 2 }),
    ]);
  });
});
