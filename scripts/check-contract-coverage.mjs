import { existsSync, readFileSync } from 'node:fs';
import { modules } from '../packages/contracts/dist/metadata.js';
import { contractExamples, contractExamplesV3 } from '../packages/contracts/dist/examples.js';

export const unitTests = {
  config: ['tests/config.test.ts', 'tests/config-file.test.ts', 'tests/model-config.test.ts'],
  content: ['tests/content.test.ts', 'tests/chunk.test.ts'],
  connectors: ['tests/onebot.test.ts', 'tests/gateway.test.ts', 'tests/qq-send-contract.test.ts'],
  store: ['tests/store.test.ts', 'tests/window.test.ts', 'tests/personas.test.ts'],
  media: ['tests/image.test.ts', 'tests/files.test.ts', 'tests/document.test.ts'],
  runtime: [
    'tests/protocol.test.ts',
    'tests/pool.test.ts',
    'tests/agent-trace.test.ts',
    'tests/task-v3-runtime.test.ts',
    'tests/task-v3-plugin.test.ts',
    'tests/task-v3-channel.test.ts',
  ],
  session: [
    'tests/session-context.test.ts',
    'tests/session-context-integration.test.ts',
    'tests/task-v3-system.test.ts',
  ],
  task: [
    'tests/task-state-contract.test.ts',
    'tests/task-system.test.ts',
    'tests/task-v3-state.test.ts',
    'tests/task-v3-system.test.ts',
  ],
  delivery: [
    'tests/task-state-contract.test.ts',
    'tests/task-system.test.ts',
    'tests/task-v3-delivery.test.ts',
  ],
  ingress: ['tests/task-system.test.ts', 'tests/topic-judge.test.ts'],
  proactive: [
    'tests/scenes-layers.test.ts',
    'tests/scene-state.test.ts',
    'tests/proactive-wait.test.ts',
  ],
  offpeak: ['tests/offpeak.test.ts'],
  observability: ['tests/logging.test.ts', 'tests/runtime-logging.test.ts'],
};

const kinds = ['normal', 'edge', 'failure'];
const problems = [];
for (const module of modules) {
  if (!existsSync(module.entry)) problems.push(`${module.id}: 公共入口缺失`);
  if (
    !unitTests[module.id]?.length ||
    unitTests[module.id].some(
      (file) => !existsSync(file) || !readFileSync(file, 'utf8').includes('it(')
    )
  )
    problems.push(`${module.id}: 单元测试映射缺失`);
  const examples = contractExamples.filter((example) => example.module === module.id);
  for (const kind of kinds)
    if (examples.filter((example) => example.kind === kind).length !== 1)
      problems.push(`${module.id}: ${kind} 示例必须恰好一份`);
  const ids = new Set(examples.map((example) => example.id));
  if (module.examples.some((example) => !ids.has(example.id)))
    problems.push(`${module.id}: 元数据和执行夹具漂移`);
  const examplesV3 = contractExamplesV3.filter((example) => example.module === module.id);
  if (module.examplesV3) {
    for (const kind of kinds)
      if (examplesV3.filter((example) => example.kind === kind).length !== 1)
        problems.push(`${module.id}: V3 ${kind} 示例必须恰好一份`);
    const idsV3 = new Set(examplesV3.map((example) => example.id));
    if (module.examplesV3.some((example) => !idsV3.has(example.id)))
      problems.push(`${module.id}: V3 元数据和执行夹具漂移`);
  }
}
const allExamples = [...contractExamples, ...contractExamplesV3];
if (new Set(allExamples.map((example) => example.id)).size !== allExamples.length)
  problems.push('示例 ID 重复');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `契约覆盖通过：${modules.length} 个模块具备单元/消费者/离线示例与 ${allExamples.length} 个可执行示例（含 V3）。`
  );
