import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FrontendReply, QueuedMessage, TaskInput, StateWriter } from '@qqbot/contracts';
import { createTaskBudget, createTaskLifeCycleManagerV3 } from '../src/task/index.js';
import { createMessageQueue, createSessionOutputCoordinatorV3 } from '../src/delivery/index.js';
import { createNullLogger } from '../src/observability/index.js';
import { createStateWriter } from '../src/store/index.js';
import { MemoryConnector } from './bench/session/connector.js';
import { BenchmarkClock } from './bench/session/clock.js';

/** 在真实本地存储边界注入保存故障，消息队列仍使用生产实现。 */
class FaultWriter<T> implements StateWriter<T> {
  reject = false;
  constructor(private readonly writer: StateWriter<T>) {}
  load(): T[] {
    return this.writer.load();
  }
  save(records: readonly T[]): void {
    if (this.reject) throw new Error('injected-save-failure');
    this.writer.save(records);
  }
}

async function outputHarness() {
  const root = await mkdtemp(join(tmpdir(), 'tasks-v3-delivery-'));
  const clock = new BenchmarkClock();
  const connector = new MemoryConnector();
  connector.now = clock.now;
  const logger = createNullLogger();
  const taskStore = new FaultWriter(
    createStateWriter<unknown, 'tasks'>('tasks', join(root, 'tasks.json'))
  );
  const manager = createTaskLifeCycleManagerV3({ store: taskStore, now: clock.now });
  const messageStore = new FaultWriter(
    createStateWriter<QueuedMessage, 'messages'>('messages', join(root, 'messages.json'))
  );
  const queue = createMessageQueue({
    connectors: new Map([['onebot', connector]]),
    store: messageStore,
    logger,
    clock,
  });
  const budget = createTaskBudget(createStateWriter('task-budgets', join(root, 'budgets.json')));
  const output = createSessionOutputCoordinatorV3({
    manager,
    queue,
    budget,
    clock,
    filesDir: join(root, 'message-files'),
    maxChars: () => connector.maxChars,
    policy: (task) => connector.policy(task.input.message.target.kind),
    maxFileBytes: 1024,
  });
  const input: TaskInput = {
    source: 'user',
    generation: 1,
    isAdmin: false,
    message: {
      kind: 'group-message',
      target: { key: 'onebot:group:g', platform: 'onebot', kind: 'group', id: 'g' },
      senderId: 'member',
      content: '请求',
      msgId: 'm1',
      eventId: 'm1',
      ts: clock.now(),
      raw: {},
    },
    reference: { messageId: 'm1', excerpt: '请求', senderId: 'member', ts: clock.now() },
    context: { replay: '', window: [] },
  };
  const created = manager.create(input, 'task');
  if (!created.ok) throw new Error(created.error.code);
  const claimed = manager.claimJob('task:frontend:1');
  if (!claimed.ok) throw new Error(claimed.error.code);
  const modelReply: FrontendReply = { replyId: 'model-id', text: '固定的前台回复' };
  const finished = manager.finishFrontend('task', 'task:frontend:1', {
    ok: true,
    value: { kind: 'reply', reply: modelReply },
  });
  if (!finished.ok) throw new Error(finished.error.code);
  const task = manager.get('task')!;
  const reply = task.finalReply!;
  return {
    root,
    connector,
    manager,
    taskStore,
    messageStore,
    budget,
    queue,
    output,
    task,
    reply,
    sent(): Promise<void> {
      if (queue.taskDelivery('task').success && !queue.taskDelivery('task').pending)
        return Promise.resolve();
      return new Promise((resolve) => {
        const off = queue.onDelivery(() => {
          if (queue.taskDelivery('task').success && !queue.taskDelivery('task').pending) {
            off();
            resolve();
          }
        });
      });
    },
    async close() {
      output.close();
      queue.close();
      await connector.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('V3 固定回复与持久交付', () => {
  it('整组保存失败没有半组消息或平台动作，补入队使用同一回复身份', async () => {
    const h = await outputHarness();
    try {
      h.connector.maxChars = 4;
      h.messageStore.reject = true;
      await expect(h.output.accept(h.task, h.reply)).rejects.toThrow('injected-save-failure');
      expect(h.queue.messages()).toEqual([]);
      expect(h.connector.actions).toEqual([]);
      expect(h.manager.get('task')?.phase).toBe('reply-pending');
      h.messageStore.reject = false;
      await h.output.accept(h.task, h.reply);
      await h.output.accept(h.task, h.reply);
      await h.sent();
      expect(
        h.queue.messages().every((row) => row.id.startsWith(`${h.reply.replyId}:delivery:`))
      ).toBe(true);
      expect(h.connector.actions.map((action) => action.text).join('')).toBe(h.reply.text);
    } finally {
      await h.close();
    }
  });

  it('入队后Task确认保存失败，再提交不会重复发送或重写回复', async () => {
    const h = await outputHarness();
    try {
      await h.output.accept(h.task, h.reply);
      await h.sent();
      h.taskStore.reject = true;
      expect(h.manager.confirmEnqueued('task', h.reply.replyId)).toMatchObject({
        ok: false,
        error: { code: 'PERSISTENCE_FAILED' },
      });
      expect(h.manager.get('task')?.phase).toBe('reply-pending');
      h.taskStore.reject = false;
      await h.output.accept(h.task, h.reply);
      expect(h.manager.confirmEnqueued('task', h.reply.replyId).ok).toBe(true);
      expect(h.connector.actions).toHaveLength(1);
      expect(h.manager.get('task')?.finalReply).toEqual(h.reply);
    } finally {
      await h.close();
    }
  });

  it('平台结果未知时重复入队同replyId保持一次发送尝试', async () => {
    const h = await outputHarness();
    try {
      h.connector.send = async () => {
        throw new Error('发送结果未知');
      };
      const attempted = new Promise<void>((resolve) => {
        const off = h.queue.onDelivery(() => {
          off();
          resolve();
        });
      });
      await h.output.accept(h.task, h.reply);
      await attempted;
      await h.output.accept(h.task, h.reply);
      h.queue.wake();
      expect(h.connector.actions.filter((action) => action.text === h.reply.text)).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('普通回复保留引用，强烈提醒只提及原作者一次', async () => {
    const h = await outputHarness();
    try {
      h.connector.maxChars = 4;
      await h.output.accept(h.task, { ...h.reply, attention: 'strong' });
      await h.sent();
      expect(h.queue.messages().filter((row) => row.candidate.mention === 'member')).toHaveLength(
        1
      );
      expect(h.queue.messages().every((row) => row.candidate.reference?.messageId === 'm1')).toBe(
        true
      );
    } finally {
      await h.close();
    }
  });

  it('附件复制时再次检查真实容量，超限不入队', async () => {
    const h = await outputHarness();
    try {
      const file = join(h.root, 'large.txt');
      await writeFile(file, 'x'.repeat(2048));
      await expect(
        h.output.accept(h.task, {
          ...h.reply,
          attachments: [{ kind: 'file', fileName: 'large.txt', absPath: file, sizeBytes: 1 }],
        })
      ).rejects.toThrow('超过容量');
      expect(h.queue.messages()).toEqual([]);
      expect(h.connector.actions).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
