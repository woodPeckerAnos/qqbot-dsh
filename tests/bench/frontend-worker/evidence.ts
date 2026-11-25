import { appendFile } from 'node:fs/promises';

/** Optional test evidence, never imported by production code. */
export async function recordBenchmarkEvidence(name: string, evidence: unknown): Promise<void> {
  const path = process.env.TASKS_V3_EVIDENCE_OUTPUT;
  if (path) await appendFile(path, JSON.stringify({ name, evidence }) + '\n');
}
