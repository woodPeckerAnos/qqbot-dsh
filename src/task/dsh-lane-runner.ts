import { failure } from '@qqbot/contracts';
import type { DeepReadonly } from '@qqbot/contracts';
import type { AgentTraceObserver, LaneRunnerV2 as LaneRunner } from '@qqbot/contracts';
/**
 * 一个 lane 的 DSH 执行边界：取得独占 runtime 租约、注册执行身份与事件监听，
 * 再派发 prompt。父执行及所属子代理全部结束后，停止具体进程并收集交付物。
 * 超时、取消和异常均在 finally 释放监听器与租约，不借用其他执行的 runtime。
 */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeLease, RuntimePool } from '@qqbot/contracts';
import type {
  SessionEventNotification,
  SessionStatusNotification,
  SubagentStartedNotification,
  SubagentFinishedNotification,
} from '@qqbot/contracts';
import { createAgentTraceObserver } from '../runtime/index.js';
import { createTurnAccumulator } from '../runtime/index.js';
import { scanOutbox } from '../media/index.js';
import type { MessageContext } from '@qqbot/contracts';
import type { Config } from '@qqbot/contracts';
import { traceSpan, legacyTrace } from '../observability/index.js';
import type { Logger } from '@qqbot/contracts';
import { SYSTEM_CLOCK } from '@qqbot/contracts';
import type { TaskClock } from '@qqbot/contracts';
import type { TaskLifeCycleManagerV2 as TaskLifeCycleManager } from '@qqbot/contracts';
import type { PromptPreparerV2 as PromptPreparer } from '@qqbot/contracts';
import type { TaskControlBridgeV2 as TaskControlBridge } from '@qqbot/contracts';
import type {
  Lane,
  LaneEvent,
  LaneResultV2 as LaneResult,
  TaskSnapshotV2 as TaskSnapshot,
} from '@qqbot/contracts';
import { BusinessOutcome } from './business-outcome.js';
import { bindCooperationRequest } from './cooperation.js';

function silentResult(lane: Lane, failureReason: BusinessOutcome['failureReason']): LaneResult {
  if (failureReason)
    return {
      kind: 'failed',
      text: {
        'tool-unsettled': '工具调用尚未结束，未能得到完整结果。',
        'query-failed': '查询失败，未能得到有效结果。',
        'tool-failed': '工具执行失败，未能得到有效结果。',
      }[failureReason],
      error: failureReason,
    };
  return { kind: 'silent', reason: lane === 'slow' ? 'no-increment' : 'no-long-skill' };
}

/** 调度器只依赖此接口，验收可替换 DSH，不需要真实模型或已部署客户端。 */
export type { LaneRunnerV2 as LaneRunner } from '@qqbot/contracts';
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
      cooperation?: import('@qqbot/contracts').TaskCooperation;
    }
  ) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }
  async run(
    task: DeepReadonly<TaskSnapshot>,
    lane: Lane,
    context: MessageContext,
    signal: AbortSignal
  ): Promise<LaneResult> {
    const { preparer, manager, config } = this.options;
    const pool = this.options.pools[lane];
    let logger = this.options.logger.withTrace(
      task.lanes[lane].trace ?? task.input.trace ?? legacyTrace(task.taskId)
    );
    let observer: AgentTraceObserver | undefined;
    let executionId: string | undefined;
    let lease: RuntimeLease | undefined;
    let result: LaneResult;
    const disposers: (() => void)[] = [];
    const cooperationAbort = new AbortController();
    try {
      const prepared = await preparer.prepare(task, {
        ...context,
        trace: task.lanes[lane].trace,
        logger,
      });
      if (signal.aborted) return { kind: 'cancelled' };
      const workspace = join(preparer.workspace(task), lane);
      await mkdir(workspace, { recursive: true });
      await copyFile(
        join(preparer.workspace(task), 'AGENTS.md'),
        join(workspace, 'AGENTS.md')
      ).catch(() => {});
      executionId = randomUUID();
      const sessionId = `task-${task.taskId}-${lane}-${executionId}`;
      logger = this.options.logger.withTrace(
        traceSpan(task.lanes[lane].trace ?? task.input.trace ?? legacyTrace(task.taskId), {
          executionId,
          dshSessionId: sessionId,
        })
      );
      const control = this.options.control.bind(task);
      // 隔离键包含 Task 和 lane，fd 3 控制请求还必须匹配本次唯一 sessionId。
      const acquiring = pool.acquireLease(
        `${task.input.message.target.key}:${lane}:${task.taskId}`,
        workspace,
        {
          logger,
          env: {
            QQBOT_TASK_CHANNEL: '1',
            QQBOT_LANE: lane,
            QQBOT_TASK_ID: task.taskId,
            QQBOT_EXECUTION_ID: executionId,
            QQBOT_ROOT_SESSION_ID: sessionId,
          },
          taskCooperation:
            lane === 'slow'
              ? bindCooperationRequest(
                  this.options.cooperation,
                  { taskId: task.taskId, executionId, sessionId },
                  () => lease,
                  manager,
                  signal,
                  cooperationAbort.signal
                )
              : undefined,
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
      lease = await new Promise<RuntimeLease>((resolveLease, reject) => {
        const aborted = () => {
          reject(new Error('runtime 租约等待已取消'));
        };
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
          (error: unknown) => {
            signal.removeEventListener('abort', aborted);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        );
        if (signal.aborted) aborted();
      });
      if (signal.aborted) return { kind: 'cancelled' };
      const execution = { executionId, sessionId, runtimeGeneration: lease.generation };
      if (!manager.start(task.taskId, lane, execution)) return { kind: 'cancelled' };
      const trace = manager.get(task.taskId)?.lanes[lane].trace ?? legacyTrace(task.taskId);
      logger = this.options.logger.withTrace(trace);
      logger.event('execution.started');
      const executionStartedAt = this.clock.now();
      observer = createAgentTraceObserver({
        trace,
        logger,
        deferBudgetRelease: true,
        isCurrent: () => manager.matches(task.taskId, lane, execution),
        now: () => this.clock.now(),
      });
      const tracing = observer;
      const runtime = lease.runtime;
      if (lane === 'slow' && this.options.cooperation) {
        const binding = { taskId: task.taskId, ...execution };
        disposers.push(
          this.options.cooperation.subscribe(task.taskId, (snapshot) => {
            if (
              !signal.aborted &&
              !cooperationAbort.signal.aborted &&
              manager.matches(task.taskId, lane, execution)
            )
              runtime.notifyTaskCooperation?.({ type: 'cooperation', binding, snapshot });
          })
        );
      }
      const accumulator = createTurnAccumulator(sessionId);
      const children = new Set<string>();
      const childParents = new Map<string, string>();
      const business = new BusinessOutcome();
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
          cooperationAbort.abort();
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
              replyAttention(outcome.text).text && replyAttention(outcome.text).text !== 'NO_REPLY'
                ? `任务执行失败：${replyAttention(outcome.text).text}`
                : '任务执行失败，请稍后重新提交。',
            error: childFailed ? 'subagent-failed' : outcome.reason,
          });
          return;
        }
        const final = replyAttention(outcome.text);
        const text = final.text;
        // Successful tools can add no user-visible increment; failures and unfinished tools cannot be silent.
        if (text === 'NO_REPLY') {
          finish(silentResult(lane, business.failureReason));
        } else if (!text)
          finish({
            kind: 'failed',
            text: '任务执行结束，但没有返回有效结果。',
            error: 'empty-result',
          });
        else finish({ kind: 'reply', text, attention: final.attention });
      };
      const event = (notification: SessionEventNotification) => {
        tracing.observe(notification);
        if (
          settled ||
          notification.sessionId !== sessionId ||
          !manager.matches(task.taskId, lane, execution) ||
          notification.event.seq <= lastSeq
        )
          return;
        lastSeq = notification.event.seq;
        try {
          this.options.onEvent?.({
            taskId: task.taskId,
            sessionKey: task.input.message.target.key,
            lane,
            ...execution,
            type: notification.event.type,
          });
        } catch (error) {
          logger.cause(error, 'lane-observer-failed');
        }
        business.observe(notification.event);
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
        tracing.started(n);
        if (settled || !manager.matches(task.taskId, lane, execution)) return;
        if (
          !childParents.has(n.childSessionId) &&
          (n.parentSessionId === sessionId || children.has(n.parentSessionId))
        ) {
          childParents.set(n.childSessionId, n.parentSessionId);
          children.add(n.childSessionId);
        }
      };
      const finished = (n: SubagentFinishedNotification) => {
        tracing.finished(n);
        if (
          !settled &&
          manager.matches(task.taskId, lane, execution) &&
          childParents.get(n.childSessionId) === n.parentSessionId &&
          children.delete(n.childSessionId)
        ) {
          childFailed ||= n.status === 'error';
          check();
        }
      };
      const abort = () => {
        finish({ kind: 'cancelled' });
      };
      const exit = () => {
        finish({
          kind: 'failed',
          text: '任务运行进程退出，执行中断。',
          error: 'runtime-exit',
          errorId: runtime.lastErrorId,
        });
      };
      const invalid = () => {
        tracing.invalid();
      };
      const unknown = () => {
        tracing.unknown();
      };
      const violation = (error: unknown) => {
        if (settled) return;
        finish({
          kind: 'failed',
          text: '任务协议异常，执行已停止。',
          error: 'protocol-violation',
          errorId: runtime.lastErrorId ?? logger.cause(error, 'protocol-violation'),
        });
      };
      runtime.on('invalid', invalid);
      runtime.on('unknown', unknown);
      runtime.on('violation', violation);
      runtime.on('session.event', event);
      runtime.on('session.status', status);
      runtime.on('subagent.started', started);
      runtime.on('subagent.finished', finished);
      runtime.on('exit', exit);
      const channelClosed = () => {
        if (lane === 'slow' && this.options.cooperation)
          finish({
            kind: 'failed',
            text: '协作通道关闭，任务已停止。',
            error: 'cooperation-channel-closed',
          });
      };
      disposers.push(runtime.onTaskChannelClose?.(channelClosed) ?? (() => {}));
      signal.addEventListener('abort', abort, { once: true });
      disposers.push(() => {
        runtime.off('invalid', invalid);
        runtime.off('unknown', unknown);
        runtime.off('violation', violation);
        runtime.off('session.event', event);
        runtime.off('session.status', status);
        runtime.off('subagent.started', started);
        runtime.off('subagent.finished', finished);
        runtime.off('exit', exit);
        signal.removeEventListener('abort', abort);
      });
      const timer = this.clock.setTimeout(
        () => {
          finish({ kind: 'failed', text: '任务执行超时，已停止执行。', error: 'lane-timeout' });
        },
        lane === 'fast' ? config.tasks.fastTimeoutMs : config.tasks.slowTimeoutMs
      );
      disposers.push(() => {
        this.clock.clearTimeout(timer);
      });
      const instruction =
        lane === 'fast'
          ? '你在快 lane。立即给出简短答复；需要研究、工具、文件或深度推理时简短承接，说明正在继续处理。你和慢 lane 是同一个完整 agent，不因快 lane 工具限制否认整个 agent 的能力，不提前宣称任务已完成。仅可使用 query_tasks 和 cancel_task 查询或取消旧任务，不执行业务工具。'
          : '你在慢 lane，自行判断是否需要长技能，深度推理也属于长技能。完整执行并等待所有子代理结束，子代理只能前台等待。协作快照会告知同 Task 快 lane 实际成功送达的正文及失败分段。只交付新增信息，不复述已送达答案；没有增量时仅返回 NO_REPLY，成功执行工具后也允许。未送达的答案仍需答复；结论反转时明确回指先前快答并纠正。执行失败、超时、空结果以及需要说明的附件必须如实反馈。主动请求的快 lane 完整送达后，由出口决定是否省略慢失败正文，执行状态仍失败；附件及必要说明仍交付。结束前按最新协作快照完成衔接。';
      const blocks = [
        {
          type: 'text' as const,
          text: `${instruction}\nTask ID：${task.taskId}\n只处理标明的当前 Task 输入。历史与观察仅作背景，其他 Task 的未完成承诺由原执行继续处理，不因旧承诺接管旧任务或生成旧附件；当前输入明确要求重做或追加时才按本次指令执行。\n普通回复不要 @。只有明确需要强烈定向提醒时，才可在最终正文首行单独写 [REPLY_ATTENTION:strong]；这是内部标记，提醒对象只能是当前 Task 的原消息作者。\n最终交付物仅放在 ${join(workspace, config.media.outboxDir)}，临时文件不放那里。`,
        },
        ...prepared.blocks,
      ];
      // 监听器、身份和计时器先于派发，连同步 mock 事件也不会漏收或串属。
      void runtime.prompt(sessionId, blocks).catch((error: unknown) => {
        if (settled) return;
        finish({
          kind: 'failed',
          text: '任务派发失败，请稍后重新提交。',
          error: 'prompt-failed',
          errorId: logger.cause(error, 'prompt-failed'),
        });
      });
      result = await done;
      if (result.kind === 'failed' && !result.errorId)
        result = { ...result, errorId: logger.cause(new Error(result.error), result.error) };
      logger.event('execution.ended', {
        resultKind: result.kind,
        durationMs: this.clock.now() - executionStartedAt,
        ...(result.kind === 'failed' ? { errorId: result.errorId, errorClass: result.error } : {}),
      });
      tracing.close();
      manager.endExecution(task.taskId, lane);
      const artifactStartedAt = this.clock.now();
      const artifactTrace = traceSpan(trace);
      logger = this.options.logger.withTrace(artifactTrace);
      disposers.forEach((fn) => {
        fn();
      });
      disposers.length = 0;
      // 先停止具体进程再扫描交付物，避免收尾期间仍有工具或子代理写文件。
      await pool.drop(lease);
      if (config.media.enabled && lane === 'slow') {
        const outbox = await scanOutbox(join(workspace, config.media.outboxDir), {
          maxFileBytes: config.media.maxFileBytes,
          imageExtensions: config.media.imageExtensions,
          logger,
        });
        if (outbox.oversize.length || outbox.skipped.length) {
          const text = `部分交付物无法发送：${[...outbox.oversize, ...outbox.skipped].join('、')}。`;
          result =
            result.kind === 'failed'
              ? {
                  ...result,
                  text: `${result.text}\n${text}`,
                  requiredExplanation: text,
                  attachments: outbox.attachments,
                }
              : {
                  kind: 'failed',
                  text,
                  error: 'invalid-deliverable',
                  requiredExplanation: text,
                  attachments: outbox.attachments,
                };
        } else if (outbox.attachments.length) {
          if (result.kind === 'silent')
            result = context.connector.policy(task.input.message.target.kind).record
              ? {
                  kind: 'reply',
                  text: '',
                  attachments: outbox.attachments,
                }
              : {
                  kind: 'failed',
                  text: '任务产生了交付物但没有说明结果。',
                  error: 'silent-with-deliverables',
                  requiredExplanation: '任务产生了交付物但没有说明结果。',
                  attachments: outbox.attachments,
                };
          else result = { ...result, attachments: outbox.attachments };
        }
      }
      if (result.kind === 'failed' && !result.errorId)
        result = { ...result, errorId: logger.cause(new Error(result.error), result.error) };
      if (result.kind === 'failed')
        result = {
          ...result,
          failure: failure(
            result.error === 'lane-timeout' ? 'TIMEOUT' : 'UPSTREAM_FAILED',
            result.error,
            result.errorId
          ),
        };
      result = { ...result, trace: artifactTrace };
      logger.event('artifact.prepared', {
        resultKind: result.kind,
        contentLength: 'text' in result ? result.text.length : 0,
        attachmentCount: 'attachments' in result ? (result.attachments?.length ?? 0) : 0,
        durationMs: this.clock.now() - artifactStartedAt,
      });
      return result;
    } catch (error) {
      return signal.aborted
        ? { kind: 'cancelled' }
        : {
            kind: 'failed',
            text: '任务执行失败，请稍后重新提交。',
            error: 'lane-failed',
            failure: failure('UPSTREAM_FAILED', undefined, logger.cause(error, 'lane-failed')),
            errorId: logger.cause(error, 'lane-failed'),
          };
    } finally {
      cooperationAbort.abort();
      observer?.close();
      disposers.forEach((fn) => {
        fn();
      });
      if (lease) await pool.drop(lease);
      if (executionId) logger.finishExecution(executionId);
    }
  }
}

/** Only an exact first line grants intent; internal markers never reach the user. */
function replyAttention(raw: string): { text: string; attention?: 'strong' } {
  const trimmed = raw.trim();
  const strong = /^\[REPLY_ATTENTION:strong\](?:\r?\n|$)/.test(trimmed);
  return {
    text: trimmed.replace(/\[REPLY_ATTENTION:strong\]/g, '').trim(),
    attention: strong ? 'strong' : undefined,
  };
}
