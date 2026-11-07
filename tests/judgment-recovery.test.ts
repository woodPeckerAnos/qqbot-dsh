import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  JudgmentResult,
  ProactiveJudgeInput,
  SceneVerdict,
  NormalizedMessage,
} from '@qqbot/contracts';
import { createLogger, createPipelineStats } from '../src/observability/index.js';
import {
  createChatClient,
  createDefaultProactiveJudge,
  createProactiveWatcher,
  DEFAULT_WATCHER_CONFIG,
  NULL_WATCHER_METRICS,
} from '../src/proactive/index.js';
import { createTopicJudgeResult, createTopicJudge } from '../src/ingress/index.js';
import { createObservationWindowStore } from '../src/store/index.js';
import { ManualClock } from './helpers/task-mocks.js';

afterEach(() => vi.useRealTimers());
const completion = (content = '{"verdicts":[{"scene":"scene-4","satisfied":false}]}') =>
  Response.json({
    model: 'response-model',
    choices: [
      { finish_reason: 'stop', message: { content, reasoning_content: 'PRIVATE_REASONING' } },
    ],
  });
const input: ProactiveJudgeInput = {
  candidates: [{ scene: 'scene-4', confidence: 0.8, estimatedWeight: 1 }],
  evidence: {
    trigger: 'message',
    now: 0,
    botAliases: [],
    inBotTopicWindow: false,
    recentMessageCount: 1,
    recentHumanCount: 1,
    pendingQuestionCount: 0,
    pendingQuestions: [],
    matchedInterestIds: [],
    unansweredStreak: 0,
  },
  transcript: 'PRIVATE_INPUT',
};
function client(fetchImpl: typeof fetch, timeoutMs = 5000) {
  return createChatClient({
    apiBase: 'https://offline.invalid',
    apiKey: 'secret',
    model: 'request-model',
    timeoutMs,
    fetchImpl,
  });
}

describe('话题判定请求及元数据', () => {
  it.each([false, true])('两种请求 ask=%s 均关闭推理且保留 token 上限', async (ask) => {
    const request = vi.fn(async () =>
      completion(ask ? '{"related":false,"mentions_chat_record":true}' : '{"related":true}')
    );
    const judge = createTopicJudgeResult({
      apiBase: 'https://offline.invalid',
      apiKey: 'secret',
      model: 'request-model',
      timeoutMs: 1000,
      perTurnMaxChars: 100,
      logger: createLogger({ sink: () => {} }),
      fetchImpl: request,
    });
    const result = await judge!({
      history: [{ role: 'user', speaker: 'user', text: 'PRIVATE_INPUT', ts: 1 }],
      newMessage: 'followup',
      askAboutChatRecord: ask,
    });
    const body = JSON.parse(
      (request.mock.calls[0] as unknown as [unknown, RequestInit])[1].body as string
    );
    expect(body).toMatchObject({ reasoning_effort: 'none', max_tokens: ask ? 48 : 32 });
    expect(result).toMatchObject({ ok: true, value: { related: !ask, mentionsChatRecord: ask } });
  });
  it.each(['length', 'http', 'timeout', 'schema', 'json', 'network'])(
    '%s 失败保守回退，诊断没有原文',
    async (kind) => {
      vi.useFakeTimers();
      const lines: string[] = [];
      const logger = createLogger({ autoTick: false, sink: (line) => lines.push(line) });
      const fetchImpl: typeof fetch = async () => {
        if (kind === 'http') return new Response('PRIVATE_ERROR', { status: 401 });
        if (kind === 'timeout') return new Promise(() => {});
        if (kind === 'network') throw new Error('PRIVATE_ERROR');
        if (kind === 'json') return new Response('PRIVATE_ERROR');
        if (kind === 'schema') return Response.json(null);
        return Response.json({
          model: 'response-model',
          choices: [
            {
              finish_reason: 'length',
              message: { content: '', reasoning_content: 'PRIVATE_REASONING' },
            },
          ],
        });
      };
      const options = {
        apiBase: 'https://offline.invalid',
        apiKey: 'secret',
        model: 'request-model',
        timeoutMs: 100,
        perTurnMaxChars: 100,
        logger,
        fetchImpl,
      };
      const pending = createTopicJudge(options)!({
        history: [],
        newMessage: 'PRIVATE_INPUT',
        askAboutChatRecord: true,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toEqual({ related: true, mentionsChatRecord: false });
      expect(lines.map((l) => JSON.parse(l)).filter((r) => r.level === 'warn')).toHaveLength(1);
      if (kind === 'length')
        expect(JSON.parse(lines[0]!)).toMatchObject({
          requestModel: 'request-model',
          responseModel: 'response-model',
          httpStatus: 200,
          finishReason: 'length',
          contentLength: 0,
          reasoningLength: 17,
        });
      expect(lines.join('')).not.toMatch(/PRIVATE_INPUT|PRIVATE_ERROR|PRIVATE_REASONING/);
    }
  );
});

describe('主动判定重试、总时限和并发', () => {
  it('响应读取的网络异常可重试', async () => {
    vi.useFakeTimers();
    const broken = completion();
    vi.spyOn(broken, 'json').mockRejectedValue(new TypeError('PRIVATE_NETWORK_ERROR'));
    const request = vi.fn(async () => (request.mock.calls.length === 1 ? broken : completion()));
    const pending = client(request).completeResult!([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toMatchObject({ ok: true, diagnostics: { attempts: 2 } });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('注入时钟的短预算在退避期间到期，终结后不再发请求', async () => {
    const clock = new ManualClock();
    const request = vi.fn(async () => new Response('', { status: 500 }));
    const chat = createChatClient({
      apiBase: 'https://offline.invalid',
      apiKey: 'secret',
      model: 'm',
      timeoutMs: 100,
      clock,
      fetchImpl: request,
    });
    const pending = chat.completeResult!([]);
    await settle();
    clock.advance(100);
    await settle();
    expect(await pending).toMatchObject({
      ok: false,
      failureClass: 'timeout',
      diagnostics: { attempts: 1, retryCount: 0 },
    });
    clock.advance(2000);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('网络、429 之后成功，遵循 Retry-After，一次兼容调用', async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    const fetchImpl = vi.fn(async () => {
      times.push(Date.now());
      if (times.length === 1) throw new Error('PRIVATE_ERROR');
      return times.length === 2
        ? new Response('PRIVATE_ERROR', { status: 429, headers: { 'Retry-After': '0.5' } })
        : completion();
    });
    const onError = vi.fn();
    const judge = createDefaultProactiveJudge({ chat: client(fetchImpl), onError });
    const pending = judge.judgeResult!(input);
    await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toMatchObject({ ok: true, diagnostics: { attempts: 3, retryCount: 2 } });
    expect(times.map((t) => t - times[0]!)).toEqual([0, 250, 750]);
    expect(onError).not.toHaveBeenCalled();
  });
  it.each([408, 429, 500, 503])('HTTP %s 耗尽只通知一次', async (status) => {
    vi.useFakeTimers();
    const request = vi.fn(async () => new Response('PRIVATE_ERROR', { status }));
    const onError = vi.fn();
    const judge = createDefaultProactiveJudge({ chat: client(request), onError });
    const pending = judge.judge(input);
    await vi.advanceTimersByTimeAsync(1250);
    expect(await pending).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).not.toContain('PRIVATE_ERROR');
  });
  it.each(['400', '401', '404', 'schema', 'empty', 'json', 'verdict'])(
    '%s 不重试',
    async (kind) => {
      const request = vi.fn(async () => {
        if (/^4/.test(kind)) return new Response('PRIVATE_ERROR', { status: Number(kind) });
        if (kind === 'schema') return Response.json(null);
        if (kind === 'json') return new Response('PRIVATE_ERROR');
        return completion(kind === 'empty' ? '' : 'PRIVATE_OUTPUT');
      });
      const onError = vi.fn();
      const judge = createDefaultProactiveJudge({ chat: client(request), onError });
      expect(await judge.judge(input)).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(onError.mock.calls)).not.toMatch(
        /PRIVATE_ERROR|PRIVATE_OUTPUT|PRIVATE_REASONING/
      );
    }
  );
  it('总超时覆盖退避与重试后的挂起请求，不依赖 fetch 响应 abort', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () =>
      request.mock.calls.length === 1
        ? new Response('', { status: 500 })
        : new Promise<Response>(() => {})
    );
    const pending = client(request, 600).completeResult!([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toMatchObject({
      ok: false,
      failureClass: 'timeout',
      diagnostics: { attempts: 2, retryCount: 1 },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['10', 'Wed, 01 Jan 2020 00:00:00 GMT'])(
    '预算外或过期 Retry-After=%s 使用默认退避',
    async (value) => {
      vi.useFakeTimers();
      const request = vi.fn(async () =>
        request.mock.calls.length === 1
          ? new Response('', { status: 429, headers: { 'Retry-After': value } })
          : completion()
      );
      const pending = client(request, 1000).completeResult!([]);
      await vi.advanceTimersByTimeAsync(250);
      expect(await pending).toMatchObject({ ok: true, diagnostics: { retryCount: 1 } });
    }
  );
  it('重试保留全局并发名额，排队及释放期间不超限', async () => {
    vi.useFakeTimers();
    let active = 0,
      max = 0;
    const perInput = new Map<string, number>();
    const request = vi.fn(async (_url, init) => {
      const body = init?.body as string;
      const count = (perInput.get(body) ?? 0) + 1;
      perInput.set(body, count);
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return count === 1 ? new Response('', { status: 500 }) : completion();
    });
    const judge = createDefaultProactiveJudge({ chat: client(request), maxConcurrent: 2 });
    const pending = Promise.all(
      Array.from({ length: 5 }, (_, i) => judge.judge({ ...input, transcript: String(i) }))
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).every(Boolean)).toBe(true);
    expect(max).toBe(2);
    expect(request).toHaveBeenCalledTimes(10);
  });
});

function watcherHarness() {
  const clock = new ManualClock();
  const lines: string[] = [];
  const stats = createPipelineStats();
  const logger = createLogger({ autoTick: false, sink: (l) => lines.push(l) });
  const calls: ProactiveJudgeInput[] = [];
  let mode: 'failure' | 'success' | 'yielding' | 'missing' | 'forged' = 'failure';
  let gate: Promise<void> | undefined;
  let closeDuringCall = false;
  const watcher = createProactiveWatcher({
    config: {
      ...DEFAULT_WATCHER_CONFIG,
      enabled: true,
      dryRun: true,
      whitelistGroups: ['ob11:g1'],
      questionProbeMs: 1000,
      maxQuestionProbes: 1,
      topicRollMs: 3600000,
      topicRollMessages: 10000,
    },
    windows: createObservationWindowStore({
      allowlist: ['ob11:g1'],
      maxMessages: 100,
      maxAgeMs: 3600000,
    }),
    speaker: { deliver: async () => ({ status: 'would-send' as const }) },
    logger,
    now: clock.now,
    schedule: (fn, ms) => {
      const timer = clock.setTimeout(fn, ms);
      return () => {
        clock.clearTimeout(timer);
      };
    },
    metrics: {
      ...NULL_WATCHER_METRICS,
      judgeFailed: () => {
        stats.record('proactiveJudgeFailures');
      },
    },
    judge: {
      judge: async () => {
        throw new Error('legacy entry should not run');
      },
      judgeResult: async (i): Promise<JudgmentResult<readonly SceneVerdict[]>> => {
        calls.push(i);
        await gate;
        if (mode === 'failure')
          return {
            ok: false,
            failureClass: 'http',
            diagnostics: { httpStatus: 503, retryCount: 2 },
          };
        if (closeDuringCall)
          watcher.stateFor('ob11:g1').markAnswered(i.evidence.pendingQuestions[0]!.id);
        const id = mode === 'forged' ? 'fake@0' : i.evidence.pendingQuestions[0]?.id;
        const evidence = mode === 'missing' ? undefined : `q:${id}`;
        const wait = mode === 'success' ? {} : { waitReason: 'yielding' as const, evidence };
        return {
          ok: true,
          diagnostics: {},
          value: i.candidates.map((c) => ({
            scene: c.scene,
            satisfied: false,
            confidence: 0.9,
            reason: 'test',
            ...wait,
          })),
        };
      },
    },
  });
  let id = 0;
  const observe = (text = '机器人帮我一下') => {
    const message: NormalizedMessage = {
      kind: 'group-message',
      target: { key: 'ob11:g1', kind: 'group', platform: 'onebot', id: '1' },
      senderId: 'alice',
      msgId: String(++id),
      eventId: String(id),
      content: text,
      ts: clock.now(),
      raw: {},
    };
    watcher.observe(message);
  };
  return {
    watcher,
    calls,
    clock,
    observe,
    stats,
    lines,
    setMode: (m: typeof mode) => {
      mode = m;
    },
    setGate: (p?: Promise<void>) => {
      gate = p;
    },
    closeDuringCall: () => {
      closeDuringCall = true;
    },
  };
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('watcher 熔断和 wait 引用', () => {
  it('wait 唤醒缺失引用也拒绝，不能补猜票据对象', async () => {
    const h = watcherHarness();
    h.setMode('yielding');
    h.observe('接口参数怎么传？');
    h.clock.advance(1000);
    await settle();
    expect(h.watcher.snapshot().waitTickets.created).toBe(1);
    h.setMode('missing');
    h.clock.advance(1);
    h.observe('群友补充');
    h.clock.advance(45000);
    await settle();
    expect(h.calls.some((c) => c.evidence.trigger === 'wait-wakeup')).toBe(true);
    expect(h.watcher.snapshot()).toMatchObject({
      judgeFailures: 0,
      waitInvalidTargetsByReason: { missing: 1 },
      waitTickets: { created: 1, pending: 0, spent: 1, invalidTarget: 1 },
    });
  });
  it('三次失败只计三次、三个 warn；冷却持续旁听，到期无自动调用，单次试探成功恢复', async () => {
    const h = watcherHarness();
    for (let i = 0; i < 3; i++) {
      h.observe();
      await settle();
    }
    expect(h.watcher.snapshot()).toMatchObject({
      judgeCalls: 3,
      judgeFailures: 3,
      judgeRetries: 6,
      judgeFailuresByClass: { http: 3 },
      suspended: 1,
    });
    expect(h.stats.proactiveJudgeFailures).toBe(3);
    expect(h.lines.map(JSON.parse).filter((r) => r.level === 'warn')).toHaveLength(3);
    h.observe('冷却期间旁听');
    h.observe();
    await settle();
    expect(h.calls).toHaveLength(3);
    expect(h.watcher.snapshot().buffered).toBe(5);
    h.clock.advance(300000);
    await settle();
    expect(h.calls).toHaveLength(3);
    expect(h.watcher.snapshot().circuits?.['ob11:g1']?.state).toBe('probe-ready');
    h.setMode('success');
    let release!: () => void;
    h.setGate(
      new Promise((r) => {
        release = r;
      })
    );
    h.observe();
    h.observe();
    await settle();
    expect(h.calls).toHaveLength(4);
    expect(h.watcher.snapshot().circuits?.['ob11:g1']?.state).toBe('probing');
    release();
    await settle();
    h.setGate();
    expect(h.watcher.snapshot().circuits?.['ob11:g1']).toMatchObject({
      state: 'closed',
      consecutiveFailures: 0,
    });
    h.observe();
    await settle();
    expect(h.calls).toHaveLength(5);
  });
  it('试探失败立即重新冷却五分钟', async () => {
    const h = watcherHarness();
    for (let i = 0; i < 3; i++) {
      h.observe();
      await settle();
    }
    h.clock.advance(300000);
    h.observe();
    await settle();
    expect(h.watcher.snapshot().circuits?.['ob11:g1']).toMatchObject({
      state: 'cooldown',
      consecutiveFailures: 4,
      pausedAt: h.clock.now(),
      nextProbeAt: h.clock.now() + 300000,
    });
    h.observe();
    await settle();
    expect(h.calls).toHaveLength(4);
  });
  it('wait 唤醒不能绕过冷却且票据只结算一次', async () => {
    const h = watcherHarness();
    h.setMode('yielding');
    h.observe('这个接口参数怎么传？');
    h.clock.advance(1000);
    await settle();
    expect(h.watcher.snapshot().waitTickets.created).toBe(1);
    h.setMode('failure');
    h.clock.advance(1);
    for (let i = 0; i < 3; i++) {
      h.observe();
      await settle();
    }
    const before = h.calls.length;
    h.clock.advance(45000);
    await settle();
    expect(h.calls).toHaveLength(before);
    expect(h.watcher.snapshot().waitTickets).toMatchObject({ created: 1, pending: 0, spent: 1 });
    h.clock.advance(45000);
    await settle();
    expect(h.watcher.snapshot().waitTickets.spent).toBe(1);
  });
  it.each(['yielding', 'missing', 'forged', 'closed'] as const)(
    '实际提示提供完整 ID，%s 目标正确处理且不计上游失败',
    async (mode) => {
      const h = watcherHarness();
      h.setMode(mode === 'closed' ? 'yielding' : mode);
      if (mode === 'closed') h.closeDuringCall();
      h.observe('这个接口参数怎么传？');
      h.clock.advance(1000);
      await settle();
      const first = h.calls[0]!;
      const target = first.evidence.pendingQuestions[0]!.id;
      expect(first.transcript).toContain(`q:${target}`);
      expect(h.watcher.snapshot().judgeFailures).toBe(0);
      if (mode === 'yielding') {
        expect(h.watcher.snapshot().waitTickets.created).toBe(1);
        h.clock.advance(1);
        h.observe('又有群友补充');
        await settle();
        h.clock.advance(45000);
        await settle();
        const wake = h.calls.find((c) => c.evidence.trigger === 'wait-wakeup')!;
        expect(wake.transcript).toContain(`wait 唤醒目标：q:${target}`);
        expect(wake.transcript).toContain('已等待 45 秒');
      } else {
        expect(h.watcher.snapshot().waitTickets.created).toBe(0);
        expect(h.watcher.snapshot().waitInvalidTargetsByReason?.[mode]).toBe(1);
      }
    }
  );
});
