/**
 * 生成器的机器校验管道（方案 §5.7 闸 ④）。
 *
 * 四步，任一失败即不通过（失败摘要喂回 LLM 修复）：
 *   a. 静态纪律（discipline.ts，纯函数：import 白名单 / 纯度 / 形状 /
 *      验收覆盖 / 与注册表的 order·name 冲突）；
 *   b. tsc --noEmit（全项目，新规则必须在类型层面自洽）；
 *   c. vitest run 该规则文件夹（含本函数临时生成的链冒烟测试，跑完即删）；
 *   d. 冒烟断言（在 c 里执行）：frontmatter ↔ rule 对象一致、规则在链里
 *      可执行且裁决合法。
 *
 * exec 可注入：codegen 自己的单测用假执行器，全程离线。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { InterventionRule } from '../contract.js';
import { checkAcceptanceCoverage, checkRuleSource } from './discipline.js';
import { parseRequirement, RequirementParseError, type RuleRequirement } from './template.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Executor = (cmd: string, args: string[], cwd: string) => Promise<ExecResult>;

export interface ValidationInput {
  projectRoot: string;
  /** 规则文件夹的绝对路径（已写入 REQUIREMENT.md / rule.ts / rule.test.ts） */
  ruleDir: string;
  /** 项目根到 vitest 过滤用的相对路径（如 src/intervention/rules/05-at-others） */
  ruleDirRelative: string;
  /** 已注册规则（order/name 冲突检查） */
  registered: readonly InterventionRule[];
  exec: Executor;
}

export interface ValidationResult {
  ok: boolean;
  failures: string[];
}

export async function validateRule(input: ValidationInput): Promise<ValidationResult> {
  const failures: string[] = [];

  // a. 静态纪律
  const requirementMd = readFileSync(join(input.ruleDir, 'REQUIREMENT.md'), 'utf8');
  const ruleTs = readFileSync(join(input.ruleDir, 'rule.ts'), 'utf8');
  const testTs = readFileSync(join(input.ruleDir, 'rule.test.ts'), 'utf8');

  let requirement: RuleRequirement | undefined;
  try {
    requirement = parseRequirement(requirementMd);
  } catch (error) {
    if (error instanceof RequirementParseError) {
      failures.push(`REQUIREMENT.md 结构不完整：${error.message}`);
    } else {
      throw error;
    }
  }

  if (requirement !== undefined) {
    const fm = requirement.frontmatter;
    for (const issue of checkRuleSource(ruleTs, fm)) {
      failures.push(`静态纪律[${issue.check}]：${issue.detail}`);
    }
    for (const issue of checkAcceptanceCoverage(testTs, requirement.acceptance.length)) {
      failures.push(`静态纪律[${issue.check}]：${issue.detail}`);
    }
    for (const existing of input.registered) {
      if (existing.name === fm.rule) {
        failures.push(`注册冲突：规则名 '${fm.rule}' 已被注册`);
      }
      if (existing.stage === fm.stage && existing.order === fm.order) {
        failures.push(
          `注册冲突：${fm.stage} 链的 order ${fm.order} 已被 '${existing.name}' 占用`,
        );
      }
    }
  }

  if (failures.length > 0) return { ok: false, failures };

  // b. tsc
  const tsc = await input.exec(
    './node_modules/.bin/tsc',
    ['-p', 'tsconfig.json', '--noEmit'],
    input.projectRoot,
  );
  if (tsc.code !== 0) {
    failures.push(`tsc 类型检查失败：\n${(tsc.stdout + tsc.stderr).slice(0, 2000)}`);
    return { ok: false, failures };
  }

  // c + d. vitest（含临时链冒烟测试，跑完即删）
  const smokePath = join(input.ruleDir, '.codegen-smoke.test.ts');
  writeFileSync(smokePath, renderSmokeTest(), 'utf8');
  try {
    const vitest = await input.exec(
      './node_modules/.bin/vitest',
      ['run', input.ruleDirRelative],
      input.projectRoot,
    );
    if (vitest.code !== 0) {
      failures.push(`vitest 失败：\n${(vitest.stdout + vitest.stderr).slice(0, 2000)}`);
    }
  } finally {
    rmSync(smokePath, { force: true });
  }

  return { ok: failures.length === 0, failures };
}

/** 链冒烟测试（临时文件，随校验生成、跑完删除）。 */
function renderSmokeTest(): string {
  return `/**
 * 生成器临时冒烟测试（校验管道自动生成，跑完即删；不要手工编辑）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runChain } from '../../chain.js';
import { parseRequirement } from '../../codegen/template.js';
import { ConversationWatchState } from '../../state.js';
import { rule } from './rule.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('codegen 冒烟', () => {
  it('rule 对象与 REQUIREMENT.md frontmatter 一致', () => {
    const req = parseRequirement(readFileSync(join(here, 'REQUIREMENT.md'), 'utf8'));
    expect(rule.name).toBe(req.frontmatter.rule);
    expect(rule.stage).toBe(req.frontmatter.stage);
    expect(rule.order).toBe(req.frontmatter.order);
  });

  it('规则在链里可执行（合成消息，裁决合法、不抛错）', async () => {
    const state = new ConversationWatchState('ob11:g-smoke', {
      maxMessages: 10,
      maxAgeMs: 60_000,
    });
    const result = await runChain(
      [rule],
      {
        message: {
          kind: 'group-message-observed',
          target: { platform: 'onebot', kind: 'group', id: 'smoke', key: 'ob11:g-smoke' },
          eventId: 'smoke:1',
          msgId: '1',
          senderId: '42',
          content: '冒烟消息',
          atOthers: false,
          ts: 1_000_000,
          raw: {},
        },
        trigger: 'message',
        state,
        marks: {},
        now: 1_000_000,
      },
      (r) => ({ ...(r.paramsSpec ?? {}) }),
      () => true,
    );
    expect(['passed', 'halted', 'deferred']).toContain(result.outcome);
  });
});
`;
}

/** 供 CLI 使用的真实执行器（child_process.spawn，无 shell）。 */
export function createRealExecutor(): Executor {
  return async (cmd, args, cwd) => {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  };
}
