/**
 * 一个 lane 的 DSH 执行边界：取得独占 runtime 租约、注册执行身份与事件监听，
 * 再派发 prompt。父执行及所属子代理全部结束后，停止具体进程并收集交付物。
 * 超时、取消和异常均在 finally 释放监听器与租约，不借用其他执行的 runtime。
 */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeEntry, RuntimePool } from '../dsh/pool.js';
import type {
  SessionEventNotification,
  SessionStatusNotification,
  SubagentStartedNotification,
  SubagentFinishedNotification,
} from '../dsh/protocol.js';
import { TurnAccumulator } from '../dsh/turns.js';
import { scanOutbox } from '../pipeline/egress/outbox.js';
import type { MessageContext } from '../pipeline/ingress/types.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { SYSTEM_CLOCK, type TaskClock } from './clock.js';
import type { TaskLifeCycleManager } from './lifecycle.js';
import type { PromptPreparer } from './prompt-preparer.js';
import type { TaskControlBridge } from './control-bridge.js';
import type { Lane, LaneEvent, LaneResult, TaskSnapshot } from './types.js';

/** 调度器只依赖此接口，验收可替换 DSH，不需要真实模型或已部署客户端。 */
export interface LaneRunner {
  run(
    task: Readonly<TaskSnapshot>,
    lane: Lane,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<LaneResult>;
}
export class DshLaneRunner implements LaneRunner {
  private readonly clock: TaskClock;
  constructor(
    private readonly options: {
      pools: Record<Lane, RuntimePool>;
      manager: TaskLifeCycleManager;
      preparer: PromptPreparer;
      control: TaskControlBridge;
      config: Config;
      logger: Logger;
      clock?: TaskClock;
      onEvent?: (event: LaneEvent) => void;
    }
  ) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }
  async run(
    task: Readonly<TaskSnapshot>,
    lane: Lane,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<LaneResult> {
    const { preparer, manager, config } = this.options;
    const pool = this.options.pools[lane];
    let lease: RuntimeEntry | undefined;
    let result: LaneResult;
    const disposers: (() => void)[] = [];
    try {
      const prepared = await preparer.prepare(task, context);
      if (signal.aborted) return { kind: 'cancelled' };
      const workspace = join(preparer.workspace(task), lane);
      await mkdir(workspace, { recursive: true });
      await copyFile(
        join(preparer.workspace(task), 'AGENTS.md'),
        join(workspace, 'AGENTS.md')
      ).catch(() => {});
      const executionId = randomUUID();
      const sessionId = `task-${task.taskId}-${lane}-${executionId}`;
      const control = this.options.control.bind(task);
      // 隔离键包含 Task 和 lane，fd 3 控制请求还必须匹配本次唯一 sessionId。
      const acquiring = pool.acquireLease(
        `${task.input.message.target.key}:${lane}:${task.taskId}`,
        workspace,
        {
          env: { QQBOT_TASK_CHANNEL: '1', QQBOT_LANE: lane },
          taskControl: (request) => {
            if (signal.aborted || request.sessionId !== sessionId)
              return { accepted: false, reason: '执行身份已失效' };
            if (request.action === 'query') return control.query(request.taskId);
            if (request.action === 'cancel' && typeof request.taskId === 'string')
              return control.cancel(request.taskId);
            return { accepted: false, reason: '未知控制操作' };
          },
        },
        signal
      );
      lease = await new Promise<RuntimeEntry>((resolveLease, reject) => {
        const aborted = () => reject(new Error('runtime 租约等待已取消'));
        signal.addEventListener('abort', aborted, { once: true });
        void acquiring.then(
          async (entry) => {
            signal.removeEventListener('abort', aborted);
            // 取消可能先于初始化完成；迟到的租约仍由本次等待者负责销毁。
            if (signal.aborted) {
              await pool.drop(entry);
              reject(new Error('runtime 租约已取消'));
            } else resolveLease(entry);
          },
          (error) => {
            signal.removeEventListener('abort', aborted);
            reject(error);
          }
        );
        if (signal.aborted) aborted();
      });
      lease.busy = true;
      if (signal.aborted) return { kind: 'cancelled' };
      const execution = { executionId, sessionId, runtimeGeneration: lease.generation };
      if (!manager.start(task.taskId, lane, execution)) return { kind: 'cancelled' };
      const runtime = lease.runtime;
      const accumulator = new TurnAccumulator(sessionId);
      const children = new Set<string>();
      let businessCalls = 0;
      let childFailed = false;
      let lastSeq = -1;
      let resolve!: (result: LaneResult) => void;
      const done = new Promise<LaneResult>((r) => {
        resolve = r;
      });
      let settled = false;
      const finish = (value: LaneResult) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      // 父 turn/end 不代表所属子代理都结束，避免提前结算慢 lane。
      const check = () => {
        if (!accumulator.isSettled || children.size) return;
        const outcome = accumulator.result();
        if (outcome.kind !== 'completed' || childFailed) {
          finish({
            kind: 'failed',
            text:
              outcome.text && outcome.text !== 'NO_REPLY'
                ? `任务执行失败：${outcome.text}`
                : '任务执行失败，请稍后重新提交。',
            error: childFailed ? 'subagent-failed' : outcome.reason,
          });
          return;
        }
        const text = outcome.text.trim();
        // 控制工具不算业务执行；调用业务工具后 NO_REPLY 属于契约失败。
        if (text === 'NO_REPLY') {
          if (businessCalls)
            finish({
              kind: 'failed',
              text: '任务已执行，但没有返回有效结果。',
              error: 'silent-after-execution',
            });
          else finish({ kind: 'silent', reason: 'no-long-skill' });
        } else if (!text)
          finish({
            kind: 'failed',
            text: '任务执行结束，但没有返回有效结果。',
            error: 'empty-result',
          });
        else finish({ kind: 'reply', text });
      };
      const event = (notification: SessionEventNotification) => {
        if (
          settled ||
          notification.sessionId !== sessionId ||
          !manager.matches(task.taskId, lane, execution) ||
          notification.event.seq <= lastSeq
        )
          return;
        lastSeq = notification.event.seq;
        this.options.onEvent?.({
          taskId: task.taskId,
          sessionKey: task.input.message.target.key,
          lane,
          ...execution,
          type: notification.event.type,
        });
        if (notification.event.type === 'tool/call') {
          const data = notification.event.data as { name?: string; call?: { name?: string } };
          if (!['query_tasks', 'cancel_task'].includes(data.name ?? data.call?.name ?? ''))
            businessCalls++;
        }
        accumulator.observe(notification.event);
        check();
      };
      const status = (notification: SessionStatusNotification) => {
        if (
          settled ||
          notification.sessionId !== sessionId ||
          !manager.matches(task.taskId, lane, execution)
        )
          return;
        accumulator.observeStatus(notification.status);
        check();
      };
      const started = (n: SubagentStartedNotification) => {
        if (n.parentSessionId === sessionId || children.has(n.parentSessionId))
          children.add(n.childSessionId);
      };
      const finished = (n: SubagentFinishedNotification) => {
        if (children.delete(n.childSessionId)) {
          childFailed ||= n.status === 'error';
          check();
        }
      };
      const abort = () => finish({ kind: 'cancelled' });
      const exit = () =>
        finish({ kind: 'failed', text: '任务运行进程退出，执行中断。', error: 'runtime-exit' });
      runtime.on('session.event', event);
      runtime.on('session.status', status);
      runtime.on('subagent.started', started);
      runtime.on('subagent.finished', finished);
      runtime.on('exit', exit);
      signal.addEventListener('abort', abort, { once: true });
      disposers.push(() => {
        runtime.off('session.event', event);
        runtime.off('session.status', status);
        runtime.off('subagent.started', started);
        runtime.off('subagent.finished', finished);
        runtime.off('exit', exit);
        signal.removeEventListener('abort', abort);
      });
      const timer = this.clock.setTimeout(
        () => finish({ kind: 'failed', text: '任务执行超时，已停止执行。', error: 'lane-timeout' }),
        lane === 'fast' ? config.tasks.fastTimeoutMs : config.tasks.slowTimeoutMs
      );
      disposers.push(() => this.clock.clearTimeout(timer));
      const instruction =
        lane === 'fast'
          ? '你在快 lane。立即给出简短答复；需要长技能时说明任务会继续执行。仅可使用 query_tasks 和 cancel_task 查询或取消旧任务，不执行业务工具。'
          : '你在慢 lane，自行判断是否需要长技能；深度推理也属于长技能。普通问答且无需长技能时仅返回 NO_REPLY。需要工具、研究、文件或深度推理时完整执行并等待所有子代理结束，子代理只能前台等待，最后返回最终结果。实际执行后失败、超时或空结果必须明确说明，执行后禁止返回 NO_REPLY。';
      const blocks = [
        {
          type: 'text' as const,
          text: `${instruction}\nTask ID：${task.taskId}\n最终交付物仅放在 ${join(workspace, config.media.outboxDir)}，临时文件不放那里。`,
        },
        ...prepared.blocks,
      ];
      // 监听器、身份和计时器先于派发，连同步 mock 事件也不会漏收或串属。
      void runtime
        .prompt(sessionId, blocks)
        .catch((error: unknown) =>
          finish({ kind: 'failed', text: '任务派发失败，请稍后重新提交。', error: String(error) })
        );
      result = await done;
      manager.endExecution(task.taskId, lane);
      disposers.forEach((fn) => fn());
      disposers.length = 0;
      // 先停止具体进程再扫描交付物，避免收尾期间仍有工具或子代理写文件。
      await pool.drop(lease);
      if (config.media.enabled && lane === 'slow') {
        const outbox = await scanOutbox(join(workspace, config.media.outboxDir), {
          maxFileBytes: config.media.maxFileBytes,
          imageExtensions: config.media.imageExtensions,
          logger: this.options.logger,
        });
        if (outbox.oversize.length || outbox.skipped.length) {
          const text = `部分交付物无法发送：${[...outbox.oversize, ...outbox.skipped].join('、')}。`;
          result = {
            kind: 'failed',
            text,
            error: 'invalid-deliverable',
            attachments: outbox.attachments,
          };
        } else if (outbox.attachments.length) {
          if (result.kind === 'silent')
            result = {
              kind: 'failed',
              text: '任务产生了交付物但没有说明结果。',
              error: 'silent-with-deliverables',
              attachments: outbox.attachments,
            };
          else result = { ...result, attachments: outbox.attachments };
        }
      }
      return result;
    } catch (error) {
      return signal.aborted
        ? { kind: 'cancelled' }
        : { kind: 'failed', text: '任务执行失败，请稍后重新提交。', error: String(error) };
    } finally {
      disposers.forEach((fn) => fn());
      if (lease) await pool.drop(lease);
    }
  }
}
