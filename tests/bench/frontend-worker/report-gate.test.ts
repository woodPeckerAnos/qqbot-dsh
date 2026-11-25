import { describe, it, expect } from 'vitest';
import { recordPasses, type RegistryEntry, type ScenarioRecord } from './report.js';

const coverage = {
  realTaskSystem: true,
  runner: false,
  channel: false,
  plugin: false,
  adapter: false,
};
const entry: RegistryEntry = {
  id: 'required',
  name: '必需实际断言',
  requiredChecks: ['关键生产检查'],
  coverage,
};
const record: ScenarioRecord = {
  id: 'required',
  version: 2,
  name: entry.name,
  status: 'passed',
  durationMs: 0,
  coverage,
  checks: [{ name: '关闭资源', passed: true, evidence: { timers: 0 } }],
};

describe('benchmark必需实际断言', () => {
  it('只有场景passed和资源关闭不能掩盖漏跑的生产断言', () => {
    expect(recordPasses(record, entry)).toBe(false);
  });
  it('失败的必需检查拒绝通过，同名实际检查通过才能完成', () => {
    for (const passed of [false, true]) {
      const actual = {
        ...record,
        checks: [...record.checks, { name: '关键生产检查', passed, evidence: { actualCalls: 1 } }],
      };
      expect(recordPasses(actual, entry)).toBe(passed);
    }
  });
});
