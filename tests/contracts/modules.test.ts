import { describe, expect, it } from 'vitest';
import { contractExamples } from '../../packages/contracts/src/examples.js';
import { modules } from '@qqbot/contracts';
import { executeExample, smokeModuleIds } from '../../scripts/smoke-contracts.mjs';

/** Each data fixture executes the compiled public module consumer loop. */
for (const module of modules) {
  describe(`${module.id} consumer contract and independent smoke`, () => {
    for (const kind of ['normal', 'edge', 'failure'] as const) {
      const fixture = contractExamples.find(
        (example) => example.module === module.id && example.kind === kind
      );
      it(`${module.id}.${kind}`, async () => {
        expect(fixture).toBeDefined();
        await executeExample(fixture!);
      });
    }
  });
}

it('all modules and executable examples have exactly one consumer/smoke registration', () => {
  expect([...smokeModuleIds].sort()).toEqual(modules.map((module) => module.id).sort());
  expect(new Set(contractExamples.map((example) => example.id)).size).toBe(contractExamples.length);
  expect(contractExamples.map((example) => example.id).sort()).toEqual(
    modules.flatMap((module) => module.examples.map((example) => example.id)).sort()
  );
});
