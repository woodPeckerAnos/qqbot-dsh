import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from '../../../src/observability/index.js';
import type { BenchmarkReport, RunRecord } from './types.js';

export function gate(
  report: Pick<BenchmarkReport, 'records' | 'errors' | 'calibration' | 'options'>
): boolean {
  if (report.errors.length || report.calibration?.passed === false || !report.records.length)
    return false;
  if (
    report.records.some((record) =>
      record.requiredAssertions?.some(
        (name) => !record.assertions.some((assertion) => assertion.name === name)
      )
    )
  )
    return false;
  if (
    report.records.some((r) =>
      r.assertions.some((a) => a.category === 'runtime' && a.status !== 'pass')
    )
  )
    return false;
  if (!report.options.strict) return true;
  return report.records.every((r) => {
    if (r.assertions.some((a) => a.category === 'semantic' && a.status !== 'pass')) return false;
    if (r.mode === 'live' && !r.judge) return false;
    if (r.judge?.status === 'inconclusive') return false;
    return (
      !r.judge ||
      Object.values(r.judge.dimensions).every(
        (d) => d.status !== 'inconclusive' && !(d.status === 'fail' && d.severity === 'severe')
      )
    );
  });
}
export function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}
function distribution(values: number[]) {
  return { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}
export function metrics(records: RunRecord[]) {
  const first: number[] = [],
    final: number[] = [],
    queue: number[] = [];
  for (const r of records)
    for (const t of r.tasks) {
      const received = r.actions.filter((a) => a.taskId === t.taskId && a.status === 'received');
      const times = received.map((a) => a.receivedAt!).sort((a, b) => a - b);
      if (times.length) {
        first.push(times[0]! - t.createdAt);
        final.push(times.at(-1)! - t.createdAt);
      }
      queue.push(
        ...Object.values(t.lanes).flatMap((lane) =>
          lane.startedAt === undefined ? [] : [lane.startedAt - t.createdAt]
        )
      );
    }
  const duration = records.reduce((sum, r) => sum + r.durationMs, 0),
    tasks = records.reduce((sum, r) => sum + r.tasks.length, 0);
  return {
    samples: records.length,
    tasks,
    firstReplyMs: distribution(first),
    finalDeliveryMs: distribution(final),
    queueAndPreparationMs: distribution(queue),
    durationMs: duration,
    throughputTasksPerSecond: duration > 0 ? (tasks * 1000) / duration : null,
    runtimePassRate: records.length ? records.filter(runtimePass).length / records.length : 0,
    semanticPassRate: records.filter((r) => r.judge).length
      ? records.filter((r) => r.judge?.status === 'pass').length /
        records.filter((r) => r.judge).length
      : null,
    inconclusive: records.filter(
      (r) =>
        r.judge?.status === 'inconclusive' || r.assertions.some((a) => a.status === 'inconclusive')
    ).length,
    resources: records.map((r) => ({ caseId: r.caseId, repetition: r.repetition, ...r.resources })),
  };
}
function runtimePass(record: RunRecord) {
  return record.assertions
    .filter((a) => a.category === 'runtime')
    .every((a) => a.status === 'pass');
}
export function markdown(report: BenchmarkReport) {
  const lines = [
    '# SessionActor benchmark',
    '',
    `结果：${report.passed ? '门禁通过' : '门禁失败'}；模式：${report.options.mode}；严格：${report.options.strict}；种子：${report.options.seed}。`,
    '',
    '离线语义标注仅验证已知反例；真实语义结论以显式live报告为准。没有任意毫秒阈值。',
    '',
    '| 场景 | 样本 | 运行通过 | 语义pass/fail/inconclusive | 已知问题 |',
    '| --- | ---: | ---: | --- | --- |',
  ];
  for (const id of new Set(report.records.map((r) => r.caseId))) {
    const rows = report.records.filter((r) => r.caseId === id);
    lines.push(
      `| ${id} ${rows[0]!.title} | ${rows.length} | ${rows.filter(runtimePass).length}/${rows.length} | ${['pass', 'fail', 'inconclusive'].map((s) => rows.filter((r) => r.judge?.status === s).length).join('/')} | ${rows.some((r) => r.knownIssue) ? '是，不豁免严格门禁' : ''} |`
    );
  }
  lines.push(...baselineLines(report.records));
  lines.push('', '## 耗时与资源', '', '```json', JSON.stringify(report.metrics, null, 2), '```');
  const output = report.records.filter((r) => r.outputDelivery);
  if (output.length) {
    lines.push(
      '',
      '## 输出交付',
      '',
      '| 场景 | 外部/目标 | 记录节点 | 正文完整 | 文件完整 | 准备ms | 末条ms |',
      '| --- | ---: | ---: | --- | --- | ---: | ---: |'
    );
    for (const r of output) {
      const d = r.outputDelivery!;
      lines.push(
        `| ${r.caseId} | ${d.externalMessages}/${d.targetMessages} | ${d.internalNodes} | ${d.bodyComplete} | ${d.filesComplete} | ${d.preparationMs.toFixed(2)} | ${d.lastDeliveryMs} |`,
        '',
        '```json',
        JSON.stringify({ actions: d.actions, resources: r.resources }, null, 2),
        '```',
        ''
      );
    }
  }
  if (report.comparison)
    lines.push('', '## 基线比较', '', '```json', JSON.stringify(report.comparison, null, 2), '```');
  lines.push('', '## 失败与未完成证据', '');
  for (const error of report.errors) lines.push(`- ${error}`);
  for (const r of report.records) {
    const failures = r.assertions.filter((a) => a.status !== 'pass');
    const dimensions = Object.entries(r.judge?.dimensions ?? {}).filter(
      ([, d]) => d.status !== 'pass'
    );
    if (!failures.length && !dimensions.length) continue;
    lines.push('', `### ${r.caseId} 第${r.repetition}次`, '');
    failures.forEach((a) =>
      lines.push(`- ${a.category}/${a.name}: ${a.status} ${JSON.stringify(a.evidence)}`)
    );
    dimensions.forEach(([key, d]) =>
      lines.push(
        `- ${key}: ${d.status} (${d.severity}) ${d.reason}；原句：${JSON.stringify(d.quotes)}`
      )
    );
    lines.push(
      '',
      '实际收到的完整序列：',
      '',
      '```json',
      JSON.stringify(
        r.actions
          .filter((a) => a.status === 'received')
          .sort((a, b) => a.receivedOrder! - b.receivedOrder!),
        null,
        2
      ),
      '```'
    );
  }
  if (report.calibration)
    lines.push(
      '',
      `裁判校准：${report.calibration.passed ? '通过' : '失败'}；${report.calibration.samples.length}个样本。`
    );
  return lines.join('\n') + '\n';
}
function baselineLines(records: RunRecord[]): string[] {
  const baselines = records.filter((record) => record.requiredAssertions?.length);
  if (!baselines.length) return [];
  return [
    '',
    '## 固定基线断言与证据',
    '',
    '以下为实际执行的检查，包括成功证据；离线模拟回复不代表真实模型语义验收。',
    ...baselines.flatMap((record) => [
      '',
      `### ${record.caseId} ${record.title}（第 ${record.repetition} 次）`,
      '',
      '```json',
      JSON.stringify(
        {
          requiredAssertions: record.requiredAssertions,
          assertions: record.assertions.filter(
            (assertion) =>
              record.requiredAssertions?.includes(assertion.name) ||
              assertion.name === 'required-assertions-present'
          ),
        },
        null,
        2
      ),
      '```',
    ]),
  ];
}
export function sanitize<T>(value: T, secrets: string[] = []): T {
  const nonempty = secrets.filter((s) => s.length > 3);
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) => {
      if (
        /^(apiKey|accessToken|appId|appSecret|clientSecret|authorization|recentStderr|raw)$/i.test(
          key
        )
      )
        return undefined;
      if (typeof item !== 'string') return item;
      let text = redact(item);
      for (const secret of nonempty) text = text.split(secret).join('[REDACTED]');
      return text;
    })
  ) as T;
}
export async function writeReport(report: BenchmarkReport, secrets: string[] = []) {
  const safe = sanitize(report, secrets);
  await mkdir(report.options.output, { recursive: true });
  await writeFile(join(report.options.output, 'report.json'), JSON.stringify(safe, null, 2) + '\n');
  await writeFile(join(report.options.output, 'report.md'), markdown(safe));
}
export async function compare(report: BenchmarkReport, path: string) {
  const old = JSON.parse(await readFile(path, 'utf8')) as BenchmarkReport;
  if (old.version !== report.version || old.options.mode !== report.options.mode)
    throw new Error('incompatible-baseline');
  const changed = report.records.filter(
    (r) => !old.records.some((b) => b.caseId === r.caseId && b.caseVersion === r.caseVersion)
  );
  if (changed.length) throw new Error('baseline-scenario-version-mismatch');
  const required = report.records
    .filter(
      (record) =>
        record.requiredAssertions ||
        old.records.some(
          (baseline) => baseline.caseId === record.caseId && baseline.requiredAssertions
        )
    )
    .map((record) => compareRequired(record, old.records));
  const delivery = report.records
    .filter((r) => r.outputDelivery)
    .map((r) => {
      const b = old.records.find(
        (b) =>
          b.caseId === r.caseId &&
          b.caseVersion === r.caseVersion &&
          b.seed === r.seed &&
          b.repetition === r.repetition
      );
      if (!b?.outputDelivery || b.outputDelivery.inputHash !== r.outputDelivery!.inputHash)
        throw new Error('baseline-output-input-mismatch');
      return { caseId: r.caseId, previous: b.outputDelivery, current: r.outputDelivery };
    });
  return {
    requiredAssertions: required,
    outputDelivery: delivery,
    baseline: path,
    previous: metrics(old.records.filter((r) => report.records.some((b) => b.caseId === r.caseId))),
    current: report.metrics,
  };
}
function compareRequired(record: RunRecord, previous: RunRecord[]) {
  const baseline = previous.find(
    (entry) =>
      entry.caseId === record.caseId &&
      entry.caseVersion === record.caseVersion &&
      entry.seed === record.seed &&
      entry.repetition === record.repetition
  );
  if (!baseline || JSON.stringify(baseline.inputs) !== JSON.stringify(record.inputs))
    throw new Error('baseline-required-input-mismatch');
  if (JSON.stringify(baseline.requiredAssertions) !== JSON.stringify(record.requiredAssertions))
    throw new Error('baseline-required-assertions-mismatch');
  return {
    caseId: record.caseId,
    repetition: record.repetition,
    previous: baseline.assertions.map(({ name, status }) => ({ name, status })),
    current: record.assertions.map(({ name, status }) => ({ name, status })),
  };
}
