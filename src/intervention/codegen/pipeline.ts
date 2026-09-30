/**
 * 规则生成管道（方案 §5.7 的五步两道闸）。
 *
 *   自然语言 ─▶ ① 结构化（LLM 展开成 REQUIREMENT.md 草稿）
 *             ─▶ ② 人工确认闸（confirm 回调；拒绝即中止）
 *             ─▶ ③ 生成 rule.ts + rule.test.ts
 *             ─▶ ④ 机器校验管道（validate.ts；失败喂回 LLM 修复，≤ maxRepairs 轮；
 *                  仍失败 → 整夹移入 rules/_rejected/ 附 FAILURE.md，不注册）
 *             ─▶ ⑤ 注册 diff（index.ts / README.md / CHAIN.md；写文件但不提交，
 *                  git review 是人的事）
 *
 * 第二模式 --from-requirement：从既有 REQUIREMENT.md 重新生成实现（改需求 →
 * 重新投影代码），跳过 ①②。
 *
 * 可测性：llm 与 exec 全部注入（离线单测用 fake）；文件写入是唯一副作用，
 * 集中在 writeRuleFolder / moveToRejected 两个函数里。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ChatClient } from '../gate-client.js';
import type { InterventionRule } from '../contract.js';
import {
  buildGenerateMessages,
  buildRepairMessages,
  buildStructureMessages,
  parseGeneratedCode,
} from './prompts.js';
import { renderChainRegistration, renderIndexRegistration, renderReadmeRegistration, ruleFolderName } from './register.js';
import { parseRequirement, RequirementParseError, type RuleRequirement } from './template.js';
import { validateRule, type Executor } from './validate.js';

export interface GenPipelineDeps {
  llm: ChatClient;
  /** 人工确认闸：展示 REQUIREMENT.md 草稿，返回 true 才继续 */
  confirm: (draft: string) => Promise<boolean>;
  exec: Executor;
  projectRoot: string;
  /** 已注册规则（冲突检查）；CLI 传 RULE_REGISTRY 的扁平化 */
  registered: readonly InterventionRule[];
  log?: (msg: string) => void;
  maxRepairs?: number;
  now?: () => number;
  /** 新规则所属期数（写进 README 清单；默认 P2） */
  phase?: string;
}

export type GenResult =
  | { ok: true; folder: string; requirement: RuleRequirement; touchedFiles: string[] }
  | { ok: false; reason: string; rejectedDir?: string };

export async function generateRule(
  requirement: string,
  deps: GenPipelineDeps,
): Promise<GenResult> {
  const log = deps.log ?? (() => {});

  // ① 结构化：自然语言 → REQUIREMENT.md 草稿
  log('① 结构化需求（LLM 展开为 REQUIREMENT.md 草稿）…');
  const draftRaw = await deps.llm.complete(
    buildStructureMessages({ requirement, existingRules: describeRegistered(deps.registered) }),
  );
  let requirementData: RuleRequirement;
  try {
    requirementData = parseRequirement(draftRaw);
  } catch (error) {
    if (error instanceof RequirementParseError) {
      return { ok: false, reason: `LLM 产出的需求草稿结构不完整：${error.message}` };
    }
    throw error;
  }

  // ② 人工确认闸
  const draft = normalizeRequirementDoc(draftRaw);
  const confirmed = await deps.confirm(draft);
  if (!confirmed) return { ok: false, reason: '用户放弃了需求草稿（人工确认闸）' };

  return produce(requirementData, draft, deps);
}

/** --from-requirement：从既有需求文档重新生成实现（跳过 ①②）。 */
export async function regenerateRule(
  ruleDir: string,
  deps: GenPipelineDeps,
): Promise<GenResult> {
  const md = readFileSync(join(ruleDir, 'REQUIREMENT.md'), 'utf8');
  const requirementData = parseRequirement(md);
  return produce(requirementData, md, {
    ...deps,
    // 自己不算冲突；允许覆盖既有文件夹（注册 diff 幂等：已注册则跳过）
    registered: deps.registered.filter((r) => r.name !== requirementData.frontmatter.rule),
  }, true);
}

// ---------------------------------------------------------------------------

async function produce(
  requirementData: RuleRequirement,
  requirementMd: string,
  deps: GenPipelineDeps,
  allowExisting = false,
): Promise<GenResult> {
  const log = deps.log ?? (() => {});
  const maxRepairs = deps.maxRepairs ?? 3;
  const rulesDir = join(deps.projectRoot, 'src', 'intervention', 'rules');
  const folder = ruleFolderName(requirementData.frontmatter.order, requirementData.frontmatter.rule);
  const ruleDir = join(rulesDir, folder);

  if (existsSync(ruleDir) && !allowExisting) {
    return { ok: false, reason: `规则文件夹已存在：${folder}（改需求请用 --from-requirement）` };
  }

  // ③ 生成（含修复循环）
  const contractSource = readFileSync(
    join(deps.projectRoot, 'src', 'intervention', 'contract.ts'),
    'utf8',
  );
  const exampleDir = join(rulesDir, '01-master-switch');
  const example = {
    requirement: readFileSync(join(exampleDir, 'REQUIREMENT.md'), 'utf8'),
    rule: readFileSync(join(exampleDir, 'rule.ts'), 'utf8'),
    test: readFileSync(join(exampleDir, 'rule.test.ts'), 'utf8'),
  };

  let code = parseGeneratedCode(
    await deps.llm.complete(
      buildGenerateMessages({
        requirementMd,
        contractSource,
        exampleRequirement: example.requirement,
        exampleRule: example.rule,
        exampleTest: example.test,
      }),
    ),
  );
  log('③ 已生成 rule.ts / rule.test.ts 初稿，进入机器校验管道');

  // 写入文件夹（校验在其上进行）
  writeRuleFolder(ruleDir, requirementMd, code.ruleTs, code.testTs);

  // ④ 校验 + 修复循环
  let failures: string[] = [];
  for (let round = 0; round <= maxRepairs; round += 1) {
    const result = await validateRule({
      projectRoot: deps.projectRoot,
      ruleDir,
      ruleDirRelative: join('src', 'intervention', 'rules', folder),
      registered: deps.registered,
      exec: deps.exec,
    });
    if (result.ok) {
      log(`④ 校验通过（第 ${round + 1} 轮）`);
      // ⑤ 注册 diff（幂等：--from-requirement 重生成已注册规则时跳过）
      const touched = registerRule(deps.projectRoot, requirementData, deps.phase ?? 'P2');
      if (touched.length > 0) {
        log(`⑤ 已写入注册 diff：${touched.join('、')}`);
        log('生成器不提交——请 git diff 审查后自行提交。');
      }
      return { ok: true, folder, requirement: requirementData, touchedFiles: touched };
    }
    failures = result.failures;
    if (round === maxRepairs) break;
    log(`④ 第 ${round + 1} 轮校验未过（${failures.length} 项），喂回 LLM 修复…`);
    code = parseGeneratedCode(await deps.llm.complete(
      buildRepairMessages({
        requirementMd,
        ruleTs: code.ruleTs,
        testTs: code.testTs,
        failures,
      }),
    ));
    writeRuleFolder(ruleDir, requirementMd, code.ruleTs, code.testTs);
  }

  // 仍失败：整夹移入 _rejected/，附失败报告，不注册
  const rejectedDir = join(
    rulesDir,
    '_rejected',
    `${new Date((deps.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-')}-${folder}`,
  );
  mkdirSync(join(rulesDir, '_rejected'), { recursive: true });
  renameSync(ruleDir, rejectedDir);
  writeFileSync(
    join(rejectedDir, 'FAILURE.md'),
    `# 生成失败报告\n\n校验管道在 ${maxRepairs + 1} 轮后仍未通过：\n\n${failures
      .map((f) => `- ${f}`)
      .join('\n')}\n`,
    'utf8',
  );
  return {
    ok: false,
    reason: `校验管道 ${maxRepairs + 1} 轮后仍未通过，已移入 ${rejectedDir}`,
    rejectedDir,
  };
}

function writeRuleFolder(ruleDir: string, requirementMd: string, ruleTs: string, testTs: string): void {
  mkdirSync(ruleDir, { recursive: true });
  writeFileSync(join(ruleDir, 'REQUIREMENT.md'), requirementMd, 'utf8');
  writeFileSync(join(ruleDir, 'rule.ts'), ruleTs, 'utf8');
  writeFileSync(join(ruleDir, 'rule.test.ts'), testTs, 'utf8');
}

/** 注册 diff：index.ts + README.md + CHAIN.md（写文件，不提交；已注册则跳过）。 */
function registerRule(projectRoot: string, req: RuleRequirement, phase: string): string[] {
  const touched: string[] = [];
  const rulesDir = join(projectRoot, 'src', 'intervention', 'rules');
  const folder = ruleFolderName(req.frontmatter.order, req.frontmatter.rule);

  const indexPath = join(rulesDir, 'index.ts');
  const indexSource = readFileSync(indexPath, 'utf8');
  if (indexSource.includes(`'./${folder}/rule.js'`)) return touched; // 已注册，幂等跳过
  writeFileSync(indexPath, renderIndexRegistration(indexSource, req), 'utf8');
  touched.push('src/intervention/rules/index.ts');

  const readmePath = join(rulesDir, 'README.md');
  writeFileSync(
    readmePath,
    renderReadmeRegistration(readFileSync(readmePath, 'utf8'), req, phase),
    'utf8',
  );
  touched.push('src/intervention/rules/README.md');

  const chainPath = join(rulesDir, 'CHAIN.md');
  writeFileSync(chainPath, renderChainRegistration(readFileSync(chainPath, 'utf8'), req), 'utf8');
  touched.push('src/intervention/rules/CHAIN.md');

  return touched;
}

function describeRegistered(registered: readonly InterventionRule[]): string {
  if (registered.length === 0) return '（尚无已注册规则）';
  return registered
    .map((r) => `- ${String(r.order).padStart(2, '0')}-${r.name}（${r.stage}）`)
    .join('\n');
}

/** 结构化步的草稿规范化：剥掉 LLM 可能加的 md 围栏。 */
function normalizeRequirementDoc(raw: string): string {
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)```\s*$/.exec(raw.trim());
  return (fenced?.[1] ?? raw).trim() + '\n';
}
