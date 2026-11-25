import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebError } from '@deepseek-ai/dsh-web';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'qqbot-task-control-v3';
export const inject = ['tools', 'web'];
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
        if (frame.type === 'worker-budget') {
          this.onBudget?.(frame.update);
          continue;
        }
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
      const cancel = () => {
        if (process.env.QQBOT_ROLE === 'worker' && !this.socket.destroyed)
          this.socket.write(JSON.stringify({ type: 'worker-cancel', id }) + '\n');
      };
      const abort = () => {
        cancel();
        finish(new Error('控制请求已取消'));
      };
      const timer = setTimeout(
        () => {
          cancel();
          finish(new Error('控制回执超时'));
        },
        action === 'search'
          ? Number(process.env.QQBOT_WORKER_SERVICE_TIMEOUT_MS ?? 1_800_000)
          : 5000
      );
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
  if (role === 'summary') {
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
  const call = (action, arguments_, exec) => channel.call(action, arguments_, exec);
  const policy = installRoleTools(ctx, call, role);
  channel.onBudget = (update) => policy.receiveBudget(update);
  if (role === 'worker') installWorkerSearch(ctx, call, policy);
  ctx.on('dispose', () => {
    channel.close();
    socket.destroy();
  });
}

/** Restrictions are changed at step/end, before the next prompt is assembled. */
export function installRoleTools(
  ctx,
  call,
  role,
  maxSteps = Number(process.env.QQBOT_FRONTEND_MAX_STEPS ?? 5),
  workerMaxSteps = Number(process.env.QQBOT_WORKER_MAX_STEPS ?? 40)
) {
  const agents = new Map();
  const steps = new Map();
  const turns = new Map();
  const requests = new Map();
  const stepGrants = new Map();
  let dispatched = false;
  let finishReason;
  let rootId = process.env.QQBOT_ROOT_SESSION_ID;
  let workerSteps = 0;
  let searchDegraded = false;
  let fallbackFetches = 0;
  let finalRootStep;
  const finishing = new Set();
  const finishMessages = new Map();
  const allowed =
    role === 'frontend' ? ['query_tasks', 'read_task_result', 'cancel_task', 'start_worker'] : [];
  const injectFinish = (agent, reason) => {
    if (finishing.has(agent.session.id)) return;
    finishing.add(agent.session.id);
    agent.ctx.tools.restrict({ allow: [] });
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [
        {
          type: 'text',
          text: `执行预算已到（${reason}）。停止使用工具，直接整理现有结果、依据和未完成事项。`,
        },
      ],
      source: { kind: 'user' },
    };
    finishMessages.set(agent.session.id, message);
    agent.steer(message);
  };
  const restrictToKnownFetch = (agent) => {
    const allowed = agent.ctx.tools
      .schemas(agent)
      .filter((tool) => tool.name === 'web_fetch')
      .map((tool) => tool.name);
    agent.ctx.tools.restrict({ allow: allowed });
  };
  const degradeSearch = () => {
    if (searchDegraded) return;
    searchDegraded = true;
    for (const agent of agents.values()) restrictToKnownFetch(agent);
  };
  const finish = (reason) => {
    if (finishReason) return;
    finishReason = reason;
    for (const [id, agent] of agents) {
      if (id === rootId) injectFinish(agent, reason);
      else {
        agent.ctx.tools.restrict({ allow: [] });
        agent.cancel({ kind: 'hook', reason: '根任务开始收尾' });
      }
    }
  };
  if (role === 'frontend')
    registerControlTools(ctx, call, () => {
      dispatched = true;
    });
  ctx.on('agent/created', ({ agent }) => {
    if (!rootId) rootId = agent.session.id;
    agents.set(agent.session.id, agent);
    if (role !== 'worker') agent.ctx.tools.restrict({ allow: allowed });
    else if (searchDegraded) restrictToKnownFetch(agent);
    if (role === 'worker' && finishReason) {
      agent.ctx.tools.restrict({ allow: [] });
      if (agent.session.id !== rootId) agent.cancel({ kind: 'hook', reason: '业务阶段已结束' });
    }
  });
  ctx.on('agent/disposed', ({ agent }) => {
    agents.delete(agent.session.id);
    steps.delete(agent.session.id);
    turns.delete(agent.session.id);
    stepGrants.delete(agent.session.id);
    finishMessages.delete(agent.session.id);
    requests.delete(agent.session.id);
  });
  ctx.on('session/event', (session, event) => {
    if (!agents.has(session.id)) return;
    if (event.type === 'turn/start') {
      turns.set(session.id, event.data.turn);
      steps.set(session.id, 0);
    }
    if (event.type === 'step/start') {
      steps.set(session.id, event.data.step);
      if (role === 'worker' && !finishReason) workerSteps++;
    }
    if (event.type !== 'step/end') return;
    const agent = agents.get(session.id);
    if (role === 'frontend' && (requests.get(session.id) ?? 0) === maxSteps - 1)
      injectFinish(agent, '前台调用次数');
    if (role === 'worker' && workerSteps >= workerMaxSteps) finish('step-budget');
  });
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    const agent = context.scope;
    const id = agent?.session?.id;
    if (!agents.has(id)) return assembly;
    if (role === 'worker' && call) {
      const step = (steps.get(id) ?? 0) + 1;
      const turn = turns.get(id) ?? 1;
      const result = await call(
        'authorize-step',
        { step, turn },
        { agent, signal: context.signal }
      );
      stepGrants.set(id, { step, turn, result });
      if (result?.value?.kind === 'finish') finish('step-budget');
      if (!result?.ok || finishReason) return { ...assembly, tools: [] };
    }
    if (
      role === 'summary' ||
      finishing.has(id) ||
      (role === 'frontend' && (requests.get(id) ?? 0) >= maxSteps - 1)
    )
      return { ...assembly, tools: [] };
    return assembly;
  });
  ctx.on(
    'agent/request',
    async (payload, next) => {
      if (role === 'worker') return next();
      const id = payload.agent.session.id;
      const count = (requests.get(id) ?? 0) + 1;
      if (count > maxSteps) throw new Error('模型调用次数已达到本回合上限');
      requests.set(id, count);
      return next();
    },
    { prepend: true }
  );
  ctx.on(
    'agent/request-error',
    async (payload, next) => {
      if (role !== 'worker' && (requests.get(payload.agent.session.id) ?? 0) >= maxSteps) return;
      return next();
    },
    { prepend: true }
  );
  ctx.tools.guard((exec) => {
    if (role === 'worker') {
      if (['query_tasks', 'read_task_result', 'cancel_task', 'start_worker'].includes(exec.name))
        return 'worker 无前台控制能力';
      if (finishReason) return '业务阶段已结束，仅允许整理现有结果';
      return searchDegraded && exec.name !== 'web_fetch'
        ? '搜索服务失败，只允许读取已知来源或整理现有结果'
        : undefined;
    }
    if (dispatched) return '工作已经派发，当前前台执行已结束';
    if (
      finishing.has(exec.agent?.session.id) ||
      role === 'summary' ||
      (requests.get(exec.agent?.session.id) ?? 0) >= maxSteps
    )
      return '当前回合仅允许最终正文';
    return allowed.includes(exec.name) ? undefined : '当前前台仅允许已授权的控制工具';
  });
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (role !== 'worker' || exec.name !== 'web_fetch' || !call) return next();
    const result = await call('authorize-fetch', { url: exec.arguments.url }, exec);
    if (searchDegraded) {
      if (result?.ok) fallbackFetches++;
      else finish('搜索服务失败，已知来源读取已结束');
    }
    return result?.ok ? next() : { kind: 'deny', reason: '该链接未获准读取' };
  });
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next();
    if (role === 'worker' && searchDegraded && exec.name === 'web_fetch' && fallbackFetches >= 3)
      finish('搜索服务失败，已读取3次已知来源');
    return decision;
  });
  ctx.on('agent/pre-step', async (payload, next) => {
    if (role !== 'worker') {
      if (dispatched || payload.step > (role === 'summary' ? 1 : maxSteps))
        return { kind: 'reject' };
      return next();
    }
    if (!call) return next();
    if (finishReason && payload.agent.session.id !== rootId) return { kind: 'reject' };
    const grant = stepGrants.get(payload.agent.session.id);
    stepGrants.delete(payload.agent.session.id);
    if (grant?.step !== payload.step || grant.turn !== payload.turn) return { kind: 'reject' };
    const result = grant.result;
    if (!result?.ok) return { kind: 'reject' };
    if (result.value?.kind === 'finish' || finishReason) {
      finish('step-budget');
      const position = `${payload.turn}:${payload.step}`;
      if (finalRootStep && finalRootStep !== position) return { kind: 'reject' };
      finalRootStep = position;
      await Promise.all(
        [...agents].filter(([id]) => id !== rootId).map(([, agent]) => agent.whenIdle())
      );
    }
    const decision = await next();
    const message = finishMessages.get(payload.agent.session.id);
    if (
      message &&
      decision.kind === 'enter' &&
      !decision.messages.some((entry) => entry.id === message.id)
    ) {
      payload.agent.inbox.remove(message.id);
      return { ...decision, messages: [...decision.messages, { ...message, id: randomUUID() }] };
    }
    return decision;
  });
  return {
    receiveBudget(update) {
      if (
        role === 'worker' &&
        update.kind === 'finish' &&
        update.sessionId === rootId &&
        update.executionId === process.env.QQBOT_EXECUTION_ID &&
        update.runtimeGeneration === process.env.QQBOT_RUNTIME_GENERATION
      )
        finish(update.reason);
    },
    finish,
    degradeSearch,
    get finishing() {
      return !!finishReason;
    },
  };
}

/** The provider only forwards to the parent-owned HTTP search service. */
export function installWorkerSearch(ctx, call, policy) {
  let disabled;
  return ctx.web.registerSearchProvider({
    id: 'qqbot-parent-search',
    available: () => true,
    async search(request, signal) {
      if (disabled)
        throw new WebError('搜索服务暂不可用，仅可读取已知来源链接', 'WEB_PROVIDER_ERROR');
      const agent = ctx.agents.currentInitiator();
      if (!agent) throw new WebError('搜索缺少执行身份', 'WEB_ABORTED');
      const result = await call('search', { request }, { agent, signal });
      if (result?.ok) return result.value;
      if (result?.error?.cause?.kind === 'quota-exhausted') policy.finish('quota-exhausted');
      else {
        disabled = true;
        policy.degradeSearch();
      }
      throw new WebError(result?.error?.cause?.message ?? '搜索服务暂不可用', 'WEB_PROVIDER_ERROR');
    },
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
      description:
        '查询本会话任务的摘要及投递状态，默认8条、最多20条；完整正文用read_task_result分段读取。',
      parameters: { taskId: { type: 'string' }, limit: { type: 'number' } },
      output,
      execute: (args, exec) => call('query-summary', { query: args }, exec),
    })
  );
  ctx.tools.register(
    defineTool({
      name: 'read_task_result',
      description: '按摘要中的版本读取保存正文；响应nextOffset可继续读取，同会话同代次。',
      parameters: {
        taskId: { type: 'string', required: true },
        resultVersion: { type: 'number', required: true },
        source: { type: 'string', enum: ['worker', 'reply'], required: true },
        offset: { type: 'number' },
      },
      output,
      execute: (args, exec) => call('read-result', { resultRequest: args }, exec),
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
        deliveryIntent: { type: 'string', enum: ['chat', 'text-document'] },
        retryOf: { type: 'string' },
        requiredCapabilities: { type: 'array', items: { type: 'string', enum: ['web-search'] } },
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
