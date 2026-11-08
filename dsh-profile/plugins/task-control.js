/**
 * DSH 的 Task 查询/取消工具。fd 3 独立于模型事件通道，请求附带执行 sessionId，
 * 权限最终由父进程绑定的 TaskControlBridge 判断。
 * 快 lane 同时限制工具发现与实际调用，防止通过 PTC 或局部工具绕过限制。
 */
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'qqbot-task-control';
export const inject = ['tools'];
export function apply(ctx) {
  if (!process.env.QQBOT_TASK_CHANNEL) return;
  const socket = new Socket({ fd: 3, readable: true, writable: true });
  const pending = new Map();
  const binding = {
    taskId: process.env.QQBOT_TASK_ID,
    executionId: process.env.QQBOT_EXECUTION_ID,
    runtimeGeneration: process.env.QQBOT_RUNTIME_GENERATION,
    sessionId: process.env.QQBOT_ROOT_SESSION_ID,
  };
  let cooperation;
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        const response = JSON.parse(line);
        if (response.type === 'cooperation') cooperation?.receive(response);
        else if (response.error) pending.get(response.id)?.reject(new Error(response.error));
        else pending.get(response.id)?.resolve(response.value);
      } catch {
        socket.destroy(new Error('Task 控制协议异常'));
        return;
      }
    }
  });
  const close = () => {
    cooperation?.close();
    for (const item of pending.values()) item.reject(new Error('Task 控制通道关闭'));
    pending.clear();
  };
  socket.on('error', close);
  socket.on('close', close);
  // 每次请求拥有自己的超时与取消监听，成功、失败及通道关闭都走同一清理路径。
  const call = (action, taskId, exec) =>
    new Promise((resolve, reject) => {
      if (exec.signal?.aborted || socket.destroyed) {
        reject(new Error('Task 控制已取消或关闭'));
        return;
      }
      const id = randomUUID();
      const cleanup = () => {
        clearTimeout(timer);
        pending.delete(id);
        exec.signal?.removeEventListener('abort', abort);
      };
      const failed = (error) => {
        cleanup();
        reject(error);
      };
      const timer =
        action === 'cooperation-wait'
          ? undefined
          : setTimeout(() => failed(new Error('Task 控制超时')), 5000);
      const abort = () => failed(new Error('Task 控制已取消'));
      exec.signal?.addEventListener('abort', abort, { once: true });
      pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: failed,
      });
      socket.write(
        JSON.stringify({
          id,
          ...binding,
          action,
          taskId: action.startsWith('cooperation-') ? binding.taskId : taskId,
          sessionId: exec.agent?.session?.id,
        }) + '\n',
        (error) => {
          if (error) failed(error);
        }
      );
    });
  installTaskTools(ctx, call, process.env.QQBOT_LANE === 'fast');
  if (process.env.QQBOT_LANE === 'slow') cooperation = installLaneCooperation(ctx, call, binding);
  ctx.on('dispose', () => {
    close();
    socket.destroy();
  });
}

/** All updates are scoped to the trusted slow root; children never receive them. */
export function installLaneCooperation(ctx, call, binding) {
  let agent;
  let latest;
  let injected = 0;
  let consumed = 0;
  let closed = false;
  const messages = new Map();
  const matches = (candidate) =>
    ['taskId', 'executionId', 'runtimeGeneration', 'sessionId'].every(
      (key) => candidate?.[key] === binding[key] && typeof binding[key] === 'string'
    );
  const injectLatest = () => {
    if (closed || !agent || !latest || latest.revision <= injected) return;
    const id = randomUUID();
    const text = `同 Task 快慢协作快照：${JSON.stringify(latest)}\ndelivered 仅表示本 Task 快答。只依据其中成功送达的原始正文衔接：同 Task 快答已完整满足本次请求且没有增量时仅返回 NO_REPLY；当前明确要求引用或复述其他 Task 已有结果时，应使用可核对正文完成本次答复，不重做旧业务。旧 Task 已送达或本 Task 快答仅告知等待，都不表示当前复述请求已完成。有增量时仅交付新增部分；反转结论时明确回指并纠正。未送达或失败的正文仍需答复。成功工具执行可以无增量静默，失败、空结果和需要说明的附件必须反馈。不要把快 lane 工具限制当成整个 agent 能力限制。本快照和本次执行仅属于当前 Task；历史中其他 Task 的未完成承诺由原 Task 继续处理，不得补做旧任务或为旧任务生成附件。`;
    messages.set(id, latest.revision);
    agent.inject({
      id,
      role: 'user',
      source: { kind: 'plugin', plugin: name },
      content: [{ type: 'text', text }],
    });
    injected = latest.revision;
  };
  const update = (snapshot) => {
    if (
      closed ||
      snapshot?.taskId !== binding.taskId ||
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision <= (latest?.revision ?? 0)
    )
      return;
    latest = snapshot;
    injectLatest();
  };
  ctx.on('agent/created', ({ agent: created }) => {
    if (closed || created.session.id !== binding.sessionId) return;
    agent = created;
    injectLatest();
    void call('cooperation-read', binding.taskId, { agent }).then(update, () => {});
  });
  // A committed user/message proves next-step consumption; pre-step admission can still abort.
  ctx.on('session/event', (session, event) => {
    if (closed || session.id !== binding.sessionId || event.type !== 'user/message') return;
    const revision = messages.get(event.data.id);
    if (revision !== undefined) {
      consumed = Math.max(consumed, revision);
      messages.delete(event.data.id);
    }
  });
  ctx.on('agent/turn-stopping', async ({ agent: stopping, signal }) => {
    if (closed || stopping !== agent || stopping.session.id !== binding.sessionId) return;
    const snapshot = await call('cooperation-wait', binding.taskId, { agent, signal });
    if (closed || signal.aborted) return;
    update(snapshot);
    if (!latest?.ready) throw new Error('协作等待没有返回终态快照');
    if (consumed < latest.revision) injectLatest();
  });
  return {
    receive: (message) => {
      if (matches(message.binding)) update(message.snapshot);
    },
    close: () => {
      closed = true;
      agent = undefined;
      latest = undefined;
      messages.clear();
    },
  };
}

export function installTaskTools(ctx, call, fast) {
  const output = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  };
  ctx.tools.register(
    defineTool({
      name: 'query_tasks',
      description: '查询本会话任务及其执行状态和结果。省略 taskId 列出任务。',
      parameters: { taskId: { type: 'string' } },
      output,
      execute: async (args, exec) => ({ tasks: await call('query', args.taskId, exec) }),
    })
  );
  ctx.tools.register(
    defineTool({
      name: 'cancel_task',
      description:
        '取消一个旧任务的未完成执行。普通成员仅可取消自己发起的任务，管理员可取消本会话其他任务。已入队结果继续发送；已完成返回结果。',
      parameters: { taskId: { type: 'string', required: true } },
      output,
      execute: (args, exec) => call('cancel', args.taskId, exec),
    })
  );
  if (fast) {
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.restrict({ allow: ['query_tasks', 'cancel_task'] });
    });
    // guard 覆盖 PTC 保留入口与局部工具；仅隐藏发现列表不足以阻止直接执行。
    ctx.tools.guard((exec) =>
      ['query_tasks', 'cancel_task'].includes(exec.name)
        ? undefined
        : '快 lane 仅允许查询与取消任务'
    );
  }
}
