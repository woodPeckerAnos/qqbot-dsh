import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  records,
  outputDirectory,
  recordPasses,
  type RegistryEntry,
  type ScenarioRecord,
} from './report.js';

interface ProductionGroup extends RegistryEntry {
  files: string[];
  testPattern?: string;
}
const executed = '生产用例实际执行且全部通过';
export const productionGroups: ProductionGroup[] = [
  {
    id: 'F10',
    name: '大任务紧凑查询、分页与真实控制通道',
    files: [
      'tests/task-v3-boundaries.test.ts',
      'tests/task-v3-channel.test.ts',
      'tests/bench/frontend-worker/query-channel.test.ts',
    ],
    testPattern: '查询|投影|分页|容量|紧凑|30个中文',
    requiredChecks: [executed],
    coverage: { realTaskSystem: true, runner: true, channel: true, plugin: false, adapter: false },
  },
  {
    id: 'F11',
    name: '前台五次调用、最终收尾与丢失回执',
    files: ['tests/task-v3-plugin.test.ts', 'tests/task-v3-runtime.test.ts'],
    testPattern: '前台|回执|fd3',
    requiredChecks: [executed],
    coverage: { realTaskSystem: true, runner: true, channel: false, plugin: true, adapter: false },
  },
  {
    id: 'F12',
    name: '失败后闲聊、明确重试与禁止进度派发',
    files: ['tests/task-v3-boundaries.test.ts'],
    testPattern: '闲聊|重试|进度.*派发|progress|retry',
    requiredChecks: [executed],
    coverage: { realTaskSystem: true, runner: true, channel: false, plugin: false, adapter: false },
  },
  {
    id: 'F13',
    name: '问题台账引用、淘汰窗口与作者区分',
    files: ['tests/proactive-watcher.test.ts'],
    testPattern: '真实问题引用边界',
    requiredChecks: [executed],
    coverage: {
      realTaskSystem: false,
      runner: false,
      channel: false,
      plugin: false,
      adapter: false,
    },
  },
  {
    id: 'F14',
    name: 'plain格式完整转换、真实发送及历史',
    files: ['tests/delivery-boundaries.test.ts', 'tests/task-v3-boundaries.test.ts'],
    testPattern: '完整正文转换|引用渲染|文本格式转换',
    requiredChecks: [executed],
    coverage: {
      realTaskSystem: true,
      runner: true,
      channel: false,
      plugin: false,
      adapter: true,
    },
  },
  {
    id: 'F15',
    name: '正文文件意图、图片、ZIP及文件独立副本',
    files: [
      'tests/delivery-boundaries.test.ts',
      'tests/task-v3-boundaries.test.ts',
      'tests/bench/frontend-worker/delivery-calibration.test.ts',
    ],
    testPattern: '单图|多图|ZIP|副本|正文文件|持久队列恢复|图片编码',
    requiredChecks: [executed],
    coverage: { realTaskSystem: true, runner: true, channel: false, plugin: false, adapter: true },
  },
  {
    id: 'F16',
    name: '搜索错误分类、额度缓存与并发排队',
    files: ['tests/search-service.test.ts', 'tests/task-v3-plugin.test.ts'],
    testPattern: '额度|429|HTTP|工具错误|取消|关闭|重建|未知形状|搜索代理|搜索故障',
    requiredChecks: [executed],
    coverage: {
      realTaskSystem: false,
      runner: false,
      channel: false,
      plugin: true,
      adapter: false,
    },
  },
  {
    id: 'F17',
    name: 'worker共用预算、收尾与关闭材料',
    files: [
      'tests/task-v3-boundaries.test.ts',
      'tests/task-v3-plugin.test.ts',
      'tests/task-v3-runtime.test.ts',
      'tests/worker-service-channel.test.ts',
    ],
    testPattern: '预算|step|部分|子代理|关闭|worker|收尾|quota|搜索失败|额度',
    requiredChecks: [executed],
    coverage: { realTaskSystem: true, runner: true, channel: true, plugin: true, adapter: false },
  },
  {
    id: 'F18',
    name: '主动判定实际请求、取消与解析',
    files: ['tests/judgment-recovery.test.ts'],
    requiredChecks: [executed],
    coverage: {
      realTaskSystem: false,
      runner: false,
      channel: false,
      plugin: false,
      adapter: false,
    },
  },
  {
    id: 'F19',
    name: '顶层管理员命令与失败日志隐私',
    files: ['tests/session-command.test.ts', 'tests/task-v3-boundaries.test.ts'],
    testPattern: '命令|stop|引用|顶层|日志|隐私',
    requiredChecks: [executed],
    coverage: { realTaskSystem: true, runner: true, channel: false, plugin: false, adapter: false },
  },
];

const mandatoryTitles: Record<string, readonly string[]> = {
  F10: [
    '查询默认8条同代旧任务，UTF8序列化不超过48KiB，正文分页绑定版本',
    '30个中文转义大快照经真实fd3紧凑投影并按版本分段读取，伪造大响应被同一通道拒绝',
    '完整查询结果超过回执容量时明确拒绝，不截断业务结果',
  ],
  F11: [
    '前台瞬时重试计入5次预算，第5正常请求无工具，连续失败第5次终止',
    '前台预算只有1次时首个请求没有工具',
    '前台最后一次调用提前隐藏工具并禁止直接执行',
    'fd3断开立即结束未派发前台，超时也不自动建worker',
    '接受请求已保存即结束前台，回执缺失和通道断开仍执行一次worker',
  ],
  F12: [
    '失败后闲聊只带摘要，明确重试绑定旧目标，引用和否定不授权',
    '进度查询被恶意模型派发时控制桥与生命周期都拒绝',
  ],
  F13: [
    '问题台账在窗口淘汰后仍给出真实作者正文和时间',
    '问题台账淘汰后按消息号和时间精确回查而不会选择同正文的另一作者',
    '错误问题号和时间只能引用真实群聊上下文且不发送判定evidence',
  ],
  F14: [
    '完整正文转换后再切分且代码空白Markdown字面量和emoji连接符保留',
    '引用渲染在投递历史和窗口保留真实代码且不泄漏内部问题号任务号',
    '已送达正文按保存的文本格式转换后核对，plain转换不会误报unknown',
  ],
  F15: [
    '单图和短正文使用一次普通OneBot动作并保留原引用和原作者提醒',
    '图片不进入混合资料ZIP且CSV与PDF字节完整保存',
    '单份CSV也只上传一个ZIP',
    '多图和正文使用一条平铺转发且所有图片字节保留',
    '入队副本在源图片和资料删除后仍发送相同字节',
    '正文文件只有当前用户明确要求且前台选择text-document时交付，规范路径去重',
    '持久队列恢复后单图正文仍只发送一次并使用保存的独立字节',
    '真实OneBot送出的错误ZIP必须被正常文件完整性检查拒绝，正确ZIP通过同一检查',
    '图片编码期间取消不会发出普通图文消息',
  ],
  F16: [
    '普通搜索故障后公开guard只允许3次web_fetch，禁止bash并自动收尾',
    '搜索代理收到额度耗尽后通过公开guard拒绝bash替代请求',
    '月度额度耗尽后排队和新请求复用首次错误且 HTTP 只调用一次',
    '普通 429 不缓存为月度耗尽，后续搜索仍请求服务',
    'HTTP 200 中明确月度额度工具错误也进入原错误流程',
    '普通工具错误不能被忽略为成功或额度耗尽',
    '排队查询取消立即返回且不会产生 HTTP 请求',
    '关闭服务取消已发送请求并拒绝后续搜索',
    '服务重建清空额度状态，搜索结果响应保持有界',
    '提供商未知形状明确失败，凭证不进入错误内容',
  ],
  F17: [
    '普通搜索故障后公开guard只允许3次web_fetch，禁止bash并自动收尾',
    '搜索代理收到额度耗尽后通过公开guard拒绝bash替代请求',
    '根和子代理共享40个业务step，只给根一次无工具收尾',
    '80%时间通知收尾，保留原硬截止和关闭时写下的部分正文',
    '搜索额度耗尽保存类型原因并停止工具，缓存额度直接拒绝必需搜索的派发',
    '普通搜索故障只允许3个当前用户或本次来源链接，拒绝猜测地址',
    'worker使用40次业务调用后根第41次无工具整理并正常结束',
    '父预算在组装期间到达时当前请求无工具且包含收尾要求，只多调用根一次',
    '搜索和步骤请求通过独立 worker 通道按身份回传',
    '单个搜索取消释放 HTTP 等待且保留其他 worker 请求',
    'worker 不能通过服务通道请求前台派发工具',
    '预算通知可在搜索等待期间送到 worker 且携带执行身份',
    '超大 worker 回执明确失败且实际传输不超过 64 KiB',
    'runtime 关闭取消通道中的 HTTP 等待',
  ],
  F18: [
    '主动判定请求关闭推理并限制1024token且保持原响应解析',
    '总超时覆盖退避与重试后的挂起请求，不依赖 fetch 响应 abort',
  ],
  F19: [
    '引用中的stop和转发正文均不会成为控制命令',
    '排除引用后仅完整顶层文本stop new reset可控制会话',
    '终态日志保留错误分类和原因类别，不输出正文与上游错误原文',
  ],
};
for (const group of productionGroups)
  group.requiredChecks = [
    executed,
    ...(mandatoryTitles[group.id] ?? []).map((title) => `生产用例：${title}`),
  ];

interface Assertion {
  title: string;
  fullName: string;
  status: string;
  failureMessages: string[];
}
function readAssertions(raw: unknown): Assertion[] {
  if (!raw || typeof raw !== 'object') throw new Error('Vitest报告不是对象');
  const results = (raw as Record<string, unknown>).testResults;
  if (!Array.isArray(results)) throw new Error('Vitest报告缺少testResults');
  return results.flatMap((result) => {
    if (!result || typeof result !== 'object') throw new Error('Vitest文件结果无效');
    const assertions = (result as Record<string, unknown>).assertionResults;
    if (!Array.isArray(assertions)) throw new Error('Vitest文件结果缺少assertionResults');
    return assertions.map((assertion) => {
      if (!assertion || typeof assertion !== 'object') throw new Error('Vitest断言结果无效');
      const value = assertion as Record<string, unknown>;
      if (
        typeof value.title !== 'string' ||
        typeof value.fullName !== 'string' ||
        typeof value.status !== 'string' ||
        !Array.isArray(value.failureMessages)
      )
        throw new Error('Vitest断言字段无效');
      return {
        title: value.title,
        fullName: value.fullName,
        status: value.status,
        failureMessages: value.failureMessages.filter(
          (message): message is string => typeof message === 'string'
        ),
      };
    });
  });
}
export async function runProductionGroup(group: ProductionGroup): Promise<void> {
  const started = performance.now();
  const record: ScenarioRecord = {
    id: group.id,
    version: 2,
    name: group.name,
    status: 'failed',
    durationMs: 0,
    checks: [],
    coverage: group.coverage,
    metrics: {
      modelApiRequests: 0,
      measuredRuntimeNumbers: '由用例断言验证；本组没有额外采集数值。',
    },
  };
  const directory = join(outputDirectory(), 'evidence');
  await mkdir(directory, { recursive: true });
  const reportPath = join(directory, `${group.id}.vitest.json`);
  await writeFile(join(directory, `${group.id}.metrics.jsonl`), '');
  try {
    const sources = await Promise.all(
      group.files.map(async (file) => ({
        file,
        sha256: createHash('sha256')
          .update(await readFile(resolve(file)))
          .digest('hex'),
      }))
    );
    const args = [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.tasks-v3-evidence.config.ts',
      ...group.files,
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ];
    if (group.testPattern) args.push('--testNamePattern', group.testPattern);
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TASKS_V3_EVIDENCE_FILES: JSON.stringify(group.files),
        TASKS_V3_EVIDENCE_OUTPUT: join(directory, `${group.id}.metrics.jsonl`),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = createHash('sha256');
    child.stdout.on('data', (data) => output.update(data));
    child.stderr.on('data', (data) => output.update(data));
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        resolveExit(signal ? 1 : (code ?? 1));
      });
    });
    const assertions = readAssertions(JSON.parse(await readFile(reportPath, 'utf8')));
    let measured: unknown[] = [];
    try {
      measured = (await readFile(join(directory, `${group.id}.metrics.jsonl`), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    record.metrics = { ...record.metrics, measured };
    const ran = assertions.filter(
      (assertion) => assertion.status !== 'pending' && assertion.status !== 'skipped'
    );
    record.checks.push({
      name: executed,
      passed:
        exitCode === 0 && ran.length > 0 && ran.every((assertion) => assertion.status === 'passed'),
      evidence: {
        exitCode,
        assertions: ran.length,
        skipped: assertions.length - ran.length,
        sources,
        report: `evidence/${group.id}.vitest.json`,
        outputSha256: output.digest('hex'),
      },
    });
    for (const assertion of ran)
      record.checks.push({
        name: `生产用例：${assertion.title}`,
        passed: assertion.status === 'passed',
        evidence: {
          fullName: assertion.fullName,
          status: assertion.status,
          failureHashes: assertion.failureMessages.map((message) =>
            createHash('sha256').update(message).digest('hex')
          ),
        },
      });
    record.status = record.checks.every((check) => check.passed) ? 'passed' : 'failed';
    if (!recordPasses(record, group))
      throw new Error(`${group.id} 必需生产用例缺失或失败；查看 ${reportPath}`);
  } catch (error) {
    record.status = 'failed';
    record.checks.push({
      name: '生产场景完成',
      passed: false,
      evidence: { error: error instanceof Error ? error.message : 'unknown-benchmark-error' },
    });
    throw error;
  } finally {
    record.durationMs = Math.round((performance.now() - started) * 100) / 100;
    records.push(record);
  }
}
