import { describe, it, expect } from 'vitest';
import { createTopicJudgeResult, parseJudgeResult } from '../../src/ingress/index.js';
import { createOffpeakGate, parseWindowsSpec } from '../../src/offpeak/index.js';
import { createNullLogger } from '../../src/observability/index.js';
import { readonlySnapshot } from '@qqbot/contracts';

describe('消费者显式失败及保守策略', () => {
  it('解析失败具有稳定分类，合法判定保持旧字段语义', () => {
    expect(parseJudgeResult('not-json')).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', retry: 'never' },
    });
    expect(parseJudgeResult('{"related": false,"mentions_chat_record":true}', true)).toEqual({
      ok: true,
      value: { related: false, mentionsChatRecord: true },
    });
    expect(parseJudgeResult('{"related": "false"}')).toMatchObject({ ok: false });
  });
  it('HTTP失败与未启用分离，错误关联根因且不重复请求', async () => {
    let requests = 0;
    const options = {
      apiBase: 'https://offline.invalid',
      apiKey: 'fixture',
      model: 'fixture',
      timeoutMs: 100,
      perTurnMaxChars: 50,
      logger: createNullLogger(),
      fetchImpl: async () => {
        requests++;
        return new Response('', { status: 503 });
      },
    };
    expect(createTopicJudgeResult({ ...options, apiKey: '' })).toBeUndefined();
    const judge = createTopicJudgeResult(options)!;
    const result = await judge({
      history: [{ role: 'user', speaker: 'u', text: 'history', ts: 100 }],
      newMessage: 'next',
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_FAILED', retry: 'safe', errorId: expect.any(String) },
    });
    expect(requests).toBe(1);
  });
});

describe('谷时段状态所有者的持久化契约', () => {
  it('保存失败保留生效覆盖与固定时间金标准，输入和返回集合均隔离', () => {
    let failing = false;
    const defaults = {
      enabled: false,
      windows: parseWindowsSpec('00:00-09:00'),
      timeZone: 'Asia/Shanghai',
      modelPattern: 'deepseek',
      weekendsAllDay: true,
      holidays: new Set(['2026-10-01']),
    };
    const gate = createOffpeakGate({
      defaults,
      filePath: '/missing/contract-gate',
      logger: createNullLogger(),
      now: () => 100,
      persistOverride: () => {
        if (failing) throw new Error('offline disk');
      },
    });
    defaults.holidays.add('2027-01-01');
    gate.setEnabled(true, 'admin');
    const golden = JSON.stringify(gate.snapshot());
    expect(golden).toBe(
      '{"enabled":true,"windows":["00:00–09:00"],"timeZone":"Asia/Shanghai","modelPattern":"deepseek","weekendsAllDay":true,"holidaysCount":1,"holidaysCoverageUntil":"2026-10-01","overridden":true,"updatedBy":"admin","updatedAt":100}'
    );
    failing = true;
    expect(() => gate.setEnabled(false, 'admin')).toThrow('保存失败');
    expect(() => {
      gate.clearOverride('admin');
    }).toThrow('保存失败');
    expect(JSON.stringify(gate.snapshot())).toBe(golden);
    expect(Reflect.set(gate.effective(), 'enabled', false)).toBe(false);
    const holidays = gate.effective().holidays;
    expect(() => Reflect.get(holidays, 'add')('2027-01-01')).toThrow();
  });
  it('固定种子重复覆盖与故障不会更改已提交状态', () => {
    let seed = 0x4203;
    let failing = false;
    const gate = createOffpeakGate({
      defaults: {
        enabled: false,
        windows: parseWindowsSpec('00:00-09:00'),
        timeZone: 'UTC',
        modelPattern: 'deepseek',
        weekendsAllDay: false,
        holidays: new Set(),
      },
      filePath: '/missing/gate',
      logger: createNullLogger(),
      now: () => 100,
      persistOverride: () => {
        if (failing) throw new Error('offline disk');
      },
    });
    let expected = false;
    for (let index = 0; index < 400; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const enabled = (seed & 1) === 1;
      failing = seed % 7 === 0;
      if (failing) expect(() => gate.setEnabled(enabled, 'admin')).toThrow();
      else {
        gate.setEnabled(enabled, 'admin');
        expected = enabled;
      }
      expect(gate.snapshot().enabled).toBe(expected);
    }
    expect(readonlySnapshot({ seed })).toEqual({ seed });
  });
});
