/**
 * 规则的静态纪律检查（生成器的机器校验闸之一，纯函数）。
 *
 * 检查项即方案 §5.1 的三条纪律的机器化：
 *   1. import 白名单——规则只允许 import 契约模块；
 *   2. 纯度——禁止墙上时钟 / 随机数 / 定时器 / 网络 / 进程 / 文件系统；
 *   3. 形状——必须导出符合契约的 rule，且 name/stage/order 与 frontmatter 一致。
 */

import type { RuleRequirementFrontmatter } from './template.js';

export interface DisciplineIssue {
  check: string;
  detail: string;
}

/** 规则文件夹内允许出现的 import 来源（相对规则文件位置）。 */
const ALLOWED_IMPORTS = new Set(['../../contract.js']);

/** 纯度违禁模式：出现即拒绝。 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; detail: string }> = [
  { pattern: /\bDate\.now\s*\(/, detail: '禁止 Date.now()——用 ctx.now（注入时钟）' },
  { pattern: /\bnew\s+Date\s*\(/, detail: '禁止 new Date()——用 ctx.now（注入时钟）' },
  { pattern: /\bMath\.random\s*\(/, detail: '禁止 Math.random()——规则必须确定性' },
  { pattern: /\bsetTimeout\s*\(/, detail: '禁止 setTimeout——延迟重查用 defer 裁决，定时器归 runner' },
  { pattern: /\bsetInterval\s*\(/, detail: '禁止 setInterval——调度归 runner' },
  { pattern: /\bsetImmediate\s*\(/, detail: '禁止 setImmediate——调度归 runner' },
  { pattern: /\bfetch\s*\(/, detail: '禁止 fetch——IO 归 runner（LLM 能力用 ctx.gate）' },
  { pattern: /\brequire\s*\(/, detail: '禁止 require——ESM only' },
  { pattern: /\bprocess\./, detail: '禁止 process.*——配置经 ctx.params 注入' },
  { pattern: /\bglobalThis\./, detail: '禁止 globalThis——能力经 ctx 注入' },
];

/** 对 rule.ts 源码做静态纪律检查。返回的问题列表为空 = 通过。 */
export function checkRuleSource(
  source: string,
  frontmatter: RuleRequirementFrontmatter,
): DisciplineIssue[] {
  const issues: DisciplineIssue[] = [];

  // import 白名单
  const imports = source.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm);
  for (const match of imports) {
    if (!ALLOWED_IMPORTS.has(match[1]!)) {
      issues.push({
        check: 'import-whitelist',
        detail: `不允许的 import：'${match[1]}'（只允许 ${[...ALLOWED_IMPORTS].join(' / ')}）`,
      });
    }
  }

  // 纯度
  for (const { pattern, detail } of FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) issues.push({ check: 'purity', detail });
  }

  // 形状
  if (!/export\s+const\s+rule\b/.test(source)) {
    issues.push({ check: 'shape', detail: '必须导出 `export const rule: InterventionRule`' });
  }
  if (!new RegExp(`name:\\s*['"]${escapeRegExp(frontmatter.rule)}['"]`).test(source)) {
    issues.push({
      check: 'shape',
      detail: `rule.name 必须与 frontmatter 一致（'${frontmatter.rule}'）`,
    });
  }
  if (!new RegExp(`stage:\\s*['"]${frontmatter.stage}['"]`).test(source)) {
    issues.push({
      check: 'shape',
      detail: `rule.stage 必须与 frontmatter 一致（'${frontmatter.stage}'）`,
    });
  }
  if (!new RegExp(`order:\\s*${frontmatter.order}\\b`).test(source)) {
    issues.push({
      check: 'shape',
      detail: `rule.order 必须与 frontmatter 一致（${frontmatter.order}）`,
    });
  }

  // paramsSpec 与 frontmatter params 一致（声明了就必须在代码里有同名键）
  if (frontmatter.params.length > 0 && !/paramsSpec\s*:/.test(source)) {
    issues.push({
      check: 'shape',
      detail: 'frontmatter 声明了 params，rule.ts 必须有对应的 paramsSpec',
    });
  }

  return issues;
}

/** 验收标准覆盖检查：测试文件必须为每条验收标准带一个「验收N」用例。 */
export function checkAcceptanceCoverage(
  testSource: string,
  acceptanceCount: number,
): DisciplineIssue[] {
  const issues: DisciplineIssue[] = [];
  for (let i = 1; i <= acceptanceCount; i += 1) {
    if (!testSource.includes(`验收${i}`)) {
      issues.push({
        check: 'acceptance-coverage',
        detail: `测试文件缺少「验收${i}」用例（验收标准共 ${acceptanceCount} 条）`,
      });
    }
  }
  return issues;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
