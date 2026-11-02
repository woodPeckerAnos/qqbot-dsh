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
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      const response = JSON.parse(line);
      pending.get(response.id)?.resolve(response.value); pending.delete(response.id);
    }
  });
  const close = () => { for (const item of pending.values()) item.reject(new Error('Task 控制通道关闭')); pending.clear(); };
  socket.on('error', close); socket.on('close', close);
  // 每次请求拥有自己的超时与取消监听，成功、失败及通道关闭都走同一清理路径。
  const call = (action, taskId, exec) => new Promise((resolve, reject) => {
    if (exec.signal?.aborted || socket.destroyed) { reject(new Error('Task 控制已取消或关闭')); return; }
    const id = randomUUID();
    const cleanup = () => { clearTimeout(timer); pending.delete(id); exec.signal?.removeEventListener('abort', abort); };
    const failed = error => { cleanup(); reject(error); };
    const timer = setTimeout(() => failed(new Error('Task 控制超时')), 5000);
    const abort = () => failed(new Error('Task 控制已取消'));
    exec.signal?.addEventListener('abort', abort, { once: true });
    pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: failed });
    socket.write(JSON.stringify({ id, action, taskId, sessionId: exec.agent?.session?.id }) + '\n', error => { if (error) failed(error); });
  });
  installTaskTools(ctx, call, process.env.QQBOT_LANE === 'fast');
  ctx.on('dispose', () => { close(); socket.destroy(); });
}

export function installTaskTools(ctx, call, fast) {
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  ctx.tools.register(defineTool({ name: 'query_tasks', description: '查询本会话任务及其执行状态和结果。省略 taskId 列出任务。', parameters: { taskId: { type: 'string' } }, output,
    execute: async (args, exec) => ({ tasks: await call('query', args.taskId, exec) }) }));
  ctx.tools.register(defineTool({ name: 'cancel_task', description: '取消一个旧任务的未完成执行。普通成员仅可取消自己发起的任务，管理员可取消本会话其他任务。已入队结果继续发送；已完成返回结果。', parameters: { taskId: { type: 'string', required: true } }, output,
    execute: (args, exec) => call('cancel', args.taskId, exec) }));
  if (fast) {
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.restrict({ allow: ['query_tasks', 'cancel_task'] });
    });
    // guard 覆盖 PTC 保留入口与局部工具；仅隐藏发现列表不足以阻止直接执行。
    ctx.tools.guard(exec => ['query_tasks', 'cancel_task'].includes(exec.name) ? undefined : '快 lane 仅允许查询与取消任务');
  }
}
