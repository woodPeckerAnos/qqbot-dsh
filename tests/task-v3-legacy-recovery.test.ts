import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TASK_RESTART_INTERRUPTION_TEXT, failure } from '@qqbot/contracts';
import type {
  BudgetRecord,
  QueuedMessage,
  StateDomain,
  TaskInput,
  TaskRunnerV3,
  TaskStatus,
  TaskSystemV3,
} from '@qqbot/contracts';
import { createTaskSystemV3 } from '../src/task/index.js';
import { loadConfigV3 } from '../src/config/index.js';
import { createNullLogger, createPipelineStats, createTrace } from '../src/observability/index.js';
import {
  createConversationStore,
  createObservationWindowStore,
  ensureStoreDirs,
  resolveStorePaths,
} from '../src/store/index.js';
import { BenchmarkClock } from './bench/session/clock.js';
import { MemoryConnector } from './bench/session/connector.js';

const faults = vi.hoisted(() => ({
  messageEnqueue: false,
  taskSave: false,
  writes: [] as StateDomain[],
}));

// 只注入写入故障；所有成功读写仍经过生产文件 writer。
vi.mock('../src/store/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/store/index.js')>();
  return {
    ...original,
    createStateWriter: <T, D extends StateDomain = StateDomain>(domain: D, file?: string) => {
      const writer = original.createStateWriter<T, D>(domain, file);
      return {
        domain,
        load: () => writer.load(),
        save: (records: readonly T[]) => {
          if (domain === 'messages' && faults.messageEnqueue && records.length > 0)
            throw new Error('legacy-message-save-failed');
          if (domain === 'tasks' && faults.taskSave) throw new Error('legacy-task-save-failed');
          writer.save(records);
          faults.writes.push(domain);
        },
      };
    },
  };
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  faults.messageEnqueue = false;
  faults.taskSave = false;
  faults.writes.length = 0;
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

function legacyInput(taskId: string): TaskInput {
  return {
    message: {
      kind: 'group-message',
      target: { platform: 'onebot', kind: 'group', id: 'g', key: 'onebot:group:g' },
      senderId: 'original-author',
      content: `原请求 ${taskId}`,
      msgId: `${taskId}:original-message`,
      eventId: `${taskId}:original-event`,
      ts: 100,
      raw: { original: true },
    },
    reference: {
      messageId: `${taskId}:original-message`,
      excerpt: '原问题的引用',
      senderId: 'original-author',
      senderName: '原作者',
      ts: 100,
    },
    trace: createTrace({ taskId, sessionKey: 'onebot:group:g' }),
    source: 'user',
    isAdmin: false,
    generation: 1,
    context: { replay: '原上下文', window: [] },
  };
}

function legacyTask(schemaVersion: 1 | 2 | undefined, status: TaskStatus, taskId = 'legacy') {
  return {
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    taskId,
    input: legacyInput(taskId),
    createdAt: 100,
    creationSequence: 1,
    cancelAccepted: status === 'cancelled',
    status,
    ...(status === 'pending' || status === 'running' ? {} : { endedAt: 150 }),
    lanes: {
      fast: { status: 'completed', endedAt: 120, result: { kind: 'reply', text: '已完成快答' } },
      slow: { status: status === 'pending' ? 'queued' : status },
    },
  };
}

async function saveRecords(file: string, records: readonly unknown[]): Promise<void> {
  await writeFile(file, JSON.stringify({ version: 1, records }));
}

async function readRecords(file: string): Promise<unknown[]> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('records' in value) ||
    !Array.isArray(value.records)
  )
    throw new Error('测试持久记录非法');
  return value.records;
}

async function recoveryHarness() {
  const root = await mkdtemp(join(tmpdir(), 'task-v3-legacy-'));
  const config = loadConfigV3({
    BOT_CONNECTORS: 'onebot',
    ONEBOT_ACCESS_TOKEN: 'offline',
    DEEPSEEK_API_KEY: 'offline',
  });
  const paths = resolveStorePaths({
    stateDir: join(root, 'state'),
    workspacesRoot: join(root, 'workspaces'),
  });
  ensureStoreDirs(paths);
  config.paths.dshHome = join(root, 'dsh');
  const connector = new MemoryConnector();
  connector.connected = false;
  const clock = new BenchmarkClock();
  clock.time = 200;
  connector.now = clock.now;
  const logger = createNullLogger();
  const run = vi.fn(async () => ({ ok: false as const, error: failure('UPSTREAM_FAILED') }));
  const runner: TaskRunnerV3 = { runFrontend: run, runWorker: run, runSummary: run };
  const systems: TaskSystemV3[] = [];
  cleanup.push(async () => {
    await Promise.all(systems.map((system) => system.close()));
    await connector.stop();
    await rm(root, { recursive: true, force: true });
  });
  return {
    connector,
    clock,
    run,
    taskFile: join(paths.stateDir, 'tasks.json'),
    messageFile: join(paths.stateDir, 'messages.json'),
    budgetFile: join(paths.stateDir, 'task-budgets.json'),
    start() {
      const system = createTaskSystemV3({
        config,
        paths,
        logger,
        clock,
        runner,
        connectors: new Map([['onebot', connector]]),
        conversations: createConversationStore(paths, logger),
        windows: createObservationWindowStore({
          allowlist: [],
          maxMessages: 10,
          maxAgeMs: 1000,
        }),
        stats: createPipelineStats(),
      });
      systems.push(system);
      return system;
    },
  };
}

function existingNotice(input: TaskInput, status: QueuedMessage['status']): QueuedMessage {
  return {
    id: 'legacy:restart-interrupted',
    trace: input.trace,
    candidate: {
      taskId: 'legacy',
      lane: 'slow',
      message: input.message,
      reference: input.reference,
      trace: input.trace,
      text: TASK_RESTART_INTERRUPTION_TEXT,
      kind: 'error',
      notification: true,
    },
    status,
    createdAt: 150,
    ...(status === 'pending' ? {} : { finishedAt: 160 }),
  };
}

describe('V3 升级旧任务的持久化中断提示', () => {
  it.each([
    ['V1（未标版本）', undefined, 'pending'],
    ['V1（未标版本）', undefined, 'running'],
    ['V1', 1, 'pending'],
    ['V1', 1, 'running'],
    ['V2', 2, 'pending'],
    ['V2', 2, 'running'],
  ] as const)(
    '%s（schema=%s，%s）先保存原引用提示再保存失败，不执行模型',
    async (_label, version, status) => {
      const h = await recoveryHarness();
      const task = legacyTask(version, status);
      await saveRecords(h.taskFile, [task]);
      const system = h.start();
      const messages = system.queue.messages('legacy');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: 'legacy:restart-interrupted',
        status: 'pending',
        candidate: {
          lane: 'slow',
          kind: 'error',
          text: TASK_RESTART_INTERRUPTION_TEXT,
          notification: true,
          message: task.input.message,
          reference: task.input.reference,
          trace: { traceId: task.input.trace?.traceId },
        },
      });
      expect(faults.writes.lastIndexOf('messages')).toBeLessThan(faults.writes.indexOf('tasks'));
      expect(await readRecords(h.taskFile)).toMatchObject([
        {
          ...(version === undefined ? {} : { schemaVersion: version }),
          input: task.input,
          status: 'failed',
          lanes: {
            fast: task.lanes.fast,
            slow: { status: 'failed', result: { failure: { code: 'UNKNOWN_OUTCOME' } } },
          },
        },
      ]);
      expect(await readRecords(h.messageFile)).toEqual(messages);
      expect(system.manager.list()).toEqual([]);
      expect(system.manager.get('legacy')).toBeUndefined();
      expect(system.manager.pendingJobs()).toEqual([]);
      expect(system.manager.pendingLegacyInterruptions()).toEqual([]);
      await system.close();
      const restarted = h.start();
      expect(restarted.queue.messages('legacy')).toEqual(messages);
      expect(h.run).not.toHaveBeenCalled();
    }
  );

  it.each([1, 2] as const)('V%s 已有终态不补提示，不修改完成结果', async (version) => {
    const h = await recoveryHarness();
    const tasks = (['completed', 'failed', 'cancelled'] as const).map((status) =>
      legacyTask(version, status, status)
    );
    await saveRecords(h.taskFile, tasks);
    const system = h.start();
    expect(system.queue.messages()).toEqual([]);
    expect(await readRecords(h.taskFile)).toEqual(tasks);
    expect(h.run).not.toHaveBeenCalled();
  });

  it.each(['pending', 'sent', 'failed'] as const)(
    '固定 ID 提示已是 %s 时复用原记录并补旧任务状态',
    async (status) => {
      const h = await recoveryHarness();
      const task = legacyTask(2, 'running');
      const notice = existingNotice(task.input, status);
      await saveRecords(h.taskFile, [task]);
      await saveRecords(h.messageFile, [notice]);
      const system = h.start();
      expect(system.queue.messages('legacy')).toEqual([notice]);
      expect(await readRecords(h.messageFile)).toEqual([notice]);
      expect(await readRecords(h.taskFile)).toMatchObject([{ status: 'failed' }]);
      expect(h.run).not.toHaveBeenCalled();
    }
  );

  it('提示入队保存失败时保留旧任务与预留预算，恢复后等送达再提交', async () => {
    const h = await recoveryHarness();
    const task = legacyTask(1, 'running');
    const budget: BudgetRecord = {
      taskId: 'legacy',
      scope: 'original',
      limit: 1,
      status: 'reserved',
    };
    await saveRecords(h.taskFile, [task]);
    await saveRecords(h.budgetFile, [budget]);
    faults.messageEnqueue = true;
    expect(() => h.start()).toThrow('legacy-message-save-failed');
    expect(await readRecords(h.taskFile)).toEqual([task]);
    expect(await readRecords(h.budgetFile)).toEqual([budget]);
    expect(await readRecords(h.messageFile)).toEqual([]);
    faults.messageEnqueue = false;
    faults.writes.length = 0;
    const system = h.start();
    expect(faults.writes.lastIndexOf('messages')).toBeLessThan(faults.writes.indexOf('tasks'));
    expect(faults.writes.indexOf('tasks')).toBeLessThan(faults.writes.indexOf('task-budgets'));
    expect(system.budget.get('legacy')).toMatchObject({
      status: 'reserved',
      executionFinished: true,
    });
    const delivered = new Promise<void>((resolve) => {
      system.queue.onDelivery(() => {
        resolve();
      });
    });
    h.connector.connected = true;
    system.queue.wake();
    await delivered;
    expect(system.budget.get('legacy')?.status).toBe('committed');
    expect(h.connector.actions[0]?.reference).toEqual(task.input.reference);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('旧任务保存失败后重启去重提示并完成状态保存，不提前结算预算', async () => {
    const h = await recoveryHarness();
    const task = legacyTask(2, 'pending');
    const budget: BudgetRecord = {
      taskId: 'legacy',
      scope: 'original',
      limit: 1,
      status: 'reserved',
    };
    await saveRecords(h.taskFile, [task]);
    await saveRecords(h.budgetFile, [budget]);
    faults.taskSave = true;
    expect(() => h.start()).toThrow('恢复任务失败');
    expect(await readRecords(h.taskFile)).toEqual([task]);
    expect(await readRecords(h.budgetFile)).toEqual([budget]);
    const messages = await readRecords(h.messageFile);
    expect(messages).toHaveLength(1);
    faults.taskSave = false;
    const system = h.start();
    expect(await readRecords(h.messageFile)).toEqual(messages);
    expect(await readRecords(h.taskFile)).toMatchObject([{ status: 'failed' }]);
    expect(system.budget.get('legacy')).toMatchObject({
      status: 'reserved',
      executionFinished: true,
    });
    expect(h.run).not.toHaveBeenCalled();
  });

  it('中断提示投递失败只结束该消息，重启后不派生失败通知', async () => {
    const h = await recoveryHarness();
    await saveRecords(h.taskFile, [legacyTask(2, 'running')]);
    const system = h.start();
    h.connector.send = async () => {
      throw new Error('platform-reply-failed');
    };
    const failed = new Promise<void>((resolve) => {
      system.queue.onDelivery((delivery) => {
        expect(delivery.status).toBe('failed');
        resolve();
      });
    });
    h.connector.connected = true;
    system.queue.wake();
    await failed;
    expect(system.queue.messages('legacy')).toHaveLength(1);
    await system.close();
    const restarted = h.start();
    expect(restarted.queue.messages('legacy')).toHaveLength(1);
    expect(restarted.queue.messages('legacy')[0]?.status).toBe('failed');
    expect(h.run).not.toHaveBeenCalled();
  });
});
