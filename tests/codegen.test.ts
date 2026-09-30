/**
 * 规则生成器的离线单测：模板解析、静态纪律、注册器文本变换、
 * 管道编排（fake LLM + fake 执行器）、gate-client 的 fail-closed。
 * 全程不触网。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkAcceptanceCoverage, checkRuleSource } from '../src/intervention/codegen/discipline.js';
import { generateRule, regenerateRule } from '../src/intervention/codegen/pipeline.js';
import { parseGeneratedCode } from '../src/intervention/codegen/prompts.js';
import {
  renderChainRegistration,
  renderIndexRegistration,
  renderReadmeRegistration,
} from '../src/intervention/codegen/register.js';
import { parseRequirement, RequirementParseError } from '../src/intervention/codegen/template.js';
import type { ExecResult } from '../src/intervention/codegen/validate.js';
import type { ChatClient } from '../src/intervention/gate-client.js';
import { createChatClient, createGateClient, parseGateVerdict } from '../src/intervention/gate-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const realRuleDir = join(here, '..', 'src', 'intervention', 'rules', '01-master-switch');

// ---------------------------------------------------------------------------
// template.ts
// ---------------------------------------------------------------------------

describe('codegen/template', () => {
  it('解析真实的 01-master-switch 需求文档', () => {
    const md = readFileSync(join(realRuleDir, 'REQUIREMENT.md'), 'utf8');
    const req = parseRequirement(md);
    expect(req.frontmatter.rule).toBe('master-switch');
    expect(req.frontmatter.stage).toBe('intake');
    expect(req.frontmatter.order).toBe(1);
    expect(req.frontmatter.params).toHaveLength(1);
    expect(req.frontmatter.params[0]?.name).toBe('enabled');
    expect(req.acceptance.length).toBe(4);
    expect(req.description).toContain('总开关');
  });

  it('缺 frontmatter / 缺小节 / 验收标准为空 → 抛 RequirementParseError', () => {
    expect(() => parseRequirement('# 没有 frontmatter')).toThrow(RequirementParseError);
    const noAcceptance = `---\nrule: x\nstage: intake\norder: 9\nparams: []\n---\n\n# 原始需求\nx\n\n# 需求描述\nx\n\n# 判定\nx\n\n# 参数\n无。\n\n# 验收标准\n没有列表\n\n# 背景与调研来源\nx\n`;
    expect(() => parseRequirement(noAcceptance)).toThrow(/验收标准/);
  });
});

// ---------------------------------------------------------------------------
// discipline.ts
// ---------------------------------------------------------------------------

describe('codegen/discipline', () => {
  const fm = { rule: 'test-echo', stage: 'intake' as const, order: 5, params: [] };

  it('合规源码通过', () => {
    const source = `import type { InterventionRule } from '../../contract.js';
export const rule: InterventionRule = { name: 'test-echo', stage: 'intake', order: 5,
  evaluate: () => ({ action: 'pass' }) };
`;
    expect(checkRuleSource(source, fm)).toEqual([]);
  });

  it('白名单外的 import 被拒', () => {
    const source = `import { readFileSync } from 'node:fs';
export const rule = { name: 'test-echo', stage: 'intake', order: 5 };
`;
    const issues = checkRuleSource(source, fm);
    expect(issues.some((i) => i.check === 'import-whitelist')).toBe(true);
  });

  it.each([
    ['Date.now()', ' purity'],
    ['Math.random()', 'purity'],
    ['setTimeout(() => {}, 1)', 'purity'],
    ['process.env.X', 'purity'],
  ])('纯度违禁：%s', (snippet) => {
    const source = `export const rule = { name: 'test-echo', stage: 'intake', order: 5,
  evaluate: () => { ${snippet}; return { action: 'pass' }; } };
`;
    const issues = checkRuleSource(source, fm);
    expect(issues.some((i) => i.check === 'purity')).toBe(true);
  });

  it('name/stage/order 与 frontmatter 不一致被拒', () => {
    const source = `export const rule = { name: 'other', stage: 'speak', order: 6 };`;
    const issues = checkRuleSource(source, fm);
    expect(issues.filter((i) => i.check === 'shape').length).toBeGreaterThanOrEqual(3);
  });

  it('验收覆盖：缺「验收2」被指出', () => {
    const issues = checkAcceptanceCoverage('it("验收1：…", () => {})', 2);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain('验收2');
  });
});

// ---------------------------------------------------------------------------
// prompts.ts
// ---------------------------------------------------------------------------

describe('codegen/prompts', () => {
  it('parseGeneratedCode：恰好两个 ts 块才通过', () => {
    const good = '前言\n```ts\nconst a = 1;\n```\n中间\n```ts\nconst b = 2;\n```\n';
    expect(parseGeneratedCode(good)).toEqual({ ruleTs: 'const a = 1;', testTs: 'const b = 2;' });
    expect(() => parseGeneratedCode('```ts\nonly one\n```')).toThrow(/恰好两个/);
  });
});

// ---------------------------------------------------------------------------
// gate-client.ts
// ---------------------------------------------------------------------------

describe('gate-client', () => {
  it('parseGateVerdict：裸 JSON / 围栏 / 垃圾输入', () => {
    expect(parseGateVerdict('{"decision":"speak","reason":"无人回答"}')).toEqual({
      decision: 'speak',
      reason: '无人回答',
    });
    expect(parseGateVerdict('```json\n{"decision":"silent","reason":"闲聊"}\n```')?.decision).toBe('silent');
    expect(parseGateVerdict('随便聊聊')).toBeUndefined();
    expect(parseGateVerdict('{"decision":"maybe"}')).toBeUndefined();
  });

  it('createChatClient：HTTP 错误与非 JSON 都抛错', async () => {
    const failing = createChatClient({
      apiBase: 'https://example.com',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 1000,
      fetchImpl: async () => new Response('boom', { status: 500 }),
    });
    await expect(failing.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 500/);
  });

  it('createGateClient：任何失败 fail-closed 为 silent', async () => {
    const gate = createGateClient({
      apiBase: 'https://example.com',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 1000,
      criteria: '测试判定标准',
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    const verdict = await gate.judge({ transcript: 't', stateSummary: 's' });
    expect(verdict.decision).toBe('silent');
  });
});

// ---------------------------------------------------------------------------
// register.ts
// ---------------------------------------------------------------------------

describe('codegen/register', () => {
  const fakeReq = {
    frontmatter: {
      rule: 'at-others',
      stage: 'intake' as const,
      order: 5,
      params: [],
    },
    original: '原始',
    description: '消息 @ 了其他成员时不参与评估。',
    decision: '…',
    acceptance: ['a'],
    background: '…',
  };

  it('index.ts：加 import + 按 order 插入链数组', () => {
    const source = `import type { RuleRegistry } from '../watcher.js';
import { rule as masterSwitch } from './01-master-switch/rule.js';
import { rule as groupWhitelist } from './02-group-whitelist/rule.js';

export const RULE_REGISTRY: RuleRegistry = {
  continuation: [],
  intake: [masterSwitch, groupWhitelist],
  evaluate: [],
  speak: [],
};
`;
    const out = renderIndexRegistration(source, fakeReq);
    expect(out).toContain(`import { rule as atOthers } from './05-at-others/rule.js';`);
    expect(out).toContain('intake: [masterSwitch, groupWhitelist, atOthers],');
  });

  it('README.md：清单表按编号插入新行', () => {
    const source = [
      '| 文件夹 | stage | 一句话需求 | 期数 |',
      '|---|---|---|---|',
      '| [01-master-switch](01-master-switch/REQUIREMENT.md) | intake | 总开关 | P0 |',
      '| [02-group-whitelist](02-group-whitelist/REQUIREMENT.md) | intake | 白名单 | P0 |',
      '| `10-strong-quote-bot` | intake | 引用 bot | P2 |',
      '',
    ].join('\n');
    const out = renderReadmeRegistration(source, fakeReq, 'P2');
    const rows = out.split('\n').filter((l) => l.startsWith('| `') || l.startsWith('| ['));
    expect(rows.map((r) => r.slice(0, 12))).toEqual([
      '| [01-master',
      '| [02-group-',
      '| `05-at-oth',
      '| `10-strong',
    ]);
  });

  it('CHAIN.md：成员行更新', () => {
    const source = [
      '## ② intake 链（Phase 0 起）',
      '',
      '说明文字。',
      '',
      '成员（机器维护）：01-master-switch',
      '',
      '## ③ evaluate 链（Phase 2）',
      '',
      '成员（机器维护）：（空）',
      '',
    ].join('\n');
    const out = renderChainRegistration(source, fakeReq);
    expect(out).toContain('成员（机器维护）：01-master-switch、05-at-others');
  });
});

// ---------------------------------------------------------------------------
// pipeline.ts（fake LLM + fake 执行器，全程离线）
// ---------------------------------------------------------------------------

const FAKE_REQUIREMENT_MD = `---
rule: test-echo
stage: intake
order: 5
params:
  - name: keyword
    default: hello
    meaning: 触发关键词
stats: halt_test_echo
---

# 原始需求
消息含 hello 时不评估

# 需求描述
消息文本包含关键词 hello 时，这条消息不参与后续评估。

# 判定
- 包含关键词 → halt('keyword-hit')
- 否则 → pass

# 参数
| 名字 | 默认值 | 含义 |
|---|---|---|
| keyword | hello | 触发关键词 |

# 验收标准
1. 含关键词 → halt(keyword-hit)
2. 不含关键词 → pass

# 背景与调研来源
测试夹具。
`;

const FAKE_RULE_TS = `import type { InterventionRule } from '../../contract.js';

export const rule: InterventionRule = {
  name: 'test-echo',
  stage: 'intake',
  order: 5,
  paramsSpec: { keyword: 'hello' },
  evaluate(ctx) {
    const keyword = String(ctx.params['keyword'] ?? 'hello');
    if (ctx.message !== undefined && ctx.message.content.includes(keyword)) {
      return { action: 'halt', reason: 'keyword-hit' };
    }
    return { action: 'pass' };
  },
};
`;

const FAKE_TEST_TS = `import { describe, expect, it } from 'vitest';
import { rule } from './rule.js';

describe('test-echo', () => {
  it('验收1：含关键词 → halt', () => {});
  it('验收2：不含关键词 → pass', () => {});
  it('契约：name/stage/order 与 frontmatter 一致', () => {
    expect(rule.name).toBe('test-echo');
  });
});
`;

function fakeLlm(opts: { skipStructure?: boolean } = {}): ChatClient {
  let call = 0;
  return {
    complete: async () => {
      call += 1;
      // ① 结构化（--from-requirement 模式没有这一步）
      if (call === 1 && opts.skipStructure !== true) return FAKE_REQUIREMENT_MD;
      return `\`\`\`ts\n${FAKE_RULE_TS}\n\`\`\`\n\`\`\`ts\n${FAKE_TEST_TS}\n\`\`\``; // ③/修复
    },
  };
}

describe('codegen/pipeline', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qqbot-codegen-'));
    // 脚手架：pipeline 会读 contract.ts 与 01-master-switch 示例（作为 prompt 素材）
    mkdirSync(join(root, 'src', 'intervention', 'rules', '01-master-switch'), { recursive: true });
    writeFileSync(join(root, 'src', 'intervention', 'contract.ts'), '// contract fixture', 'utf8');
    for (const file of ['REQUIREMENT.md', 'rule.ts', 'rule.test.ts']) {
      writeFileSync(
        join(root, 'src', 'intervention', 'rules', '01-master-switch', file),
        readFileSync(join(realRuleDir, file), 'utf8'),
      );
    }
    writeFileSync(
      join(root, 'src', 'intervention', 'rules', 'index.ts'),
      `import type { RuleRegistry } from '../watcher.js';
import { rule as masterSwitch } from './01-master-switch/rule.js';

export const RULE_REGISTRY: RuleRegistry = {
  continuation: [],
  intake: [masterSwitch],
  evaluate: [],
  speak: [],
};
`,
      'utf8',
    );
    writeFileSync(
      join(root, 'src', 'intervention', 'rules', 'README.md'),
      '| 文件夹 | stage | 一句话需求 | 期数 |\n|---|---|---|---|\n| [01-master-switch](01-master-switch/REQUIREMENT.md) | intake | 总开关 | P0 |\n',
      'utf8',
    );
    writeFileSync(
      join(root, 'src', 'intervention', 'rules', 'CHAIN.md'),
      '## ② intake 链\n\n成员（机器维护）：01-master-switch\n',
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const okExec = async (): Promise<ExecResult> => ({ code: 0, stdout: '', stderr: '' });

  function deps(overrides: { confirm?: () => Promise<boolean>; execFails?: boolean; skipStructure?: boolean } = {}) {
    return {
      llm: fakeLlm({ skipStructure: overrides.skipStructure }),
      confirm: overrides.confirm ?? (async () => true),
      exec: overrides.execFails
          ? async (): Promise<ExecResult> => ({ code: 1, stdout: '', stderr: 'tsc boom' })
          : okExec,
      projectRoot: root,
      registered: [{ name: 'master-switch', stage: 'intake' as const, order: 1, evaluate: () => ({ action: 'pass' as const }) }],
      maxRepairs: 1,
      now: () => 1_700_000_000_000,
    };
  }

  it('全流程：结构化 → 人工确认 → 生成 → 校验 → 注册', async () => {
    const result = await generateRule('消息含 hello 时不评估', deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.folder).toBe('05-test-echo');
    const ruleDir = join(root, 'src', 'intervention', 'rules', '05-test-echo');
    expect(existsSync(join(ruleDir, 'REQUIREMENT.md'))).toBe(true);
    expect(existsSync(join(ruleDir, 'rule.ts'))).toBe(true);
    // 注册 diff 已写入三个文件
    expect(result.touchedFiles).toHaveLength(3);
    const index = readFileSync(join(root, 'src', 'intervention', 'rules', 'index.ts'), 'utf8');
    expect(index).toContain(`import { rule as testEcho } from './05-test-echo/rule.js';`);
    expect(index).toContain('intake: [masterSwitch, testEcho],');
  });

  it('人工确认闸拒绝 → 中止，不落任何文件', async () => {
    const result = await generateRule('x', deps({ confirm: async () => false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('人工确认');
    expect(existsSync(join(root, 'src', 'intervention', 'rules', '05-test-echo'))).toBe(false);
  });

  it('校验修复循环耗尽 → 移入 _rejected/ 并附失败报告，不注册', async () => {
    const result = await generateRule('x', deps({ execFails: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejectedDir).toBeDefined();
    expect(existsSync(join(result.rejectedDir!, 'FAILURE.md'))).toBe(true);
    // 未注册
    const index = readFileSync(join(root, 'src', 'intervention', 'rules', 'index.ts'), 'utf8');
    expect(index).not.toContain('testEcho');
  });

  it('已存在的文件夹不再生成（幂等保护）', async () => {
    mkdirSync(join(root, 'src', 'intervention', 'rules', '05-test-echo'), { recursive: true });
    const result = await generateRule('x', deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('已存在');
  });

  it('--from-requirement：从既有需求文档重生成（跳过结构化与人工确认）', async () => {
    // 先造一个已存在的规则文件夹
    const ruleDir = join(root, 'src', 'intervention', 'rules', '05-test-echo');
    mkdirSync(ruleDir, { recursive: true });
    writeFileSync(join(ruleDir, 'REQUIREMENT.md'), FAKE_REQUIREMENT_MD, 'utf8');
    let confirmCalled = false;
    const result = await regenerateRule(ruleDir, {
      ...deps({ skipStructure: true }),
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });
    expect(confirmCalled).toBe(false);
    expect(result.ok).toBe(true);
  });
});
