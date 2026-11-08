import { describe, expect, it } from 'vitest';
import { runCase, judgeExecutionEvidence } from './bench/session/runner.js';
import { liveContextCases } from './bench/session/live-context-cases.js';
import { Harness, until } from './bench/session/harness.js';
import type { BenchmarkOptions } from './bench/session/types.js';
import { DIMENSIONS, parseVerdict } from './bench/session/judge.js';
import { gate } from './bench/session/report.js';

const receipt = '12345678-1234-4234-8234-123456789abc';
const options: BenchmarkOptions = {
  mode: 'offline',
  cases: [],
  seed: 42,
  full: false,
  strict: true,
  output: 'tmp/live-context-flow',
};

/** Exercise the live scenario orchestration with protocol replies only in this offline test. */
function protocolDriver(
  h: Harness,
  resultReceipt = receipt,
  toolCalls = 1,
  silentFollowUp = false
) {
  h.runtimeSetup = (runtime) => {
    const prompt = runtime.prompt.bind(runtime);
    runtime.prompt = async (sessionId, blocks) => {
      const result = await prompt(sessionId, blocks);
      const taskId = runtime.options.env!.QQBOT_TASK_ID!;
      const lane = runtime.options.env!.QQBOT_LANE!;
      const task = h.task(taskId);
      if (task.input.progressOnly) {
        runtime.event('tool/call', { name: 'query_tasks' });
        runtime.options.taskControl!({ action: 'query', taskId: task.input.followUpOf, sessionId });
        runtime.finish('执行完成，投递状态未确认。');
      } else if (lane === 'fast') runtime.finish('我来核对。');
      else if (silentFollowUp && task.input.followUpOf) runtime.finish('NO_REPLY');
      else {
        h.clock.advance(1);
        if (!task.input.followUpOf) {
          for (let index = 0; index < toolCalls; index++) {
            runtime.event('tool/call', { name: 'bash', arguments: 'PRIVATE_TOOL_ARGUMENTS' });
            runtime.event('tool/result', {
              message: {
                content: [
                  {
                    type: 'tool-result',
                    content: [{ type: 'text', text: `receipt=${resultReceipt}` }],
                  },
                ],
              },
            });
          }
        }
        runtime.finish(`receipt=${receipt}`);
      }
      return result;
    };
  };
}
describe('真实任务衔接场景的离线流程验证', () => {
  it.each(liveContextCases)('$id 闸门、查询和投递故障证据可复现', async (scenario) => {
    const record = await runCase(
      {
        ...scenario,
        run: async (h) => {
          protocolDriver(h);
          await scenario.run(h);
        },
      },
      options
    );
    expect(record.assertions.filter((assertion) => assertion.status !== 'pass')).toEqual([]);
    expect(Object.values(record.resources).every((value) => value === 0)).toBe(true);
    expect(JSON.stringify(record)).not.toContain('PRIVATE_TOOL_ARGUMENTS');
    if (scenario.id === 'LC01') {
      const view = record.executions.find((execution) => execution.contextView)?.contextView;
      expect(view?.tasks[0]?.lanes.slow.text).toContain(receipt);
    } else {
      expect(record.deliveryEvidence).toHaveLength(1);
      expect(record.deliveryEvidence![0]).toMatchObject({
        status: 'completed',
        delivery: scenario.id === 'LC02' ? 'pending' : 'failed',
      });
      const execution = record.executions.find((entry) => entry.taskQueries?.length)!;
      const before = JSON.stringify(execution);
      const facts = judgeExecutionEvidence(execution);
      expect(facts.taskQueries?.[0]).toMatchObject({
        taskId: execution.taskQueries![0]!.taskId,
        at: execution.taskQueries![0]!.at,
        result: [
          { status: 'completed', lanes: { slow: { result: { text: `receipt=${receipt}` } } } },
        ],
      });
      expect(JSON.stringify(facts)).not.toContain('traceId');
      expect(JSON.stringify(facts)).not.toContain('modelFinalText');
      expect(JSON.stringify(execution)).toBe(before);
    }
  });
  it.each([
    ['缺少工具编号', '', 1],
    ['正文与工具编号不一致', '87654321-1234-4234-8234-123456789abc', 1],
    ['重复生成', receipt, 2],
  ])('%s 不能提供原结果证据', async (_name, resultReceipt, toolCalls) => {
    const scenario = liveContextCases[0]!;
    const record = await runCase(
      {
        ...scenario,
        run: async (h) => {
          protocolDriver(h, resultReceipt, toolCalls);
          await scenario.run(h);
        },
      },
      options
    );
    expect(
      record.assertions.find((assertion) => assertion.name === 'original-tool-result')
    ).toMatchObject({ status: 'fail' });
    expect(Object.values(record.resources).every((value) => value === 0)).toBe(true);
  });
  it('旧结果已送达但当前追问只有承接语，裁判 pass 不能覆盖复述缺失', async () => {
    const scenario = liveContextCases[0]!;
    const record = await runCase(
      {
        ...scenario,
        run: async (h) => {
          protocolDriver(h, receipt, 1, true);
          await scenario.run(h);
        },
      },
      options
    );
    expect(
      record.assertions.find((assertion) => assertion.name === 'dispatched-view-has-new-result')
    ).toMatchObject({ status: 'pass' });
    expect(
      record.assertions.find((assertion) => assertion.name === 'existing-uuid-reused')
    ).toMatchObject({ status: 'fail' });
    record.mode = 'live';
    record.judge = parseVerdict(
      JSON.stringify({
        dimensions: Object.fromEntries(
          DIMENSIONS.map((name) => [
            name,
            {
              status: 'pass',
              severity: 'none',
              reason: '模拟裁判通过',
              quotes: [],
            },
          ])
        ),
      }),
      record.actions
    );
    expect(record.judge.status).toBe('pass');
    expect(gate({ records: [record], errors: [], options })).toBe(false);
    expect(Object.values(record.resources).every((value) => value === 0)).toBe(true);
  });
  it('实际派发前不记录 prompt 证据，关闭会释放观察者', async () => {
    const h = await Harness.create();
    try {
      const gate = h.defer();
      h.beforeRuntimePrompt = () => gate.promise;
      const a = await h.submit({ text: '检查闸门' });
      await until(() => h.runtimes.length === 2 && h.runtimes.every((runtime) => runtime.isReady));
      expect(h.evidence.executions.every((execution) => execution.promptAt === undefined)).toBe(
        true
      );
      gate.resolve();
      const runtime = await h.runtime(a.taskId, 'slow');
      await until(() =>
        h.evidence.executions.every((execution) => execution.promptAt !== undefined)
      );
      expect(runtime.prompts).toHaveLength(1);
      await h.close();
      expect(h.evidence.activeObservers).toBe(0);
    } finally {
      await h.close();
      await h.remove();
    }
  });
});
