import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { failure } from '@qqbot/contracts';
import type { TaskHandleV3, TaskRunnerV3, WorkerResult } from '@qqbot/contracts';
import { createHarness, deferred } from './harness.js';
import { records, isSelected, writeReport, type ScenarioRecord } from './report.js';
import { registry } from './registry.js';
import { productionGroups, runProductionGroup } from './production-groups.js';
import { readStoredZip, deliveredArchiveMatches } from './zip-evidence.js';
import { OnebotProbe } from '../session/onebot-probe.js';

type Harness = Awaited<ReturnType<typeof createHarness>>;
interface Scenario {
  id: string;
  name: string;
  hooks?: Partial<TaskRunnerV3>;
  run(
    harness: Harness,
    check: (name: string, passed: boolean, evidence: unknown) => void
  ): Promise<void>;
}

const result: WorkerResult = {
  status: 'completed',
  text: '仅供前台读取的业务结果',
  evidence: ['离线固定结果'],
  attachments: [],
  unfinished: [],
};

async function runScenario(scenario: Scenario): Promise<void> {
  if (!isSelected(scenario.id)) return;
  const startedAt = performance.now();
  const record: ScenarioRecord = {
    id: scenario.id,
    version: 2,
    coverage: registry.find((entry) => entry.id === scenario.id)!.coverage,
    name: scenario.name,
    status: 'failed',
    durationMs: 0,
    checks: [],
  };
  let h: Harness;
  try {
    h = await createHarness(scenario.hooks);
  } catch (error) {
    record.checks.push({
      name: '生产 TaskSystem 初始化成功',
      passed: false,
      evidence: { error: error instanceof Error ? error.message : String(error) },
    });
    record.durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    records.push(record);
    throw error;
  }
  const check = (name: string, passed: boolean, evidence: unknown) => {
    record.checks.push({ name, passed, evidence: structuredClone(evidence) });
    expect(passed, name).toBe(true);
  };
  let failed: { error: unknown } | undefined;
  try {
    await scenario.run(h, check);
    record.status = 'passed';
  } catch (error) {
    failed = { error };
  }
  try {
    await h.close();
    const closed = h.system.actor.snapshot();
    record.closed = {
      frontendRunning: closed.frontend.running,
      frontendQueued: closed.frontend.queued,
      workerRunning: closed.worker.running,
      workerQueued: closed.worker.queued,
      timers: h.clock.pending,
    };
    record.counts = { ...h.counts };
    record.tasks = h.system.manager.list().map((task) => ({
      taskId: task.taskId,
      status: task.status,
      phase: task.phase,
      summaryAttempts: task.frontend.summaryAttempts,
      workerStatus: task.worker?.receipt.status,
    }));
    check(
      '关闭后执行、排队和计时器全部释放',
      Object.values(record.closed).every((value) => value === 0),
      record.closed
    );
  } catch (error) {
    failed ??= { error };
  } finally {
    if (failed) record.status = 'failed';
    record.durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    records.push(record);
    await h.remove();
  }
  if (failed) throw failed.error;
}

describe('前台/worker V3 离线 benchmark v2', () => {
  it.runIf(isSelected('F01'))('F01 普通输入只创建前台，最终回复固定并实际送达', async () => {
    await runScenario({
      id: 'F01',
      name: '普通请求 worker 为零',
      async run(h, check) {
        const handle = await h.submit('你好');
        const task = await handle.done;
        await h.delivery(task.taskId);
        check(
          '普通请求仅运行一次前台',
          h.counts.frontend === 1 && h.counts.worker === 0 && h.counts.summary === 0,
          h.counts
        );
        check(
          '最终回复保存并确认入队',
          task.status === 'completed' &&
            task.replyEnqueuedAt !== undefined &&
            !!task.finalReply?.replyId &&
            h.system.queue
              .messages(task.taskId)
              .every(
                (message) =>
                  message.candidate.delivery?.groupId === `${task.finalReply?.replyId}:delivery`
              ),
          {
            status: task.status,
            replyEnqueued: task.replyEnqueuedAt !== undefined,
            replyId: task.finalReply?.replyId,
            deliveryGroups: h.system.queue
              .messages(task.taskId)
              .map((message) => message.candidate.delivery?.groupId),
          }
        );
        const sent = h.connector.actions.filter((action) => action.status === 'received');
        check(
          '正文引用原消息且只送达一次',
          sent.length === 1 &&
            sent[0]?.text === '答复：你好' &&
            sent[0]?.reference?.messageId === 'm1',
          sent.map((action) => ({ text: action.text, reference: action.reference?.messageId }))
        );
      },
    });
  });

  it.runIf(isSelected('F02'))(
    'F02 worker 运行期间普通输入和进度追问推进，内部正文不外发',
    async () => {
      const gate = deferred<undefined>();
      await runScenario({
        id: 'F02',
        name: '长任务与前台新输入交错',
        hooks: {
          async runWorker() {
            await gate.promise;
            return { ok: true, value: result };
          },
        },
        async run(h, check) {
          try {
            const long = await h.submit('长任务');
            await h.observe(
              (task) => task.taskId === long.taskId && task.worker?.receipt.status === 'running'
            );
            const progress = await h.submit('进度怎么样？');
            const progressTask = await progress.done;
            await h.delivery(progress.taskId);
            const ordinary = await h.submit('你好');
            const ordinaryTask = await ordinary.done;
            await h.delivery(ordinary.taskId);
            const running = h.system.manager.get(long.taskId);
            check(
              'worker 未结束时新普通请求已完成',
              running?.worker?.receipt.status === 'running' && ordinaryTask.status === 'completed',
              { worker: running?.worker?.receipt.status, ordinary: ordinaryTask.status }
            );
            check(
              '进度关联原 Task 且不创建新 worker',
              progressTask.input.progressOnly === true &&
                progressTask.input.followUpOf === long.taskId &&
                h.counts.worker === 1,
              {
                progressOnly: progressTask.input.progressOnly,
                followUpMatches: progressTask.input.followUpOf === long.taskId,
                workers: h.counts.worker,
              }
            );
            gate.resolve(undefined);
            const task = await long.done;
            await h.delivery(task.taskId);
            check(
              '结果交回前台整理一次',
              task.status === 'completed' && h.counts.summary === 1 && h.counts.worker === 1,
              h.counts
            );
            check(
              '业务内部正文未直接发送',
              h.connector.actions.every((action) => action.text !== result.text),
              h.connector.actions.map((action) => action.text)
            );
          } finally {
            gate.resolve(undefined);
          }
        },
      });
    }
  );

  it.runIf(isSelected('F03'))('F03 整理重试耗尽保留业务结果，worker 不重跑', async () => {
    await runScenario({
      id: 'F03',
      name: '两次整理失败保留结果',
      hooks: {
        async runSummary() {
          return { ok: false, error: failure('TIMEOUT') };
        },
      },
      async run(h, check) {
        const handle = await h.submit('长任务');
        const task = await handle.done;
        await h.delivery(task.taskId);
        check(
          '整理最多两次且 worker 只运行一次',
          task.frontend.summaryAttempts === 2 && h.counts.summary === 2 && h.counts.worker === 1,
          { attempts: task.frontend.summaryAttempts, counts: h.counts }
        );
        check(
          '失败终态保留完整业务结果',
          task.status === 'failed' && task.worker?.result?.text === '完整业务结果：20',
          { status: task.status, workerText: task.worker?.result?.text }
        );
        const sent = h.connector.actions.filter((action) => action.status === 'received');
        check(
          '整理失败说明送达，原业务正文不直接发出',
          sent.some((action) => action.text.includes('整理')) &&
            sent.every((action) => !action.text.includes('完整业务结果')),
          sent.map((action) => action.text)
        );
      },
    });
  });

  it.runIf(isSelected('F04'))(
    'F04 多会话同时排队遵守 worker 并发上限，完成后释放全部资源',
    async () => {
      const gate = deferred<undefined>();
      const capacityReached = deferred<undefined>();
      let active = 0;
      let peak = 0;
      await runScenario({
        id: 'F04',
        name: '多会话容量上限',
        hooks: {
          async runWorker() {
            active++;
            peak = Math.max(peak, active);
            if (active === 4) capacityReached.resolve(undefined);
            try {
              await gate.promise;
              return { ok: true, value: result };
            } finally {
              active--;
            }
          },
        },
        async run(h, check) {
          try {
            const tasks: TaskHandleV3[] = [];
            for (let i = 0; i < 10; i++) tasks.push(await h.submit('长任务', `capacity-${i}`));
            await capacityReached.promise;
            const last = tasks.at(-1)!;
            await h.observe(
              (task) => task.taskId === last.taskId && task.frontend.initialEndedAt !== undefined
            );
            const snapshot = h.system.actor.snapshot();
            check(
              '最多四个 worker 执行，其余六个排队',
              active === 4 &&
                peak === 4 &&
                snapshot.worker.running === 4 &&
                snapshot.worker.queued === 6,
              {
                active,
                peak,
                scheduler: { running: snapshot.worker.running, queued: snapshot.worker.queued },
              }
            );
            const initialEnded = tasks.every(
              (task) => h.system.manager.get(task.taskId)?.frontend.initialEndedAt !== undefined
            );
            check(
              '运行总量不超过八个，全部首次前台已保存结束状态',
              snapshot.frontend.running + snapshot.worker.running <= 8 &&
                h.counts.frontend === 10 &&
                initialEnded,
              {
                frontendRunning: snapshot.frontend.running,
                workerRunning: snapshot.worker.running,
                frontends: h.counts.frontend,
                initialEnded,
              }
            );
            gate.resolve(undefined);
            const completed = await Promise.all(tasks.map((task) => task.done));
            await Promise.all(tasks.map((task) => h.delivery(task.taskId)));
            check(
              '十个任务均完成且峰值始终不超限',
              completed.every((task) => task.status === 'completed') && peak === 4 && active === 0,
              {
                completed: completed.filter((task) => task.status === 'completed').length,
                peak,
                active,
              }
            );
          } finally {
            gate.resolve(undefined);
            capacityReached.resolve(undefined);
          }
        },
      });
    }
  );

  it.runIf(isSelected('F05'))('F05 一个会话 worker 串行积压时，其他会话继续推进', async () => {
    const gate = deferred<undefined>();
    const started: string[] = [];
    await runScenario({
      id: 'F05',
      name: '跨会话公平与会话内串行',
      hooks: {
        async runWorker(task) {
          started.push(task.input.message.target.id);
          if (task.input.message.target.id === 'busy') await gate.promise;
          return { ok: true, value: result };
        },
      },
      async run(h, check) {
        try {
          const first = await h.submit('长任务', 'busy');
          await h.observe(
            (task) => task.taskId === first.taskId && task.worker?.receipt.status === 'running'
          );
          const second = await h.submit('长任务', 'busy');
          const third = await h.submit('长任务', 'busy');
          const other = await h.submit('长任务', 'free');
          const otherTask = await other.done;
          await h.delivery(other.taskId);
          check(
            '忙会话只运行一个 worker，其他会话先完成',
            h.system.manager.get(first.taskId)?.worker?.receipt.status === 'running' &&
              otherTask.status === 'completed' &&
              started.filter((session) => session === 'busy').length === 1,
            { started: [...started], otherStatus: otherTask.status }
          );
          gate.resolve(undefined);
          await Promise.all([first.done, second.done, third.done]);
          await Promise.all([first, second, third].map((task) => h.delivery(task.taskId)));
          check(
            '被阻塞会话仍按顺序完成全部 worker',
            started.join(',') === 'busy,free,busy,busy' && h.counts.worker === 4,
            { started, workers: h.counts.worker }
          );
        } finally {
          gate.resolve(undefined);
        }
      },
    });
  });

  it.runIf(isSelected('F06'))('F06 取消执行中的 worker 贯穿等待，禁止结果整理', async () => {
    const stopped = deferred<WorkerResult>();
    const started = deferred<undefined>();
    await runScenario({
      id: 'F06',
      name: '执行 worker 取消',
      hooks: {
        async runWorker(_task, _job, _context, signal) {
          const cancel = () => {
            stopped.resolve({
              status: 'cancelled',
              text: '',
              evidence: [],
              attachments: [],
              unfinished: [],
            });
          };
          signal.addEventListener('abort', cancel, { once: true });
          started.resolve(undefined);
          try {
            return { ok: true, value: await stopped.promise };
          } finally {
            signal.removeEventListener('abort', cancel);
          }
        },
      },
      async run(h, check) {
        try {
          const handle = await h.submit('长任务');
          await started.promise;
          check('取消已开始 worker 被接受', h.system.actor.cancel(handle.taskId), {
            taskId: handle.taskId,
          });
          const task = await handle.done;
          await stopped.promise;
          check(
            '取消终态不启动整理或再次执行 worker',
            task.status === 'cancelled' &&
              task.cancelAccepted &&
              h.counts.worker === 1 &&
              h.counts.summary === 0,
            { status: task.status, cancelAccepted: task.cancelAccepted, counts: h.counts }
          );
        } finally {
          stopped.resolve({
            status: 'cancelled',
            text: '',
            evidence: [],
            attachments: [],
            unfinished: [],
          });
          started.resolve(undefined);
        }
      },
    });
  });

  it.runIf(isSelected('F07'))('F07 stop 只取消已开始前台，保留尚未开始的排队输入', async () => {
    const gate = deferred<undefined>();
    const started = deferred<undefined>();
    await runScenario({
      id: 'F07',
      name: 'stop 保留首次前台排队任务',
      hooks: {
        async runFrontend(task, _job, _context, signal) {
          if (task.input.message.content === '挂起首次前台') {
            const cancel = () => {
              gate.resolve(undefined);
            };
            signal.addEventListener('abort', cancel, { once: true });
            started.resolve(undefined);
            try {
              await gate.promise;
              return { ok: false, error: failure('CANCELLED') };
            } finally {
              signal.removeEventListener('abort', cancel);
            }
          }
          return {
            ok: true,
            value: {
              kind: 'reply',
              reply: { replyId: `${task.taskId}:reply`, text: '排队输入已答复' },
            },
          };
        },
      },
      async run(h, check) {
        try {
          const first = await h.submit('挂起首次前台', 'stop');
          await started.promise;
          const queued = await h.submit('排队输入', 'stop');
          const count = h.system.actor.stop('onebot:group:stop');
          const firstTask = await first.done;
          const queuedTask = await queued.done;
          await h.delivery(queued.taskId);
          check('stop 只取消已经开始的 Task', count === 1 && firstTask.status === 'cancelled', {
            cancelled: count,
            first: firstTask.status,
          });
          check(
            '未开始首次前台的输入保留并完成',
            queuedTask.status === 'completed' && h.counts.worker === 0,
            { queued: queuedTask.status, workers: h.counts.worker }
          );
        } finally {
          gate.resolve(undefined);
          started.resolve(undefined);
        }
      },
    });
  });

  it.runIf(isSelected('F08'))('F08 同会话首次前台与待整理结果交替，均能得到额度', async () => {
    const workerGate = deferred<undefined>();
    const summaryGate = deferred<undefined>();
    const summaryStarted = deferred<undefined>();
    let summaryCalls = 0;
    await runScenario({
      id: 'F08',
      name: '首次前台与结果整理交替',
      hooks: {
        async runWorker() {
          await workerGate.promise;
          return { ok: true, value: result };
        },
        async runSummary(task) {
          summaryCalls++;
          if (summaryCalls === 1) {
            summaryStarted.resolve(undefined);
            await summaryGate.promise;
          }
          return {
            ok: true,
            value: { replyId: `${task.taskId}:reply`, text: '结果已经整理' },
          };
        },
      },
      async run(h, check) {
        const order: string[] = [];
        const seenJobs = new Set<string>();
        let off: (() => void) | undefined;
        try {
          const first = await h.submit('长任务甲', 'alternate');
          await h.observe(
            (task) => task.taskId === first.taskId && task.worker?.receipt.status === 'running'
          );
          const second = await h.submit('长任务乙', 'alternate');
          await h.observe(
            (task) => task.taskId === second.taskId && task.frontend.initialEndedAt !== undefined
          );
          workerGate.resolve(undefined);
          await summaryStarted.promise;
          off = h.system.manager.onChange((task) => {
            const job = task.frontend.activeJob;
            if (!job || seenJobs.has(job.jobId)) return;
            seenJobs.add(job.jobId);
            order.push(`${job.kind}:${task.input.message.content}`);
          });
          const ordinaryA = await h.submit('普通甲', 'alternate');
          const ordinaryB = await h.submit('普通乙', 'alternate');
          await h.observe(
            (task) => task.taskId === second.taskId && task.phase === 'summary-queued'
          );
          check(
            '首次输入与结果整理同时排队',
            h.system.manager.get(ordinaryA.taskId)?.phase === 'frontend-queued' &&
              h.system.manager.get(ordinaryB.taskId)?.phase === 'frontend-queued' &&
              h.system.manager.get(second.taskId)?.phase === 'summary-queued',
            { queued: h.system.actor.snapshot().frontend.queued }
          );
          summaryGate.resolve(undefined);
          const handles = [first, second, ordinaryA, ordinaryB];
          const completed = await Promise.all(handles.map((handle) => handle.done));
          await Promise.all(handles.map((handle) => h.delivery(handle.taskId)));
          check(
            '首次前台、整理、首次前台按顺序交替',
            order.join(',') === 'frontend:普通甲,summary:长任务乙,frontend:普通乙',
            { order }
          );
          check(
            '排队的普通请求和结果全部完成，无额外 worker',
            completed.every((task) => task.status === 'completed') &&
              h.counts.worker === 2 &&
              h.counts.summary === 2,
            { counts: h.counts, statuses: completed.map((task) => task.status) }
          );
        } finally {
          off?.();
          workerGate.resolve(undefined);
          summaryGate.resolve(undefined);
          summaryStarted.resolve(undefined);
        }
      },
    });
  });

  it.runIf(isSelected('F09'))(
    'F09 固定回复等待连接器，任务和原文件清理后独立附件副本仍可送达',
    async () => {
      const workerResult = deferred<WorkerResult>();
      let probe: OnebotProbe | undefined;
      await runScenario({
        id: 'F09',
        name: '固定回复与独立附件持久交付',
        hooks: {
          async runWorker() {
            return { ok: true, value: await workerResult.promise };
          },
        },
        async run(h, check) {
          try {
            h.connector.recordCapable = true;
            probe = new OnebotProbe(h.connector);
            await probe.start();
            const handle = await h.submit('长任务');
            await h.observe(
              (task) => task.taskId === handle.taskId && task.worker?.receipt.status === 'running'
            );
            h.connector.connected = false;
            const original = join(h.root, 'report.csv');
            const contents = 'name,total\nA,20\n';
            await writeFile(original, contents);
            workerResult.resolve({
              ...result,
              attachments: [
                {
                  kind: 'file',
                  absPath: original,
                  fileName: 'report.csv',
                  sizeBytes: Buffer.byteLength(contents),
                },
              ],
            });
            const task = await handle.done;
            const messages = h.system.queue.messages(task.taskId);
            const attachment = messages.find((row) => row.candidate.attachment)?.candidate
              .attachment;
            const copied = attachment ? readStoredZip(await readFile(attachment.absPath)) : [];
            check(
              '执行完成与等待送达状态分开，附件已保存独立副本',
              task.status === 'completed' &&
                h.system.queue.taskDelivery(task.taskId).pending &&
                attachment?.absPath !== original &&
                attachment?.fileName.endsWith('.zip') === true &&
                copied.length === 1 &&
                copied[0]?.name === 'report.csv' &&
                copied[0]?.text === contents,
              {
                execution: task.status,
                deliveryPending: h.system.queue.taskDelivery(task.taskId).pending,
                independentCopy: attachment?.absPath !== original,
                copied,
              }
            );
            const ids = messages.map((row) => row.id).sort();
            h.system.actor.flushSettlements();
            h.clock.advance(8 * 86400000);
            await h.system.prune();
            await unlink(original);
            check(
              '任务清理保留固定消息，不再次调用 worker 或整理',
              h.system.manager.get(task.taskId) === undefined &&
                h.system.queue
                  .messages(task.taskId)
                  .map((row) => row.id)
                  .sort()
                  .join(',') === ids.join(',') &&
                h.counts.worker === 1 &&
                h.counts.summary === 1,
              { taskRemoved: h.system.manager.get(task.taskId) === undefined, counts: h.counts }
            );
            h.connector.connected = true;
            h.system.queue.wake();
            await h.delivery(task.taskId);
            const sent = h.connector.actions.filter((action) => action.status === 'received');
            check(
              '原文件删除后附件完整送达一次',
              deliveredArchiveMatches(
                probe.actions.flatMap((action) => action.zipEntries ?? []),
                copied
              ) && !h.system.queue.taskDelivery(task.taskId).pending,
              {
                attachments: sent
                  .flatMap((action) => action.attachments)
                  .map((file) => ({
                    fileName: file.fileName,
                    text: file.text,
                    sha256: file.sha256,
                  })),
                pending: h.system.queue.taskDelivery(task.taskId).pending,
                zipEntries: probe.actions.flatMap((action) => action.zipEntries ?? []),
                payloadBytes: probe.actions.map((action) => action.payloadBytes),
              }
            );
          } finally {
            await probe?.stop();
            workerResult.resolve({ ...result, status: 'cancelled' });
          }
        },
      });
    }
  );
});

for (const group of productionGroups) {
  it(`${group.id} ${group.name}`, async () => {
    if (isSelected(group.id)) await runProductionGroup(group);
  }, 120_000);
}

afterAll(async () => {
  await writeReport(registry);
});
