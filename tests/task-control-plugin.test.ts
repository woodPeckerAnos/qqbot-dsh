import { describe, expect, it, vi } from 'vitest';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { installTaskTools } from '../dsh-profile/plugins/task-control.js';

describe('DSH Task 管理工具契约', () => {
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
