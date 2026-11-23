import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { failure } from '@qqbot/contracts';
import type { WorkerResult } from '@qqbot/contracts';
import { createHarness, deferred } from './bench/frontend-worker/harness.js';
import {
  createSessionContextViewV3,
  renderSessionContextViewV3,
  classifyTaskFollowUpV3,
} from '../src/session/index.js';

describe('V3 前台与 worker 生产装配', () => {
  it('整理失败后的进度追问仍关联并读取已保存业务结果，不重新派发', async () => {
    const h = await createHarness({
      runSummary: async () => ({ ok: false, error: failure('TIMEOUT') }),
    });
    try {
      const old = await h.submit('长任务');
      expect((await old.done).status).toBe('failed');
      const follow = await h.submit('上个任务结果呢？');
      const task = await follow.done;
      expect(task.input.followUpOf).toBe(old.taskId);
      expect(task.input.progressOnly).toBe(true);
      expect(task.finalReply?.text).toContain('完整业务结果：20');
      expect(h.counts.worker).toBe(1);
      expect(h.counts.summary).toBe(2);
    } finally {
      await h.close();
      await h.remove();
    }
  });

  it('主动预算只预留一次，worker和整理完成后等待实际送达再提交', async () => {
    const gate = deferred<WorkerResult>();
    const h = await createHarness({
      runWorker: async () => ({ ok: true, value: await gate.promise }),
    });
    const calls = { reserve: 0, commit: 0, release: 0, spoke: 0 };
    try {
      h.connector.connected = false;
      const reference = h.system.context({
        kind: 'group-message',
        target: { platform: 'onebot', kind: 'group', id: 'g', key: 'onebot:group:g' },
        senderId: 'member',
        content: '长任务',
        msgId: 'p1',
        eventId: 'p1',
        ts: h.clock.now(),
        raw: {},
      }).message;
      const admitted = await h.system.proactive.submitResult({
        input: {
          target: reference.target,
          scene: 'scene-3',
          directive: '完成长任务',
          reason: '已授权',
        },
        reference,
        scope: {
          id: 'original-topic',
          limit: 1,
          reserve: () => {
            calls.reserve++;
          },
          commit: () => {
            calls.commit++;
          },
          release: () => {
            calls.release++;
          },
        },
        onSpoke: () => {
          calls.spoke++;
        },
      });
      expect(admitted).toEqual({ ok: true, value: true });
      const active = await h.observe(
        (task) => task.input.source === 'proactive' && task.worker?.receipt.status === 'running'
      );
      expect(h.system.budget.get(active.taskId)?.status).toBe('reserved');
      gate.resolve({
        status: 'completed',
        text: '业务结果',
        evidence: [],
        attachments: [],
        unfinished: [],
      });
      await h.observe((task) => task.taskId === active.taskId && task.status === 'completed');
      expect(h.system.budget.get(active.taskId)).toMatchObject({
        status: 'reserved',
        executionFinished: true,
      });
      h.connector.connected = true;
      h.system.queue.wake();
      await h.delivery(active.taskId);
      expect(h.system.budget.get(active.taskId)?.status).toBe('committed');
      expect(calls).toEqual({ reserve: 1, commit: 1, release: 0, spoke: 1 });
    } finally {
      gate.resolve({
        status: 'cancelled',
        text: '',
        evidence: [],
        attachments: [],
        unfinished: [],
      });
      await h.close();
      await h.remove();
    }
  });

  it('普通输入只执行前台并使用原消息引用', async () => {
    const h = await createHarness();
    try {
      const task = await h.submit('你好');
      expect((await task.done).status).toBe('completed');
      await h.delivery(task.taskId);
      expect(h.counts).toEqual({ frontend: 1, worker: 0, summary: 0 });
      expect(h.connector.actions[0]?.text).toBe('答复：你好');
      expect(h.connector.actions[0]?.reference?.messageId).toBe('m1');
    } finally {
      await h.close();
      await h.remove();
    }
  });

  it('worker 执行期间新输入和进度追问都可得到前台答复', async () => {
    const gate = deferred<undefined>();
    const h = await createHarness({
      runWorker: async () => {
        await gate.promise;
        return {
          ok: true,
          value: {
            status: 'completed',
            text: '内部业务正文',
            evidence: [],
            attachments: [],
            unfinished: [],
          },
        };
      },
    });
    try {
      const long = await h.submit('长任务');
      await h.observe(
        (task) => task.taskId === long.taskId && task.worker?.receipt.status === 'running'
      );
      const progress = await h.submit('进度怎么样？');
      const progressTask = await progress.done;
      expect(progressTask.input.followUpOf).toBe(long.taskId);
      expect(progressTask.input.progressOnly).toBe(true);
      const normal = await h.submit('你好');
      expect((await normal.done).status).toBe('completed');
      expect(h.counts.worker).toBe(1);
      gate.resolve(undefined);
      expect((await long.done).status).toBe('completed');
      await h.delivery(long.taskId);
      expect(h.connector.actions.some((action) => action.text === '内部业务正文')).toBe(false);
      expect(h.counts.summary).toBe(1);
    } finally {
      gate.resolve(undefined);
      await h.close();
      await h.remove();
    }
  });

  it('整理重试耗尽只发失败说明并保留完整业务结果和附件', async () => {
    const h = await createHarness({
      runSummary: async () => ({ ok: false, error: failure('TIMEOUT') }),
    });
    try {
      const handle = await h.submit('长任务');
      const task = await handle.done;
      expect(task.status).toBe('failed');
      expect(task.frontend.summaryAttempts).toBe(2);
      expect(h.counts.worker).toBe(1);
      expect(task.worker?.result?.text).toBe('完整业务结果：20');
      await h.delivery(task.taskId);
      expect(h.connector.actions.some((action) => action.text.includes('完整业务结果'))).toBe(
        false
      );
    } finally {
      await h.close();
      await h.remove();
    }
  });

  it('队列保存独立附件副本，Task 工作区清理后仍可发送', async () => {
    const gate = deferred<WorkerResult>();
    const h = await createHarness({
      runWorker: async () => ({ ok: true, value: await gate.promise }),
    });
    try {
      const handle = await h.submit('长任务');
      await h.observe(
        (task) => task.taskId === handle.taskId && task.worker?.receipt.status === 'running'
      );
      h.connector.connected = false;
      const file = join(h.root, 'report.csv');
      await writeFile(file, 'name,total\nA,20\n');
      gate.resolve({
        status: 'completed',
        text: '业务结果',
        evidence: [],
        unfinished: [],
        attachments: [{ kind: 'file', absPath: file, fileName: 'report.csv', sizeBytes: 16 }],
      });
      const task = await handle.done;
      const queued = h.system.queue.messages(task.taskId).find((row) => row.candidate.attachment);
      expect(queued?.candidate.attachment?.absPath).not.toBe(file);
      expect(await readFile(queued!.candidate.attachment!.absPath, 'utf8')).toContain('A,20');
      h.clock.advance(8 * 86400000);
      await h.system.prune();
      expect(h.system.manager.get(task.taskId)).toBeUndefined();
      h.connector.connected = true;
      h.system.queue.wake();
      await h.delivery(task.taskId);
      expect(
        h.connector.actions.some((action) =>
          action.attachments.some((attachment) => attachment.text?.includes('A,20'))
        )
      ).toBe(true);
    } finally {
      gate.resolve({
        status: 'cancelled',
        text: '',
        evidence: [],
        attachments: [],
        unfinished: [],
      });
      await h.close();
      await h.remove();
    }
  });

  it('结果投影分开显示 worker、整理和送达，限定渲染预算', async () => {
    const h = await createHarness();
    try {
      const long = await h.submit('长任务');
      const result = await long.done;
      await h.delivery(long.taskId);
      const follow = await h.submit('之前那个任务的结果再说一遍');
      const current = await follow.done;
      const view = createSessionContextViewV3({
        tasks: () => h.system.manager.list(),
        messages: (id) => h.system.queue.messages(id),
        generation: () => current.input.generation,
        now: h.clock.now,
        settings: { maxTotalChars: 12000 },
      }).read(current);
      expect(view.tasks[0]?.worker?.text).toBe(result.worker?.result?.text);
      expect(view.tasks[0]?.frontend.delivery).toBe('sent');
      expect(renderSessionContextViewV3(view).length).toBeLessThanOrEqual(12000);
      expect(
        classifyTaskFollowUpV3({
          tasks: [result],
          message: current.input.message,
          generation: current.input.generation,
          now: h.clock.now(),
        }).followUpOf
      ).toBe(long.taskId);
    } finally {
      await h.close();
      await h.remove();
    }
  });
});
