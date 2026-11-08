import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { contextCases, CONTEXT_GROUP } from './bench/session/context-cases.js';
import { runCase, selectCases } from './bench/session/runner.js';
import { compare, gate, markdown } from './bench/session/report.js';
import type { BenchmarkOptions, BenchmarkReport } from './bench/session/types.js';

const baselinePath = fileURLToPath(
  new URL('../docs/benchmarks/session-context-v1/report.json', import.meta.url)
);
const options: BenchmarkOptions = {
  mode: 'offline',
  cases: [CONTEXT_GROUP],
  seed: 42,
  strict: true,
  full: false,
  output: 'tmp/context-baseline-contract-test',
};
let baseline: BenchmarkReport;
beforeAll(async () => {
  baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as BenchmarkReport;
});

describe('任务衔接固定基线', () => {
  it('C01–C10 默认执行，版本和必需断言与保存的基线一致', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);
    expect(contextCases.map((c) => c.id)).toEqual(ids);
    expect(selectCases(options).map((c) => c.id)).toEqual(ids);
    expect(selectCases({ ...options, cases: [] }).map((c) => c.id)).toEqual(
      expect.arrayContaining(ids)
    );
    expect(baseline.records.map((record) => record.caseId)).toEqual(ids);
    for (const c of contextCases) {
      const saved = baseline.records.find((record) => record.caseId === c.id)!;
      expect(c.version).toBe(saved.caseVersion);
      expect(c.requiredAssertions).toEqual(saved.requiredAssertions);
      expect(saved.assertions.every((assertion) => assertion.status === 'pass')).toBe(true);
    }
    expect(baseline.passed).toBe(true);
    expect(gate(baseline)).toBe(true);
    expect(markdown(baseline)).toContain('固定基线断言与证据');
    expect(markdown(baseline)).toContain('execution-and-delivery-separated');
  });
  it.each([
    ['C01', 'progress-no-slow-resources'],
    ['C04', 'latest-result-visible'],
    ['C06', 'execution-and-delivery-separated'],
  ])('%s 的关键断言 %s 缺失、失败或未定均阻止通过', (id, name) => {
    for (const status of ['missing', 'fail', 'inconclusive'] as const) {
      const report = structuredClone(baseline);
      const record = report.records.find((item) => item.caseId === id)!;
      if (status === 'missing')
        record.assertions = record.assertions.filter((assertion) => assertion.name !== name);
      else record.assertions.find((assertion) => assertion.name === name)!.status = status;
      expect(gate(report), `${id}/${name}/${status}`).toBe(false);
    }
  });
  it('声明但未执行的关键断言被 runner 记录为运行失败', async () => {
    const record = await runCase(
      {
        id: 'missing-assertion',
        title: 'missing',
        group: CONTEXT_GROUP,
        version: 1,
        steps: [],
        expectation: '必须有实际观察',
        requiredAssertions: ['must-observe-delivery'],
        run: async () => {},
      },
      options
    );
    expect(record.assertions).toContainEqual({
      name: 'required-assertions-present',
      category: 'runtime',
      status: 'fail',
      evidence: { missing: ['must-observe-delivery'] },
    });
    expect(gate({ records: [record], errors: [], options })).toBe(false);
  });
  it('同一场景输入和断言可以比较基线', async () => {
    const comparison = await compare(baseline, baselinePath);
    expect(comparison.requiredAssertions).toHaveLength(10);
    expect(
      comparison.requiredAssertions.every((entry) =>
        entry.current.every((assertion) => assertion.status === 'pass')
      )
    ).toBe(true);
  });
  it.each(['input', 'seed', 'repetition', 'assertions', 'assertions-removed', 'version'])(
    '改变 %s 不能借用原基线通过比较',
    async (change) => {
      const report = structuredClone(baseline);
      const record = report.records[0]!;
      if (change === 'input') record.inputs[0]!.text = '换成另一个简单问题';
      if (change === 'seed') record.seed++;
      if (change === 'repetition') record.repetition++;
      if (change === 'assertions') record.requiredAssertions = ['resources-released'];
      if (change === 'assertions-removed') record.requiredAssertions = undefined;
      if (change === 'version') record.caseVersion++;
      await expect(compare(report, baselinePath)).rejects.toThrow(/baseline-/);
    }
  );
});
