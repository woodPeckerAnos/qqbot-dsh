import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';

export interface Check {
  name: string;
  passed: boolean;
  evidence: unknown;
}
export interface Coverage {
  realTaskSystem: boolean;
  runner: boolean;
  channel: boolean;
  plugin: boolean;
  adapter: boolean;
}
export interface ScenarioRecord {
  id: string;
  version: 2;
  name: string;
  status: 'passed' | 'failed';
  durationMs: number;
  checks: Check[];
  coverage: Coverage;
  metrics?: Record<string, unknown>;
  counts?: { frontend: number; worker: number; summary: number };
  tasks?: unknown[];
  closed?: Record<string, number>;
}
export interface RegistryEntry {
  id: string;
  name: string;
  requiredChecks: readonly string[];
  coverage: Coverage;
}
export const records: ScenarioRecord[] = [];
export const outputDirectory = () =>
  resolve(process.env.TASKS_V3_BENCHMARK_OUTPUT ?? 'tmp/benchmarks/tasks-v3-v2');
export const selectedIds = () =>
  (process.env.TASKS_V3_BENCHMARK_CASES ?? '').split(',').filter(Boolean);
export function isSelected(id: string): boolean {
  return !selectedIds().length || selectedIds().includes(id);
}
export function recordPasses(record: ScenarioRecord, entry: RegistryEntry): boolean {
  return (
    record.status === 'passed' &&
    record.checks.length > 0 &&
    record.checks.every((check) => check.passed) &&
    entry.requiredChecks.every((name) =>
      record.checks.some((check) => check.name === name && check.passed)
    )
  );
}
export async function writeReport(
  registry: readonly RegistryEntry[],
  evaluation?: {
    benchmarkVersion: string;
    mode: 'live';
    performed: boolean;
    judgeApiRequests: number;
    semanticStatus: string;
    runEvidence: unknown;
  }
): Promise<void> {
  const output = outputDirectory();
  await mkdir(output, { recursive: true });
  const selected = selectedIds();
  const expected = registry.filter((entry) => !selected.length || selected.includes(entry.id));
  const scenarios = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const unknownCases = selected.filter((id) => !registry.some((entry) => entry.id === id));
  const missingCases = expected
    .filter((entry) => !scenarios.some((record) => record.id === entry.id))
    .map((entry) => entry.id);
  const duplicateCases = scenarios
    .filter((record, i) => scenarios.findIndex((other) => other.id === record.id) !== i)
    .map((record) => record.id);
  const missingAssertions = expected.flatMap((entry) =>
    entry.requiredChecks
      .filter(
        (name) =>
          !scenarios
            .find((record) => record.id === entry.id)
            ?.checks.some((check) => check.name === name)
      )
      .map((name) => ({ id: entry.id, name }))
  );
  const failedAssertions = scenarios.flatMap((record) =>
    record.checks
      .filter((check) => !check.passed)
      .map((check) => ({ id: record.id, name: check.name }))
  );
  const complete =
    expected.length > 0 &&
    !unknownCases.length &&
    !missingCases.length &&
    !duplicateCases.length &&
    !missingAssertions.length;
  const passed =
    complete &&
    scenarios.every((record) => {
      const entry = expected.find((entry) => entry.id === record.id);
      return !!entry && recordPasses(record, entry);
    });
  const report = {
    schemaVersion: 2,
    architectureVersion: 3,
    benchmarkVersion: evaluation?.benchmarkVersion ?? 'tasks-v3-v2',
    mode: evaluation?.mode ?? 'offline',
    generatedAt: new Date().toISOString(),
    status: passed ? 'passed' : 'failed',
    complete,
    fullCoverage: !selected.length,
    expectedScenarios: expected.map((entry) => entry.id),
    missingCases,
    unknownCases,
    duplicateCases,
    missingAssertions,
    failedAssertions,
    registry: expected,
    modelEvaluation: evaluation ?? {
      performed: false,
      apiRequests: 0,
      status: 'unrun',
      reason: '离线仅验证生产编排、协议及适配器；脚本输出不用于模型语义结论。',
    },
    summary: {
      scenarios: scenarios.length,
      passed: scenarios.filter((record) => record.status === 'passed').length,
      checks: scenarios.reduce((sum, record) => sum + record.checks.length, 0),
    },
    scenarios,
  };
  const formatting = await resolveConfig(resolve(output, 'report.json'));
  await writeFile(
    resolve(output, 'report.json'),
    await format(JSON.stringify(report), { ...formatting, parser: 'json' })
  );
  const rows = scenarios
    .map(
      (record) =>
        `| ${record.id} | ${record.name} | ${record.status} | ${record.checks.filter((check) => check.passed).length}/${record.checks.length} | ${Object.entries(
          record.coverage
        )
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(', ')} |`
    )
    .join('\n');
  const details = scenarios
    .map(
      (record) =>
        `### ${record.id} ${record.name}\n\n${record.checks.map((check) => `- ${check.passed ? '通过' : '失败'}：${check.name}；证据：${JSON.stringify(check.evidence)}`).join('\n')}\n`
    )
    .join('\n');
  await writeFile(
    resolve(output, 'report.md'),
    await format(
      `# 前台/worker V3 ${evaluation ? 'live' : '离线'} benchmark\n\n状态：${report.status}；完整：${complete}；${report.summary.passed}/${report.summary.scenarios} 场景通过。${evaluation ? `真实模型已运行；裁判请求${evaluation.judgeApiRequests}，语义${evaluation.semanticStatus}。` : '真实模型与独立语义裁判未运行，API请求0。'}每个场景只记录实际运行的生产所有者；未捕获的数值不填0冒充实测。\n\n| 场景 | 行为 | 状态 | 必需检查 | 生产覆盖 |\n| --- | --- | --- | --- | --- |\n${rows}\n\n缺失场景：${JSON.stringify(missingCases)}；缺失断言：${JSON.stringify(missingAssertions)}。\n\n${details}`,
      { ...formatting, parser: 'markdown' }
    )
  );
  if (!passed) throw new Error(`benchmark未通过：${output}/report.json`);
}
