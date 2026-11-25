import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Web from '@deepseek-ai/dsh-web';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import { installRoleTools, installWorkerSearch } from '../dsh-profile/plugins/task-control-v3.js';

class ControlAdapter extends LlmAdapter {
  calls: GenerateOptions[] = [];
  constructor(
    private readonly scenario: { tools: { name: string; args?: object }[]; failures?: number }
  ) {
    super();
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    if (this.calls.length <= (this.scenario.failures ?? 0)) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'NETWORK_ERROR', message: 'temporary failure' } },
      };
      return;
    }
    if (!options.tools?.length) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '现有结果已整理。' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    for (const [index, tool] of this.scenario.tools.entries()) {
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

async function harness(
  role: string,
  tools: { name: string; args?: object }[],
  execution?: {
    authorize?: (args: { step: number; turn: number }) => unknown;
    maxSteps?: number;
    failures?: number;
  }
) {
  const ctx = new Context();
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new ControlAdapter({ tools, failures: execution?.failures });
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
  const endings: string[] = [];
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') endings.push(event.data.reason.kind);
  });
  const policy = installRoleTools(
    ctx,
    async (action: string, args: { step: number; turn: number }) => {
      actions.push(action);
      if (action === 'authorize-step')
        return execution?.authorize
          ? execution.authorize(args)
          : { ok: true, value: { kind: 'execute' } };
      if (action === 'query-summary') return { ok: true, value: [] };
      return { ok: true, value: { workerId: 'worker' } };
    },
    role,
    execution?.maxSteps ?? 5
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
    endings,
    policy,
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
      expect(h.actions).toEqual(['query-summary', 'cancel', 'start-worker']);
      expect(h.adapter.calls).toHaveLength(1);
      expect(h.business).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it('前台最后一次调用提前隐藏工具并禁止直接执行', async () => {
    const h = await harness('frontend', [{ name: 'query_tasks' }]);
    try {
      await h.run();
      expect(h.adapter.calls).toHaveLength(5);
      expect(h.adapter.calls[4]?.tools ?? []).toEqual([]);
      expect(h.endings).toEqual(['completed']);
      expect(h.actions).toHaveLength(4);
      expect(h.adapter.calls[0]?.tools?.map((tool) => tool.name).sort()).toEqual([
        'cancel_task',
        'query_tasks',
        'read_task_result',
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

  it('前台瞬时重试计入5次预算，第5正常请求无工具，连续失败第5次终止', async () => {
    for (const failures of [2, 10]) {
      const h = await harness('frontend', [{ name: 'query_tasks' }], { failures });
      const recover = vi.fn(async () => ({ kind: 'retry' as const }));
      h.ctx.on('agent/request-error', recover);
      try {
        await h.run();
        expect(h.adapter.calls).toHaveLength(5);
        expect(recover).toHaveBeenCalledTimes(failures === 2 ? 2 : 4);
        if (failures === 2) {
          expect(h.adapter.calls[4]?.tools ?? []).toEqual([]);
          expect(h.actions).toHaveLength(2);
          expect(h.endings).toEqual(['completed']);
        } else expect(h.endings).toEqual(['error']);
      } finally {
        await h.close();
      }
    }
  });

  it('前台预算只有1次时首个请求没有工具', async () => {
    const h = await harness('frontend', [{ name: 'query_tasks' }], { maxSteps: 1 });
    try {
      await h.run();
      expect(h.adapter.calls).toHaveLength(1);
      expect(h.adapter.calls[0]?.tools ?? []).toEqual([]);
      expect(h.actions).toEqual([]);
      expect(h.endings).toEqual(['completed']);
    } finally {
      await h.close();
    }
  });

  it('worker使用40次业务调用后根第41次无工具整理并正常结束', async () => {
    const h = await harness('worker', [{ name: 'bash' }]);
    try {
      await h.run();
      expect(h.adapter.calls).toHaveLength(41);
      expect(h.business).toHaveBeenCalledTimes(40);
      expect(h.adapter.calls[40]?.tools ?? []).toEqual([]);
      expect(h.endings).toEqual(['completed']);
    } finally {
      await h.close();
    }
  });

  it('父预算在组装期间到达时当前请求无工具且包含收尾要求，只多调用根一次', async () => {
    const h = await harness('worker', [{ name: 'bash' }], {
      authorize: (args) => ({ ok: true, value: { kind: args.step >= 3 ? 'finish' : 'execute' } }),
    });
    try {
      await h.run();
      expect(h.business).toHaveBeenCalledTimes(2);
      expect(h.adapter.calls).toHaveLength(3);
      expect(h.adapter.calls[2]?.tools ?? []).toEqual([]);
      expect(JSON.stringify(h.adapter.calls[2]?.messages)).toContain('执行预算已到');
      expect(h.endings).toEqual(['completed']);
    } finally {
      await h.close();
    }
  });

  it('搜索代理收到额度耗尽后通过公开guard拒绝bash替代请求', async () => {
    const h = await harness('worker', []);
    await h.ctx.plugin(Web);
    const call = vi.fn(async () => ({
      ok: false,
      error: {
        code: 'UPSTREAM_FAILED',
        retry: 'after-change',
        cause: { kind: 'quota-exhausted', message: '月度搜索额度已耗尽' },
      },
    }));
    const unregister = installWorkerSearch(h.ctx, call, h.policy);
    try {
      await expect(
        h.ctx.agents.withInitiator(h.handle.agent, () =>
          h.ctx.web.search({ query: '资料' }, new AbortController().signal)
        )
      ).rejects.toThrow('月度搜索额度已耗尽');
      const denied = await h.handle.agent.ctx.tools.execute({
        name: 'bash',
        callId: ToolCallId('quota-bypass'),
        arguments: {},
        agent: h.handle.agent,
        signal: new AbortController().signal,
      });
      expect(denied.isError).toBe(true);
      expect(h.business).not.toHaveBeenCalled();
      expect(call).toHaveBeenCalledOnce();
    } finally {
      unregister();
      await h.close();
    }
  });

  it('普通搜索故障后公开guard只允许3次web_fetch，禁止bash并自动收尾', async () => {
    const h = await harness('worker', []);
    await h.ctx.plugin(Web);
    const fetched = vi.fn(async () => ({ text: '已知来源' }));
    h.ctx.tools.register(
      defineTool({
        name: 'web_fetch',
        description: '离线读取',
        parameters: { url: { type: 'string', required: true } },
        output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '已知来源' }] },
        execute: fetched,
      })
    );
    const call = vi.fn(async () => ({
      ok: false,
      error: { cause: { kind: 'service-error', message: 'temporary outage' } },
    }));
    const unregister = installWorkerSearch(h.ctx, call, h.policy);
    try {
      await expect(
        h.ctx.agents.withInitiator(h.handle.agent, () =>
          h.ctx.web.search({ query: '资料' }, new AbortController().signal)
        )
      ).rejects.toThrow('temporary outage');
      expect(h.handle.agent.ctx.tools.schemas(h.handle.agent).map((tool) => tool.name)).toEqual([
        'web_fetch',
      ]);
      const denied = await h.handle.agent.ctx.tools.execute({
        name: 'bash',
        callId: ToolCallId('ordinary-bypass'),
        arguments: {},
        agent: h.handle.agent,
        signal: new AbortController().signal,
      });
      expect(denied.isError).toBe(true);
      expect(h.business).not.toHaveBeenCalled();
      for (let i = 0; i < 3; i++) {
        const result = await h.handle.agent.ctx.tools.execute({
          name: 'web_fetch',
          callId: ToolCallId(`source-${i}`),
          arguments: { url: 'https://known.example/a' },
          agent: h.handle.agent,
          signal: new AbortController().signal,
        });
        expect(result.isError).toBe(false);
      }
      expect(fetched).toHaveBeenCalledTimes(3);
      expect(h.policy.finishing).toBe(true);
      expect(h.handle.agent.ctx.tools.schemas(h.handle.agent)).toEqual([]);
    } finally {
      unregister();
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
