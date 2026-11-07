import { describe, expect, it, vi } from 'vitest';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import {
  installTaskTools,
  installExecutionBindings,
  installLaneCooperation,
} from '../dsh-profile/plugins/task-control.js';

describe('DSH Task 管理工具契约', () => {
  it('绑定复用根 agent，取消等待根与子代理静止，旧解绑不得影响下一轮', async () => {
    const hooks = new Map<string, (event: unknown) => void>();
    let idle!: () => void;
    const stopped = new Promise<void>((resolve) => {
      idle = resolve;
    });
    const root = {
      session: { id: 'root' },
      status: 'idle',
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => {}),
    };
    const child = {
      session: { id: 'child' },
      status: 'running',
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => {
        await stopped;
        child.status = 'idle';
      }),
    };
    const bind = vi.fn(),
      unbind = vi.fn();
    const controller = installExecutionBindings(
      { on: (event: string, fn: (event: unknown) => void) => hooks.set(event, fn) },
      { bind, unbind }
    );
    const a = {
      taskId: 'a',
      executionId: 'e1',
      runtimeGeneration: 'g',
      sessionId: 'root',
      sessionEpoch: 1,
    };
    hooks.get('agent/created')!({ agent: root });
    await controller.handle({ action: 'bind', binding: a });
    hooks.get('agent/created')!({ agent: child });
    let acknowledged = false;
    const cancelling = controller.handle({ action: 'cancel', binding: a }).then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(root.cancel).toHaveBeenCalledWith({ kind: 'user' });
    expect(child.cancel).toHaveBeenCalled();
    idle();
    await cancelling;
    await controller.handle({ action: 'unbind', binding: a });
    const b = { ...a, taskId: 'b', executionId: 'e2' };
    await controller.handle({ action: 'bind', binding: b });
    await expect(controller.handle({ action: 'unbind', binding: a })).rejects.toThrow('旧执行');
    expect(bind).toHaveBeenLastCalledWith(b);
    await controller.handle({ action: 'unbind', binding: b });
  });
  it('每轮清空协作水位并复用已创建根，旧快照不能注入新轮', async () => {
    const hooks = new Map<string, (...args: unknown[]) => void>();
    const binding = {
      taskId: 'a',
      executionId: '1',
      runtimeGeneration: 'g',
      sessionId: 'root',
      sessionEpoch: 1,
    };
    const agent = { session: { id: 'root' }, inject: vi.fn() };
    const plugin = installLaneCooperation(
      { on: (event: string, fn: (...args: unknown[]) => void) => hooks.set(event, fn) },
      vi.fn(async () => undefined),
      binding
    );
    hooks.get('agent/created')!({ agent });
    const snapshot = {
      taskId: 'a',
      revision: 9,
      ready: true,
      fastStatus: 'completed',
      bodies: [],
      delivered: [],
    };
    plugin.receive({ binding: { ...binding }, snapshot });
    expect(agent.inject).not.toHaveBeenCalled();
    hooks.get('session/event')!(agent.session, {
      type: 'user/message',
      data: { id: 'prompt-a', source: { kind: 'user' } },
    });
    expect(agent.inject).toHaveBeenCalledTimes(1);
    plugin.receive({
      binding: { ...binding, sessionEpoch: 2 },
      snapshot: { ...snapshot, revision: 10 },
    });
    expect(agent.inject).toHaveBeenCalledTimes(1);
    plugin.reset();
    plugin.bind({ ...binding, taskId: 'b', executionId: '2' });
    plugin.receive({ binding: { ...binding, taskId: 'a', executionId: '1' }, snapshot });
    expect(agent.inject).toHaveBeenCalledTimes(1);
    plugin.receive({ binding, snapshot: { ...snapshot, taskId: 'b', revision: 1 } });
    expect(agent.inject).toHaveBeenCalledTimes(1);
    hooks.get('session/event')!(agent.session, {
      type: 'user/message',
      data: { id: 'prompt-b', source: { kind: 'user' } },
    });
    expect(agent.inject).toHaveBeenCalledTimes(2);
    plugin.close();
  });
  it('快 lane 隐藏业务工具且守卫拒绝执行，包括 PTC transport', async () => {
    const definitions = new Map<
      string,
      { name: string; execute: (args: unknown, execution: unknown) => Promise<unknown> }
    >();
    const business = vi.fn();
    for (const name of ['bash', 'web_search', 'subagent', 'skill', 'run_code'])
      definitions.set(name, { name, execute: business });
    let guard!: (execution: { name: string }) => string | undefined;
    let created!: (event: unknown) => void;
    const tools = {
      register: (definition: { name: string }) =>
        definitions.set(definition.name, definition as never),
      guard: (fn: typeof guard) => {
        guard = fn;
      },
    };
    const call = vi.fn(async (action) => (action === 'query' ? [] : { accepted: true }));
    installTaskTools(
      {
        tools,
        on: (_event: string, fn: typeof created) => {
          created = fn;
        },
      },
      call,
      true
    );
    const restrict = vi.fn();
    created({ agent: { ctx: { tools: { restrict } } } });
    expect(restrict).toHaveBeenCalledWith({ allow: ['query_tasks', 'cancel_task'] });
    for (const name of ['bash', 'web_search', 'subagent', 'skill', 'run_code']) {
      expect(guard({ name })).toContain('仅允许');
      if (!guard({ name })) await definitions.get(name)!.execute({}, {});
    }
    expect(business).not.toHaveBeenCalled();
    expect(guard({ name: 'cancel_task' })).toBeUndefined();
    const execution = {
      signal: new AbortController().signal,
      agent: { session: { id: 'bound-session' } },
    };
    await definitions.get('cancel_task')!.execute({ taskId: 'task-old' }, execution);
    expect(call).toHaveBeenCalledWith('cancel', 'task-old', execution);
    // The installed DSH version really supports both boundaries used by the plugin.
    expect(typeof ToolRuntime.prototype.guard).toBe('function');
    expect(typeof ToolRuntime.prototype.restrict).toBe('function');
  });
  it('慢 lane 保留完整工具面，不安装快 lane 限制', () => {
    const guard = vi.fn(),
      on = vi.fn(),
      register = vi.fn();
    installTaskTools({ tools: { guard, register }, on }, vi.fn(), false);
    expect(register).toHaveBeenCalledTimes(2);
    expect(guard).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  });
});
