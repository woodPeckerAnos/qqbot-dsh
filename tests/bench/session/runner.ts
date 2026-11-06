import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTaskTerminal } from '../../../src/task/index.js';
import { Harness, liveConfig, fileHash, hash } from './harness.js';
import { offlineCases, mixedCases } from './offline-cases.js';
import { liveCases, LIGHT_IDS } from './live-cases.js';
import {
  createJudge,
  calibrate,
  loadJudgeConfig,
  inconclusive,
  JUDGE_VERSION,
  RUBRIC,
} from './judge.js';
import type { Judge } from './judge.js';
import { gate, metrics, compare, writeReport } from './report.js';
import type {
  BenchmarkCase,
  BenchmarkOptions,
  BenchmarkReport,
  RunRecord,
  JudgeVerdict,
} from './types.js';
import type { Config } from '@qqbot/contracts';
import type { ReasoningEvidence } from './types.js';

export function selectCases(options: BenchmarkOptions) {
  const pool = options.mode === 'live' ? liveCases : [...offlineCases, ...mixedCases];
  if (options.cases.length) {
    for (const filter of options.cases)
      if (!pool.some((c) => c.id === filter || c.group === filter))
        throw new Error(`unknown-case:${filter}`);
    return pool.filter((c) => options.cases.includes(c.id) || options.cases.includes(c.group));
  }
  return pool.filter((c) => options.mode !== 'live' || options.full || LIGHT_IDS.includes(c.id));
}
export async function runCase(
  c: BenchmarkCase,
  options: BenchmarkOptions,
  repetition = 1,
  config?: Config,
  judge?: Judge
): Promise<RunRecord> {
  const h = await Harness.create({
    mode: options.mode,
    seed: options.seed + repetition - 1,
    config,
  });
  try {
    return await collectCase(h, c, options, repetition, judge);
  } finally {
    await h.close();
    await h.remove();
  }
}
async function collectCase(
  h: Harness,
  c: BenchmarkCase,
  options: BenchmarkOptions,
  repetition: number,
  judge?: Judge
): Promise<RunRecord> {
  const startedAt = h.connector.now(),
    wallStart = Date.now();
  try {
    await c.run(h);
    h.check(
      'single-terminal-notification',
      [...h.terminalCounts.values()].every((count) => count === 1),
      [...h.terminalCounts]
    );
  } catch (error) {
    h.check(
      'scenario-completed',
      false,
      error instanceof Error ? error.message : 'unknown-scenario-error'
    );
  }
  const tasks = [...h.archived, ...h.system.manager.list()];
  const messages = h.system.queue.messages();
  const durationMs = Date.now() - wallStart;
  h.check(
    'all-task-lanes-terminal',
    tasks.every(
      (t) =>
        isTaskTerminal(t) &&
        Object.values(t.lanes).every((l) => ['completed', 'failed', 'cancelled'].includes(l.status))
    ),
    tasks.map((t) => ({ taskId: t.taskId, status: t.status }))
  );
  h.check(
    'no-duplicate-platform-attempts',
    new Set(h.connector.actions.map((a) => a.messageId)).size === h.connector.actions.length &&
      h.connector.actions.every((a) => !!a.messageId)
  );
  let verdict: JudgeVerdict | undefined;
  const judgeStarted = Date.now();
  if (c.knownIssue) verdict = labeledFailure(c, h);
  if (options.mode === 'live') {
    const received = h.received().sort((a, b) => a.receivedOrder! - b.receivedOrder!);
    verdict = judge
      ? await judge(
          {
            caseId: c.id,
            inputs: h.inputs,
            expectation: c.expectation,
            received,
            execution: tasks.map((t) => ({
              taskId: t.taskId,
              status: t.status,
              slowEndedAt: t.lanes.slow.executionEndedAt,
            })),
            reasoning: h.reasoning,
            toolsAndChildren: h.evidence.executions.map(
              ({ modelFinalText: _text, ...metadata }) => metadata
            ),
          },
          received
        )
      : inconclusive('judge-not-configured');
    if (c.reasoning && !h.reasoning.some((r) => r.lane === 'slow' && r.appeared)) {
      h.assertions.push({
        name: 'deep-reasoning-observable',
        category: 'semantic',
        status: 'inconclusive',
        evidence: h.reasoning,
      });
      verdict = requireReasoning(verdict, h.reasoning);
    }
  }
  const judgingMs = Date.now() - judgeStarted;
  await h.close();
  const resources = {
    runtimes: h.system.pools.fast.size + h.system.pools.slow.size,
    subagents: h.system.pools.fast.activeSubagents() + h.system.pools.slow.activeSubagents(),
    timers: h.timers,
    benchmarkObservers: h.evidence.activeObservers,
    connectorSubscriptions: h.connector.handlers.size,
    schedulerRunning:
      h.system.actor.snapshot().fast.running + h.system.actor.snapshot().slow.running,
    schedulerQueued: h.system.actor.snapshot().fast.queued + h.system.actor.snapshot().slow.queued,
  };
  h.check(
    'resources-released',
    Object.values(resources).every((n) => n === 0),
    resources
  );
  const record: RunRecord = {
    caseId: c.id,
    caseVersion: c.version,
    title: c.title,
    group: c.group,
    mode: options.mode,
    repetition,
    seed: h.seed,
    knownIssue: !!c.knownIssue,
    inputs: h.inputs,
    startedAt,
    durationMs,
    judgingMs,
    tasks,
    messages,
    actions: h.connector.actions,
    reasoning: h.reasoning,
    executions: h.evidence.executions,
    assertions: h.assertions,
    judge: verdict,
    resources,
    configuration: await manifest(h),
  };
  return record;
}
export function requireReasoning(
  verdict: JudgeVerdict,
  evidence: ReasoningEvidence[]
): JudgeVerdict {
  if (evidence.some((r) => r.lane === 'slow' && r.appeared)) return verdict;
  verdict.dimensions.handoff = {
    status: 'inconclusive',
    severity: 'none',
    reason: '缺少slow lane reasoning事件或reasoningTokens',
    quotes: [],
  };
  if (verdict.status === 'pass') verdict.status = 'inconclusive';
  return verdict;
}
function labeledFailure(c: BenchmarkCase, h: Harness): JudgeVerdict {
  const verdict = inconclusive('offline-labeled-counterexample');
  const key = c.id === 'O02' ? 'duplication' : 'contradiction';
  const quotes = h.received().map((a) => a.text);
  if (quotes.length !== 2) return verdict;
  verdict.version = 'offline-label-1';
  verdict.status = 'fail';
  verdict.dimensions[key] = { status: 'fail', severity: 'severe', reason: c.expectation, quotes };
  return verdict;
}
async function manifest(h: Harness) {
  const c = h.config;
  const profile = h.mode === 'live' ? await fileHash(c.dsh.profilePatch) : 'injected-mock';
  const lanes = await fileHash(
    fileURLToPath(new URL('../../../dsh-profile/lanes.patch.yml', import.meta.url))
  );
  const packageJson = JSON.parse(
    await readFile(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')
  ) as { dependencies: Record<string, string> };
  return {
    ...h.metadata,
    node: process.version,
    dshPackage: packageJson.dependencies['@deepseek-ai/dsh'],
    dshRuntimeVersions: [...h.evidence.versions],
    profileHash: profile,
    lanesHash: lanes,
    fast: { provider: c.tasks.fastProvider, model: c.tasks.fastModel, reasoningEffort: 'off' },
    slow: { provider: c.tasks.slowProvider, model: c.tasks.slowModel },
    modelRoutesHash: hash(JSON.stringify(c.modelApi)),
    tasks: c.tasks,
  };
}
export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const report: BenchmarkReport = {
    version: 'session-benchmark-1',
    createdAt: new Date().toISOString(),
    options,
    records: [],
    errors: [],
    passed: false,
    metrics: {},
  };
  const secrets = Object.entries(process.env)
    .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key))
    .map(([, value]) => value ?? '');
  try {
    const cases = selectCases(options);
    let config: Config | undefined, judge: Judge | undefined;
    if (options.mode === 'live') {
      const judgeConfig = await loadJudgeConfig();
      report.judgeConfiguration = {
        ...judgeConfig,
        version: JUDGE_VERSION,
        rubricHash: hash(RUBRIC),
        calibrationVersion: 1,
      };
      config = liveConfig();
      await livePreflight(config);
      judge = createJudge(judgeConfig);
      report.calibration = await calibrate(judge);
      if (!report.calibration.passed) throw new Error('judge-calibration-failed');
    }
    const liveRepeat = options.full ? 5 : 3;
    const repeat = options.repeat ?? (options.mode === 'live' ? liveRepeat : 1);
    for (const c of cases)
      for (let repetition = 1; repetition <= repeat; repetition++) {
        report.records.push(await runCase(c, options, repetition, config, judge));
        report.metrics = metrics(report.records);
        await writeReport(report, secrets);
      }
    if (options.baseline) report.comparison = await compare(report, options.baseline);
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : 'benchmark-failed');
  }
  report.metrics = metrics(report.records);
  report.passed = gate(report);
  await writeReport(report, secrets);
  return report;
}
async function livePreflight(config: Config) {
  await access(config.dsh.profilePatch, constants.R_OK);
  const candidates = config.dsh.bin.includes('/')
    ? [config.dsh.bin]
    : (process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, config.dsh.bin));
  const found = await Promise.all(
    candidates.map(async (path) => {
      try {
        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })
  );
  if (!found.some(Boolean)) throw new Error('missing-DSH-executable');
}
