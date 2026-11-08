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
import { gate, percentile, sanitize, markdown, writeReport } from './bench/session/report.js';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BenchmarkOptions,
  PlatformAction,
  BenchmarkCase,
  BenchmarkReport,
} from './bench/session/types.js';
import { Harness, until } from './bench/session/harness.js';
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
  it('27个在线场景与默认13项轻量集不在npm test中执行', () => {
    expect(liveCases.map((c) => c.id)).toEqual([
      ...Array.from({ length: 24 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`),
      'LC01',
      'LC02',
      'LC03',
    ]);
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
function verdict(
  replies: PlatformAction[],
  dimension?: string,
  dimensionStatus: 'fail' | 'inconclusive' = 'fail'
): string {
  return JSON.stringify({
    dimensions: Object.fromEntries(
      DIMENSIONS.map((key) => [
        key,
        {
          status: key === dimension ? dimensionStatus : 'pass',
          severity: key === dimension && dimensionStatus === 'fail' ? 'severe' : 'none',
          reason: '标注样本',
          quotes: key === dimension ? replies.map((a) => a.text) : [],
        },
      ])
    ),
  });
}
function calibrationVerdict(sample: (typeof CALIBRATION)[number]): string {
  return verdict(
    sample.replies,
    sample.dimension,
    sample.expected === 'inconclusive' ? 'inconclusive' : 'fail'
  );
}
function sseEvent(delta: object = {}, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\r\n\r\n`;
}
function sseVerdict(content: string): string {
  return (
    ': keep-alive\r\n\r\n' +
    sseEvent({ reasoning_content: 'PRIVATE_REASONING' }) +
    sseEvent({ content }) +
    sseEvent({}, 'stop') +
    'data: [DONE]\r\n\r\n'
  );
}
function streamResponse(chunks: Uint8Array[], close = true) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => {
        controller.enqueue(chunk);
      });
      if (close) controller.close();
    },
    cancel,
  });
  return {
    response: new Response(body, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    }),
    body,
    cancel,
  };
}
describe('裁判SSE传输', () => {
  const encoder = new TextEncoder();
  it('跨UTF-8字节与CRLF边界解析，忽略思考正文并释放完成流', async () => {
    const replies = CALIBRATION[2]!.replies;
    const content = verdict(replies);
    const bytes = encoder.encode(sseVerdict(content));
    const response = streamResponse(
      Array.from(bytes, (byte) => Uint8Array.of(byte)),
      false
    );
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        stream: true,
        response_format: { type: 'json_object' },
      });
      expect(init?.headers).toMatchObject({ Connection: 'close' });
      return response.response;
    });
    const result = await createJudge(
      { ...config, stream: true, timeoutMs: 1000 },
      fetchImpl,
      'mock-key'
    )({}, replies);
    expect(result).toEqual(parseVerdict(content, replies));
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(response.cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });
  it('14项校准保持原标签与严重度，流式传输不改变判定', async () => {
    let calls = 0;
    const judge = createJudge(
      { ...config, stream: true },
      async () => {
        const sample = CALIBRATION[calls++]!;
        return streamResponse([encoder.encode(sseVerdict(calibrationVerdict(sample)))]).response;
      },
      'mock-key'
    );
    const result = await calibrate(judge);
    expect(result.passed).toBe(true);
    expect(calls).toBe(14);
    expect(result.samples.map((sample) => sample.verdict.status)).toEqual(
      CALIBRATION.map((sample) => sample.expected)
    );
  });
  it.each([
    [
      '缺DONE',
      sseEvent({ content: verdict(CALIBRATION[2]!.replies) }, 'stop'),
      'judge-stream-incomplete',
    ],
    [
      '缺stop',
      sseEvent({ content: verdict(CALIBRATION[2]!.replies) }) + 'data: [DONE]\n\n',
      'judge-stream-incomplete',
    ],
    [
      '长度截断',
      sseEvent({ content: verdict(CALIBRATION[2]!.replies) }, 'length') + 'data: [DONE]\n\n',
      'judge-stream-incomplete',
    ],
    ['帧截断', 'data: {"choices":', 'judge-stream-incomplete'],
    ['畸形JSON', 'data: PRIVATE_INVALID_JSON\n\n', 'judge-response-invalid-json'],
    ['无对象', 'data: null\n\n', 'judge-stream-invalid-response'],
    ['无choices', 'data: {}\n\n', 'judge-stream-invalid-response'],
    ['无choice对象', 'data: {"choices":[null]}\n\n', 'judge-stream-invalid-response'],
    [
      '错误delta类型',
      'data: {"choices":[{"delta":"PRIVATE"}]}\n\n',
      'judge-stream-invalid-response',
    ],
    [
      '错误content类型',
      'data: {"choices":[{"delta":{"content":1}}]}\n\n',
      'judge-stream-invalid-response',
    ],
    [
      '错误结束类型',
      'data: {"choices":[{"finish_reason":1}]}\n\n',
      'judge-stream-invalid-response',
    ],
    ['可见正文畸形', sseVerdict('PRIVATE_INVALID_VERDICT'), 'judge-invalid-json'],
    ['帧缓冲超限', 'data: ' + 'x'.repeat(1000000), 'judge-response-too-large'],
    [
      '累计正文超限',
      sseEvent({ content: 'x'.repeat(500000) }) + sseEvent({ content: 'x'.repeat(500001) }),
      'judge-response-too-large',
    ],
  ])('%s不能通过、不重试且释放reader', async (_title, data, error) => {
    const completeResponse = streamResponse(
      data.split(/(?<=\r\n\r\n)/u).map((frame) => encoder.encode(frame)),
      ['缺DONE', '帧截断'].includes(_title)
    );
    const fetchImpl = vi.fn(async () => completeResponse.response);
    const result = await createJudge(
      { ...config, stream: true },
      fetchImpl,
      'mock-key'
    )({}, CALIBRATION[2]!.replies);
    expect(result).toMatchObject({ status: 'inconclusive', error });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(completeResponse.body.locked).toBe(false);
  });
  it.each([
    new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    new Response(null, { headers: { 'Content-Type': 'text/event-stream' } }),
    streamResponse([Uint8Array.of(0xff, 0x0a, 0x0a)]).response,
  ])('非SSE、缺body与错误UTF-8都明确未定', async (response) => {
    const result = await createJudge(
      { ...config, stream: true },
      async () => response,
      'mock-key'
    )({}, CALIBRATION[2]!.replies);
    expect(result).toMatchObject({
      status: 'inconclusive',
      error: 'judge-stream-invalid-response',
    });
    expect(response.body?.locked ?? false).toBe(false);
  });
  it('非SSE出口取消未读body，读流网络错误只保存代码并释放锁', async () => {
    const invalid = streamResponse([], false);
    invalid.response.headers.set('Content-Type', 'application/json');
    const invalidResult = await createJudge(
      { ...config, stream: true },
      async () => invalid.response,
      'mock-key'
    )({}, CALIBRATION[2]!.replies);
    expect(invalidResult.error).toBe('judge-stream-invalid-response');
    expect(invalid.cancel).toHaveBeenCalledOnce();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(
          Object.assign(new Error('PRIVATE_STREAM_MESSAGE'), { code: 'ECONNRESET' })
        );
      },
    });
    const response = new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    const result = await createJudge(
      { ...config, stream: true },
      async () => response,
      'mock-key'
    )({}, CALIBRATION[2]!.replies);
    expect(result).toMatchObject({ status: 'inconclusive', error: 'judge-network-ECONNRESET' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(body.locked).toBe(false);
  });
  it('超时取消挂起read、解除监听器并释放锁，不重试', async () => {
    const response = streamResponse([], false);
    let signal: AbortSignal | undefined;
    let removeListener: ReturnType<typeof vi.spyOn> | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      removeListener = vi.spyOn(signal!, 'removeEventListener');
      return response.response;
    });
    const result = await createJudge(
      { ...config, stream: true },
      fetchImpl,
      'mock-key'
    )({}, CALIBRATION[2]!.replies);
    expect(result).toMatchObject({ status: 'inconclusive', error: 'judge-timeout' });
    await expect.poll(() => response.body.locked).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(response.cancel).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each([
    [{ code: 'ECONNRESET' }, 'judge-network-ECONNRESET'],
    [{ code: 'UND_ERR_SOCKET' }, 'judge-network-UND_ERR_SOCKET'],
    [{ code: 'PRIVATE_CODE' }, 'judge-network-error'],
    [{ code: 1 }, 'judge-network-error'],
    [undefined, 'judge-network-error'],
  ])('网络原因仅保留白名单代码 $1', async (cause, error) => {
    const result = await createJudge(
      { ...config, stream: true },
      async () => {
        throw new Error('PRIVATE_ENDPOINT_AND_KEY', { cause });
      },
      'mock-key'
    )({}, CALIBRATION[2]!.replies);
    expect(result).toMatchObject({ status: 'inconclusive', error });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('stream可选但只能为boolean，关闭时保持原请求', async () => {
    expect(parseConfig({ ...config, stream: true }).stream).toBe(true);
    for (const stream of ['true', 1, null])
      expect(() => parseConfig({ ...config, stream })).toThrow('invalid-judge-config');
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('stream');
      expect(init?.headers).not.toHaveProperty('Connection');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: verdict(CALIBRATION[2]!.replies) } }] })
      );
    });
    expect(
      (
        await createJudge(
          { ...config, stream: false },
          fetchImpl,
          'mock-key'
        )({}, CALIBRATION[2]!.replies)
      ).status
    ).toBe('pass');
  });
});
describe('语义裁判与门禁', () => {
  it.each([
    { required: false, evidenceLane: undefined, expected: 'pass' },
    { required: true, evidenceLane: 'slow', expected: 'pass' },
    { required: true, evidenceLane: 'fast', expected: 'inconclusive' },
    { required: true, evidenceLane: undefined, expected: 'inconclusive' },
  ] as const)(
    '推理要求$required、证据$evidenceLane：快答完整且慢lane静默时门禁为$expected',
    async ({ required, evidenceLane, expected }) => {
      const create = Harness.create.bind(Harness);
      const factory = vi
        .spyOn(Harness, 'create')
        .mockImplementation((settings) => create({ ...settings, mode: 'offline' }));
      try {
        const c: BenchmarkCase = {
          id: 'reasoning-boundary',
          version: 1,
          group: 'reasoning',
          title: 'reasoning',
          steps: [{ text: '证明n(n+1)是偶数' }],
          expectation: '完整快答，慢lane核对后静默',
          reasoning: required,
          run: async (h) => {
            const t = (await h.input({ text: '证明n(n+1)是偶数' }))!;
            if (evidenceLane)
              (await h.runtime(t.taskId, evidenceLane)).event('reasoning', {
                usage: { reasoningTokens: 32 },
              });
            await h.finish(t, '连续整数必有一个偶数，因此乘积是偶数。');
          },
        };
        const judge = vi.fn(async (input: unknown, replies: PlatformAction[]) => {
          expect(input).toMatchObject({ reasoningRequired: required });
          return parseVerdict(verdict(replies), replies);
        });
        const record = await runCase(c, { ...options, mode: 'live' }, 1, undefined, judge);
        expect(judge).toHaveBeenCalledOnce();
        expect(record.reasoningRequired).toBe(required);
        expect(record.tasks[0]!.lanes.slow.result?.kind).toBe('silent');
        expect(record.judge?.status).toBe(expected);
        expect(gate({ records: [record], errors: [], options: { ...options, strict: true } })).toBe(
          expected === 'pass'
        );
      } finally {
        factory.mockRestore();
      }
    }
  );
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
    const receipt = '12345678-1234-4234-8234-123456789abc';
    const result = (isError = false) => ({
      message: {
        content: [
          {
            type: 'tool-result',
            isError,
            content: [
              { type: 'text', text: `PRIVATE_TOOL_OUTPUT traceId=${receipt} receipt=${receipt}` },
              { type: 'reasoning', text: `PRIVATE_TOOL_REASONING ${receipt}` },
            ],
          },
        ],
      },
    });
    mock.event('tool/result', result(), 'foreign');
    mock.event('tool/result', result());
    mock.event('tool/result', result(), 'parent', 0);
    mock.event('tool/result', result(true));
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
    mock.event('tool/result', result());
    expect(evidence.reasoning[0]).toMatchObject({ appeared: true, tokens: 7, events: 1 });
    expect(evidence.executions[0]?.modelFinalText).toBe('最终可见答案');
    expect(evidence.executions[0]).toMatchObject({
      childrenStarted: 1,
      childrenFinished: 1,
      childFailures: 0,
      toolErrors: 1,
      toolResultUuids: [receipt],
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
    expect(parseVerdict(calibrationVerdict(sample), sample.replies).status).toBe(sample.expected);
  });
  it('HTTP裁判校准识别坏样本并接受承接增量与解释修正', async () => {
    let calls = 0;
    const observed: string[] = [];
    const judge = createJudge(
      config,
      async (_url, init) => {
        expect(init?.body).toContain('duplication');
        expect(observed).toHaveLength(calls);
        const sample = CALIBRATION[calls++]!;
        const request = JSON.parse(String(init?.body));
        expect(JSON.parse(request.messages[1].content)).toMatchObject({
          reasoningRequired: sample.reasoningRequired === true,
          reasoning: sample.reasoning ?? [],
          deliveryEvidence: sample.deliveryEvidence ?? [],
        });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: calibrationVerdict(sample) } }],
          })
        );
      },
      'mock-key'
    );
    expect(
      (
        await calibrate(judge, async (sample) => {
          observed.push(sample.id);
          sample.verdict.status = 'inconclusive';
        })
      ).passed
    ).toBe(true);
    expect(calls).toBe(14);
    expect(observed).toEqual(CALIBRATION.map((sample) => sample.id));
  });
  it('校准中断保留已保存样本，部分校准不能通过门禁', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-calibration-progress-'));
    const report: BenchmarkReport = {
      version: 'session-benchmark-1',
      createdAt: new Date().toISOString(),
      options: { ...options, mode: 'live', strict: true, output: root },
      records: [],
      errors: [],
      passed: false,
      metrics: {},
      calibration: { passed: false, samples: [] },
    };
    let calls = 0;
    const judge = vi.fn(async () => {
      const sample = CALIBRATION[calls++]!;
      return parseVerdict(calibrationVerdict(sample), sample.replies);
    });
    try {
      await expect(
        calibrate(judge, async (sample) => {
          report.calibration!.samples.push(sample);
          await writeReport(report);
          if (report.calibration!.samples.length === 2) throw new Error('interrupted-calibration');
        })
      ).rejects.toThrow('interrupted-calibration');
      const saved = JSON.parse(
        await readFile(join(root, 'report.json'), 'utf8')
      ) as BenchmarkReport;
      expect(saved.calibration?.samples.map((sample) => sample.id)).toEqual([
        'duplicate',
        'denial',
      ]);
      expect(saved.passed).toBe(false);
      expect(saved.calibration?.passed).toBe(false);
      expect(gate(saved)).toBe(false);
      expect(judge).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    'reasoning-not-required',
    'silent-slow-reasoning',
    'missing-slow-reasoning',
    'false-completed-pending',
    'false-completed-sending',
    'false-completed-failed',
    'false-completed-unknown',
    'completed-awaiting-delivery',
  ])('推理与投递边界校准%s判错时拒绝通过', async (id) => {
    let calls = 0;
    const judge = createJudge(
      config,
      async () => {
        const sample = CALIBRATION[calls++]!;
        const wrongDimension = sample.expected === 'pass' ? 'trust' : undefined;
        const content =
          sample.id === id
            ? verdict(sample.replies, wrongDimension, 'inconclusive')
            : calibrationVerdict(sample);
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
      },
      'mock-key'
    );
    expect((await calibrate(judge)).passed).toBe(false);
  });
  it('预期缺证据的校准样本也不能把裁判请求失败或畸形输出算作正确判定', async () => {
    for (const malformed of [true, false]) {
      let calls = 0;
      const judge = createJudge(
        config,
        async () => {
          const sample = CALIBRATION[calls++]!;
          if (sample.id === 'missing-slow-reasoning')
            return malformed ? new Response('{}') : new Response('failed', { status: 500 });
          return new Response(
            JSON.stringify({ choices: [{ message: { content: calibrationVerdict(sample) } }] })
          );
        },
        'mock-key'
      );
      const result = await calibrate(judge);
      const missing = result.samples.find((sample) => sample.id === 'missing-slow-reasoning')!;
      expect(missing.verdict).toMatchObject({ status: 'inconclusive' });
      expect(missing.verdict.error).toBeDefined();
      expect(result.passed).toBe(false);
    }
  });
  it('已完成但未送达的虚假声明不能用minor严重度通过校准', async () => {
    let calls = 0;
    const judge = createJudge(
      config,
      async () => {
        const sample = CALIBRATION[calls++]!;
        const result = JSON.parse(calibrationVerdict(sample));
        if (sample.id.startsWith('false-completed-')) result.dimensions.trust.severity = 'minor';
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] })
        );
      },
      'mock-key'
    );
    expect((await calibrate(judge)).passed).toBe(false);
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
    expect(await never({}, CALIBRATION[0]!.replies)).toMatchObject({
      status: 'inconclusive',
      error: 'judge-timeout',
    });
    expect(calls).toBe(1);
    const failed = createJudge(
      config,
      async () => new Response('failed', { status: 500 }),
      'mock-key'
    );
    expect(await failed({}, CALIBRATION[0]!.replies)).toMatchObject({
      status: 'inconclusive',
      error: 'judge-http-500',
    });
    const empty = createJudge(config, async () => new Response('{}'), 'mock-key');
    expect((await empty({}, CALIBRATION[0]!.replies)).status).toBe('inconclusive');
  });
  it.each([
    ['judge-response-invalid-json', async () => new Response('not-json')],
    ['judge-response-too-large', async () => new Response('x'.repeat(1000001))],
    [
      'judge-network-error',
      async () => {
        throw new Error('PRIVATE_NETWORK_ENDPOINT_AND_KEY');
      },
    ],
  ])('裁判请求错误 %s 不保留敏感底层信息', async (error, fetchImpl) => {
    const judge = createJudge(config, fetchImpl, 'mock-key');
    const result = await judge({}, CALIBRATION[0]!.replies);
    expect(result).toMatchObject({ status: 'inconclusive', error });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
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
