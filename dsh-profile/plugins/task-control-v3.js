import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'qqbot-task-control-v3';
export const inject = ['tools'];
const MAX_FRAME_BYTES = 65536;
const MAX_PENDING_REQUESTS = 32;

/** Pending calls belong to this fd and settle on response, abort, timeout or close. */
class TaskControlChannel {
  pending = new Map();
  buffer = '';
  constructor(socket, binding) {
    this.socket = socket;
    this.binding = binding;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }
  receive(chunk) {
    this.buffer += chunk;
    let at;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        this.socket.destroy(new Error('控制回执超出容量'));
        return;
      }
      try {
        const frame = JSON.parse(line);
        const pending = this.pending.get(frame.id);
        if (!pending) continue;
        if (frame.error) pending.reject(new Error('控制请求失败'));
        else pending.resolve(frame.value);
      } catch {
        this.socket.destroy(new Error('控制回执格式错误'));
        return;
      }
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES)
      this.socket.destroy(new Error('控制回执超出容量'));
  }
  call(action, arguments_, exec) {
    return new Promise((resolve, reject) => {
      if (exec.signal?.aborted || this.socket.destroyed) {
        reject(new Error('控制请求已取消'));
        return;
      }
      if (this.pending.size >= MAX_PENDING_REQUESTS) {
        reject(new Error('控制请求队列超出容量'));
        return;
      }
      const id = randomUUID();
      const line =
        JSON.stringify({
          id,
          ...this.binding,
          action,
          ...arguments_,
          sessionId: exec.agent?.session.id,
        }) + '\n';
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        reject(new Error('派发内容超出控制通道容量'));
        return;
      }
      const finish = (error, value) => {
        clearTimeout(timer);
        this.pending.delete(id);
        exec.signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => finish(new Error('控制请求已取消'));
      const timer = setTimeout(() => finish(new Error('控制回执超时')), 5000);
      this.pending.set(id, {
        resolve: (value) => finish(undefined, value),
        reject: (error) => finish(error),
      });
      exec.signal?.addEventListener('abort', abort, { once: true });
      this.socket.write(line, (error) => {
        if (error) finish(error);
      });
    });
  }
  close() {
    for (const pending of this.pending.values()) pending.reject(new Error('控制通道关闭'));
    this.pending.clear();
  }
}

export function apply(ctx) {
  const role = process.env.QQBOT_ROLE;
  if (!['frontend', 'worker', 'summary'].includes(role)) return;
  if (role !== 'frontend') {
    installRoleTools(ctx, undefined, role);
    return;
  }
  const socket = new Socket({ fd: 3, readable: true, writable: true });
  const channel = new TaskControlChannel(socket, {
    executionId: process.env.QQBOT_EXECUTION_ID,
    runtimeGeneration: process.env.QQBOT_RUNTIME_GENERATION,
    taskId: process.env.QQBOT_TASK_ID,
    sessionId: process.env.QQBOT_ROOT_SESSION_ID,
  });
  installRoleTools(ctx, (action, arguments_, exec) => channel.call(action, arguments_, exec), role);
  ctx.on('dispose', () => {
    channel.close();
    socket.destroy();
  });
}

/** Restriction controls discovery; guard also covers direct calls and local tools. */
export function installRoleTools(
  ctx,
  call,
  role,
  maxSteps = Number(process.env.QQBOT_FRONTEND_MAX_STEPS ?? 3)
) {
  let dispatched = false;
  const allowed = role === 'frontend' ? ['query_tasks', 'cancel_task', 'start_worker'] : [];
  if (role === 'frontend')
    registerControlTools(ctx, call, (receipt) => {
      dispatched = receipt;
    });
  ctx.on('agent/created', ({ agent }) => {
    if (role !== 'worker') agent.ctx.tools.restrict({ allow: allowed });
  });
  ctx.tools.guard((exec) => {
    if (role === 'worker')
      return ['query_tasks', 'cancel_task', 'start_worker'].includes(exec.name)
        ? 'worker 无前台控制能力'
        : undefined;
    if (dispatched) return '工作已经派发，当前前台执行已结束';
    return allowed.includes(exec.name) ? undefined : '当前前台仅允许已授权的控制工具';
  });
  ctx.on('agent/pre-step', (payload, next) => {
    if (role === 'worker') return next();
    if (dispatched || payload.step > (role === 'summary' ? 1 : maxSteps))
      return Promise.resolve({ kind: 'reject' });
    return next();
  });
}

function registerControlTools(ctx, call, onDispatch) {
  const output = {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  };
  ctx.tools.register(
    defineTool({
      name: 'query_tasks',
      description: '查询本会话任务的执行、整理、完整结果和投递状态；省略 taskId 列出任务。',
      parameters: { taskId: { type: 'string' } },
      output,
      execute: (args, exec) => call('query', { taskId: args.taskId }, exec),
    })
  );
  ctx.tools.register(
    defineTool({
      name: 'cancel_task',
      description: '取消旧任务的未完成执行；已入队消息继续投递。普通成员只能取消自己发起的旧任务。',
      parameters: { taskId: { type: 'string', required: true } },
      output,
      execute: (args, exec) => call('cancel', { taskId: args.taskId }, exec),
    })
  );
  ctx.tools.register(
    defineTool({
      name: 'start_worker',
      description:
        '派发本次任务的业务执行。保存成功后当前前台立即结束，每个任务最多一个worker。工具默认顺序执行。',
      parameters: {
        instruction: { type: 'string', required: true },
        deliverables: { type: 'array', items: { type: 'string' }, required: true },
        acknowledgement: { type: 'string' },
      },
      output,
      execute: async (args, exec) => {
        const result = await call('start-worker', { assignment: args }, exec);
        if (result?.ok === true) {
          onDispatch(true);
          exec.agent.cancel({ kind: 'hook', reason: 'worker 请求已保存' });
        }
        return result;
      },
    })
  );
}
