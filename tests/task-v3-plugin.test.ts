import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import { installRoleTools } from '../dsh-profile/plugins/task-control-v3.js';

class ControlAdapter extends LlmAdapter {
  calls: GenerateOptions[] = [];
  constructor(private readonly tools: { name: string; args?: object }[]) {
    super();
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    for (const [index, tool] of this.tools.entries()) {
      const block = {
        type: 'tool-call' as const,
        id: ToolCallId(`${this.calls.length}-${index}`),
        name: tool.name,
        arguments: JSON.stringify(tool.args ?? {}),
      };
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield { type: 'block-end', index, block };
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}

async function harness(role: string, tools: { name: string; args?: object }[]) {
  const ctx = new Context();
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new ControlAdapter(tools);
  ctx.llm.registerAdapter(['offline'], adapter);
  const business = vi.fn(async () => ({ written: true }));
  ctx.tools.register(
    defineTool({
      name: 'bash',
      description: 'offline business tool',
      parameters: {},
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'written' }] },
      execute: business,
    })
  );
  const actions: string[] = [];
  installRoleTools(
    ctx,
    async (action: string) => {
      actions.push(action);
      return { ok: true, value: action === 'query' ? [] : { workerId: 'worker' } };
    },
    role,
    3
  );
  const handle = await ctx.agents.create({
    sessionId: SessionId('offline'),
    agentOptions: { provider: 'offline', model: 'offline' },
  });
  return {
    ctx,
    handle,
    adapter,
    business,
    actions,
    async run() {
      handle.agent.followup({
        id: MessageId('input'),
        role: 'user',
        content: [{ type: 'text', text: 'test' }],
        source: { kind: 'user' },
      });
      await handle.agent.whenIdle();
    },
    async close() {
      await handle.dispose();
      await ctx.fiber.dispose();
    },
  };
}

describe('V3 插件使用安装版 DSH 公共执行接口', () => {
  it('同step控制调用顺序执行，接受派发后停止剩余工具和模型循环', async () => {
    const h = await harness('frontend', [
      { name: 'query_tasks' },
      { name: 'cancel_task', args: { taskId: 'old' } },
      { name: 'start_worker', args: { instruction: '完成工作', deliverables: ['结果'] } },
      { name: 'query_tasks' },
      { name: 'bash' },
    ]);
    try {
      await h.run();
      expect(h.actions).toEqual(['query', 'cancel', 'start-worker']);
      expect(h.adapter.calls).toHaveLength(1);
      expect(h.business).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it('前台只展示控制工具且最多运行三个step', async () => {
    const h = await harness('frontend', [{ name: 'query_tasks' }]);
    try {
      await h.run();
      expect(h.adapter.calls).toHaveLength(3);
      expect(h.adapter.calls[0]?.tools?.map((tool) => tool.name).sort()).toEqual([
        'cancel_task',
        'query_tasks',
        'start_worker',
      ]);
      const denied = await h.handle.agent.ctx.tools.execute({
        name: 'bash',
        callId: ToolCallId('business'),
        arguments: {},
        agent: h.handle.agent,
        signal: new AbortController().signal,
      });
      expect(denied.isError).toBe(true);
      expect(h.business).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it('整理不展示或执行工具，只运行一个step', async () => {
    const h = await harness('summary', [{ name: 'bash' }]);
    try {
      await h.run();
      expect(h.adapter.calls).toHaveLength(1);
      expect(h.adapter.calls[0]?.tools ?? []).toEqual([]);
      expect(h.business).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it('worker保留业务工具并拒绝前台控制调用', async () => {
    const h = await harness('worker', []);
    try {
      const result = await h.handle.agent.ctx.tools.execute({
        name: 'bash',
        callId: ToolCallId('business'),
        arguments: {},
        agent: h.handle.agent,
        signal: new AbortController().signal,
      });
      expect(result.isError).not.toBe(true);
      expect(h.business).toHaveBeenCalledOnce();
      for (const name of ['query_tasks', 'cancel_task', 'start_worker']) {
        const denied = await h.handle.agent.ctx.tools.execute({
          name,
          callId: ToolCallId(name),
          arguments: {},
          agent: h.handle.agent,
          signal: new AbortController().signal,
        });
        expect(denied.isError).toBe(true);
      }
      expect(h.actions).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
