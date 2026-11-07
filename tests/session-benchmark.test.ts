import { describe, it, expect, vi } from 'vitest';
import { offlineCases, mixedCases } from './bench/session/offline-cases.js';
import { liveCases, LIGHT_IDS } from './bench/session/live-cases.js';
import { runCase, selectCases, runBenchmark, requireReasoning } from './bench/session/runner.js';
import {
  CALIBRATION,
  parseVerdict,
  createJudge,
  calibrate,
  parseConfig,
  DIMENSIONS,
} from './bench/session/judge.js';
import { gate, percentile, sanitize, markdown } from './bench/session/report.js';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BenchmarkOptions, PlatformAction, BenchmarkCase } from './bench/session/types.js';
import { until } from './bench/session/harness.js';
import { RuntimeEvidence } from './bench/session/runtime-evidence.js';
import { BenchmarkRuntime } from './bench/session/mock-runtime.js';
import { createNullLogger } from '../src/observability/index.js';

const options: BenchmarkOptions = {
  mode: 'offline',
  cases: [],
  seed: 42,
  strict: false,
  full: false,
  output: 'tmp/session-benchmark-test',
};
describe('SessionActor benchmark离线验收', () => {
  it('场景异常时停止等待初始化并清理隔离目录，不能变成通过', async () => {
    let root = '';
    const c: BenchmarkCase = {
      id: 'failure',
      version: 1,
      group: 'failure',
      title: 'failure',
      steps: [],
      expectation: 'failure',
      run: async (h) => {
        root = h.root;
        const gate = h.defer();
        h.runtimeSetup = (r) => {
          r.startGate = gate.promise;
        };
        await h.submit({ text: 'pending-init' });
        await until(() => h.runtimes.length > 0);
        throw new Error('intentional-scenario-failure');
      },
    };
    const record = await runCase(c, options);
    expect(
      record.assertions.some((a) => a.name === 'scenario-completed' && a.status === 'fail')
    ).toBe(true);
    expect(Object.values(record.resources).every((n) => n === 0)).toBe(true);
    await expect(access(root)).rejects.toThrow();
  });
  it.each([...offlineCases, ...mixedCases])(
    '$id $title',
    async (c) => {
      const record = await runCase(c, options);
      expect(
        record.assertions.filter((a) => a.category === 'runtime' && a.status !== 'pass')
      ).toEqual([]);
      expect(Object.values(record.resources).every((n) => n === 0)).toBe(true);
      if (c.knownIssue) {
        expect(record.judge?.status).toBe('fail');
        expect(record.actions.filter((a) => a.status === 'received')).toHaveLength(2);
      }
    },
    30000
  );
  it('24个在线场景与默认12项轻量集不在npm test中执行', () => {
    expect(liveCases.map((c) => c.id)).toEqual(
      Array.from({ length: 24 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`)
    );
    expect(selectCases({ ...options, mode: 'live' }).map((c) => c.id)).toEqual(LIGHT_IDS);
    expect(() => selectCases({ ...options, cases: ['TYPO'] })).toThrow('unknown-case');
  });
});
const config = {
  endpoint: 'https://example.test/chat/completions',
  model: 'independent',
  apiKeyEnv: 'JUDGE_KEY',
  timeoutMs: 20,
};
function verdict(replies: PlatformAction[], dimension?: string): string {
  return JSON.stringify({
    dimensions: Object.fromEntries(
      DIMENSIONS.map((key) => [
        key,
        {
          status: key === dimension ? 'fail' : 'pass',
          severity: key === dimension ? 'severe' : 'none',
          reason: '标注样本',
          quotes: key === dimension ? replies.map((a) => a.text) : [],
        },
      ])
    ),
  });
}
describe('语义裁判与门禁', () => {
  it('思考只保存元数据与最终可见文本，重复和错属事件不能提供证据', async () => {
    const runtimeOptions = {
      cwd: '/isolated/task/slow',
      env: { QQBOT_LANE: 'slow' },
      logger: createNullLogger(),
      bin: 'mock',
      profilePatch: 'mock',
      provider: 'mock',
      model: 'mock',
      dshHome: '/isolated',
      startTimeoutMs: 1,
      shutdownTimeoutMs: 1,
    };
    const mock = new BenchmarkRuntime(runtimeOptions),
      evidence = new RuntimeEvidence();
    const runtime = evidence.attach(mock.asRuntime(), runtimeOptions, () => 1);
    await runtime.start();
    await runtime.prompt('parent', []);
    mock.event('reasoning', { text: 'PRIVATE_REASONING_BODY', usage: { reasoningTokens: 7 } });
    mock.event('reasoning', { text: 'DUPLICATE_PRIVATE_BODY', reasoningTokens: 100 }, 'parent', 0);
    mock.event('reasoning', { text: 'WRONG_PRIVATE_BODY', reasoningTokens: 100 }, 'foreign');
    mock.child(true, 'child');
    mock.emit('subagent.finished', {
      parentSessionId: 'foreign',
      childSessionId: 'child',
      status: 'error',
    });
    mock.child(false, 'child');
    mock.event('reasoning', { text: 'LATE_PRIVATE_BODY', reasoningTokens: 100 }, 'child');
    mock.finish('最终可见答案');
    await runtime.dispose();
    expect(evidence.reasoning[0]).toMatchObject({ appeared: true, tokens: 7, events: 1 });
    expect(evidence.executions[0]?.modelFinalText).toBe('最终可见答案');
    expect(evidence.executions[0]).toMatchObject({
      childrenStarted: 1,
      childrenFinished: 1,
      childFailures: 0,
    });
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE');
    expect(evidence.activeObservers).toBe(0);
    const pass = parseVerdict(verdict(CALIBRATION[2]!.replies), CALIBRATION[2]!.replies);
    expect(requireReasoning(pass, []).status).toBe('inconclusive');
  });
  it('显式live缺配置产生失败报告，离线验收不会调用模型', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-live-preflight-'));
    vi.stubEnv('BENCH_JUDGE_CONFIG', '');
    try {
      const report = await runBenchmark({ ...options, mode: 'live', output: root });
      expect(report.passed).toBe(false);
      expect(report.records).toHaveLength(0);
      expect(report.errors).toContain('missing-BENCH_JUDGE_CONFIG');
      expect(await readFile(join(root, 'report.json'), 'utf8')).toContain(
        'missing-BENCH_JUDGE_CONFIG'
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(CALIBRATION)('标注样本$id按原句解析', (sample) => {
    expect(parseVerdict(verdict(sample.replies, sample.dimension), sample.replies).status).toBe(
      sample.expected
    );
  });
  it('HTTP裁判校准识别坏样本并接受承接增量与解释修正', async () => {
    let calls = 0;
    const judge = createJudge(
      config,
      async (_url, init) => {
        expect(init?.body).toContain('duplication');
        const sample = CALIBRATION[calls++]!;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: verdict(sample.replies, sample.dimension) } }],
          })
        );
      },
      'mock-key'
    );
    expect((await calibrate(judge)).passed).toBe(true);
    expect(calls).toBe(6);
  });
  it('校准不匹配畸形输出缺引用缺交付不能通过', async () => {
    const sample = CALIBRATION[0]!;
    const judge = createJudge(
      config,
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: verdict(sample.replies) } }] })
        ),
      'mock-key'
    );
    expect((await calibrate(judge)).passed).toBe(false);
    expect(parseVerdict('not json', sample.replies)).toMatchObject({
      status: 'inconclusive',
      error: 'judge-invalid-json',
    });
    expect(parseVerdict(verdict([], 'duplication'), sample.replies).status).toBe('inconclusive');
    expect(parseVerdict(verdict(sample.replies), []).status).toBe('inconclusive');
    expect(
      parseVerdict(
        verdict([{ ...sample.replies[0]!, text: '不在实际输出中的句子' }], 'trust'),
        sample.replies
      )
    ).toMatchObject({ status: 'inconclusive', error: 'judge-evidence-unverifiable-quote' });
  });
  it('超时HTTP失败缺内容明确inconclusive且不重试', async () => {
    let calls = 0;
    const never = createJudge(
      config,
      async () => {
        calls++;
        return new Promise<Response>(() => {});
      },
      'mock-key'
    );
    expect((await never({}, CALIBRATION[0]!.replies)).status).toBe('inconclusive');
    expect(calls).toBe(1);
    const failed = createJudge(
      config,
      async () => new Response('failed', { status: 500 }),
      'mock-key'
    );
    expect((await failed({}, CALIBRATION[0]!.replies)).status).toBe('inconclusive');
    const empty = createJudge(config, async () => new Response('{}'), 'mock-key');
    expect((await empty({}, CALIBRATION[0]!.replies)).status).toBe('inconclusive');
  });
  it('独立裁判配置拒绝内联密钥与无效端点', () => {
    expect(() => parseConfig({ ...config, apiKey: 'inline' })).toThrow();
    expect(() =>
      parseConfig({ ...config, endpoint: 'https://example.test/?apiKey=secret' })
    ).toThrow();
    expect(() => createJudge(config, undefined, '')).toThrow('missing-judge');
  });
  it('基线记录已知问题严格模式拒绝，运行失败始终拒绝', async () => {
    const record = await runCase(
        offlineCases.find((c) => c.id === 'O02')!,
        options
      ),
      report = { records: [record], errors: [], options };
    expect(gate(report)).toBe(true);
    expect(gate({ ...report, options: { ...options, strict: true } })).toBe(false);
    record.assertions.push({
      name: 'capacity',
      category: 'runtime',
      status: 'fail',
      evidence: 129,
    });
    expect(gate(report)).toBe(false);
  });
  it('严格模式拒绝未完成，校准失败不放行', async () => {
    const record = await runCase(offlineCases[3]!, options);
    record.mode = 'live';
    const report = { records: [record], errors: [], options: { ...options, strict: true } };
    expect(gate(report)).toBe(false);
    expect(gate({ ...report, options, calibration: { passed: false, samples: [] } })).toBe(false);
  });
  it('重复样本全部保留报告可核对坏回复且排除凭证', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-report-'));
    try {
      const report = await runBenchmark({
        ...options,
        output: root,
        cases: ['O02', 'O03'],
        repeat: 2,
      });
      expect(report.records).toHaveLength(4);
      expect(report.records.every((r) => r.judge?.status === 'fail')).toBe(true);
      expect(await readFile(join(root, 'report.json'), 'utf8')).toContain('我无法解方程');
      expect(await readFile(join(root, 'report.md'), 'utf8')).toContain('substantive-duplication');
      expect(
        sanitize({ apiKey: 'private', text: 'arbitrary-secret' }, ['arbitrary-secret'])
      ).toEqual({ text: '[REDACTED]' });
      expect(markdown(report)).toContain('2/2');
      expect(percentile([1, 2, 3, 100], 0.95)).toBe(100);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
