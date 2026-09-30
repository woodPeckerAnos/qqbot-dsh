/**
 * REQUIREMENT.md 的解析与渲染（规则真相源的机器可读层）。
 *
 * 格式约定（生成器与链冒烟测试共用这套解析）：
 *   - YAML frontmatter：rule / stage / order / params[] / stats；
 *   - 正文六个固定小节，按 `# 节名` 划分：
 *     原始需求 / 需求描述 / 判定 / 参数 / 验收标准 / 背景与调研来源；
 *   - 「验收标准」是可枚举的有序列表（`1. …`），单测必须逐条覆盖。
 */

import { parse as parseYaml } from 'yaml';

import type { RuleParamValue, RuleStage } from '../contract.js';

export interface RuleParamSpec {
  name: string;
  default: RuleParamValue;
  meaning: string;
}

export interface RuleRequirementFrontmatter {
  rule: string;
  stage: RuleStage;
  order: number;
  params: RuleParamSpec[];
  stats?: string;
}

export interface RuleRequirement {
  frontmatter: RuleRequirementFrontmatter;
  /** 「原始需求」正文（生成口逐字保留的自然语言输入） */
  original: string;
  /** 「需求描述」正文 */
  description: string;
  /** 「判定」正文 */
  decision: string;
  /** 「验收标准」逐条（有序列表项，去掉序号） */
  acceptance: string[];
  /** 「背景与调研来源」正文 */
  background: string;
}

export class RequirementParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequirementParseError';
  }
}

const STAGES: readonly RuleStage[] = ['continuation', 'intake', 'evaluate', 'speak'];
const SECTION_NAMES = ['原始需求', '需求描述', '判定', '参数', '验收标准', '背景与调研来源'] as const;

/** 解析 REQUIREMENT.md。结构不完整抛 RequirementParseError（生成器据此打回重修）。 */
export function parseRequirement(markdown: string): RuleRequirement {
  const fmMatch = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (fmMatch === null) {
    throw new RequirementParseError('缺少 YAML frontmatter（--- 包裹的头部）');
  }
  let fmRaw: unknown;
  try {
    fmRaw = parseYaml(fmMatch[1]!);
  } catch (error) {
    throw new RequirementParseError(
      `frontmatter 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof fmRaw !== 'object' || fmRaw === null) {
    throw new RequirementParseError('frontmatter 必须是映射');
  }
  const fm = fmRaw as Record<string, unknown>;

  const ruleName = fm['rule'];
  if (typeof ruleName !== 'string' || !/^[a-z][a-z0-9-]*$/.test(ruleName)) {
    throw new RequirementParseError(
      `frontmatter.rule 必须是小写 kebab-case 字符串，收到 ${JSON.stringify(ruleName)}`,
    );
  }
  const stage = fm['stage'];
  if (typeof stage !== 'string' || !STAGES.includes(stage as RuleStage)) {
    throw new RequirementParseError(
      `frontmatter.stage 只能是 ${STAGES.join(' | ')}，收到 ${JSON.stringify(stage)}`,
    );
  }
  const order = fm['order'];
  if (typeof order !== 'number' || !Number.isInteger(order) || order <= 0) {
    throw new RequirementParseError(`frontmatter.order 必须是正整数，收到 ${JSON.stringify(order)}`);
  }

  const params: RuleParamSpec[] = [];
  const paramsRaw = fm['params'];
  if (paramsRaw !== undefined && paramsRaw !== null) {
    if (!Array.isArray(paramsRaw)) {
      throw new RequirementParseError('frontmatter.params 必须是数组');
    }
    for (const item of paramsRaw) {
      if (typeof item !== 'object' || item === null) {
        throw new RequirementParseError('frontmatter.params 的每项必须是映射');
      }
      const record = item as Record<string, unknown>;
      const name = record['name'];
      const def = record['default'];
      if (typeof name !== 'string' || name === '') {
        throw new RequirementParseError('frontmatter.params 每项必须有 name（字符串）');
      }
      const t = typeof def;
      if (t !== 'string' && t !== 'number' && t !== 'boolean') {
        throw new RequirementParseError(
          `frontmatter.params.${name} 的 default 必须是标量（字符串/数字/布尔）`,
        );
      }
      params.push({
        name,
        default: def as RuleParamValue,
        meaning: typeof record['meaning'] === 'string' ? record['meaning'] : '',
      });
    }
  }

  const body = markdown.slice(fmMatch[0].length);
  const sections = splitSections(body);
  for (const name of SECTION_NAMES) {
    if (sections.get(name) === undefined) {
      throw new RequirementParseError(`缺少小节「# ${name}」`);
    }
  }
  const acceptance = parseAcceptance(sections.get('验收标准')!);
  if (acceptance.length === 0) {
    throw new RequirementParseError('「验收标准」必须是可枚举的有序列表（1. … 2. …），至少一条');
  }

  return {
    frontmatter: {
      rule: ruleName,
      stage: stage as RuleStage,
      order,
      params,
      ...(typeof fm['stats'] === 'string' ? { stats: fm['stats'] } : {}),
    },
    original: sections.get('原始需求')!.trim(),
    description: sections.get('需求描述')!.trim(),
    decision: sections.get('判定')!.trim(),
    acceptance,
    background: sections.get('背景与调研来源')!.trim(),
  };
}

/** 按 `# 标题` 切分正文小节。 */
function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | undefined;
  for (const line of body.split('\n')) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      current = heading[1]!;
      sections.set(current, '');
      continue;
    }
    if (current !== undefined) {
      sections.set(current, `${sections.get(current) ?? ''}${line}\n`);
    }
  }
  return sections;
}

/** 从「验收标准」小节提取有序列表项。 */
function parseAcceptance(section: string): string[] {
  const items: string[] = [];
  for (const line of section.split('\n')) {
    const match = /^\d+\.\s+(.+)$/.exec(line.trim());
    if (match !== null) items.push(match[1]!.trim());
  }
  return items;
}
