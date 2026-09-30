/**
 * 规则层一致性守门测试（永驻，CI 每次跑）：
 *   注册表（index.ts）↔ 规则文件夹（NN-name/）↔ REQUIREMENT.md frontmatter
 *   ↔ CHAIN.md 成员行 ↔ README.md 清单表，五者不许漂移。
 *
 * 这是「规则文件夹自包含 + 拦截器链」架构的机器兜底：手写或生成器产出的
 * 规则都过同一套检查（生成器的链冒烟是单次校验，本文件是永驻防线）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseRequirement } from '../src/intervention/codegen/template.js';
import type { RuleStage } from '../src/intervention/contract.js';
import { RULE_REGISTRY } from '../src/intervention/rules/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const rulesDir = join(here, '..', 'src', 'intervention', 'rules');

const STAGES: RuleStage[] = ['continuation', 'intake', 'evaluate', 'speak'];

function registeredRules() {
  return [
    ...RULE_REGISTRY.continuation,
    ...RULE_REGISTRY.intake,
    ...RULE_REGISTRY.evaluate,
    ...RULE_REGISTRY.speak,
  ];
}

describe('规则注册表一致性', () => {
  it('每条已注册规则都有对应文件夹，且 frontmatter 与 rule 对象一致', () => {
    const folders = readdirSync(rulesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+-[\w-]+$/.test(d.name))
      .map((d) => d.name);
    const registered = registeredRules();

    // 双向：注册表 ⊆ 文件夹，文件夹 ⊆ 注册表（_rejected 不是 NN-name 形态，天然排除）
    expect(registered.length).toBe(folders.length);

    for (const rule of registered) {
      const folder = `${String(rule.order).padStart(2, '0')}-${rule.name}`;
      expect(folders, `注册表里的 ${rule.name} 缺文件夹 ${folder}`).toContain(folder);

      const req = parseRequirement(readFileSync(join(rulesDir, folder, 'REQUIREMENT.md'), 'utf8'));
      expect(req.frontmatter.rule).toBe(rule.name);
      expect(req.frontmatter.stage).toBe(rule.stage);
      expect(req.frontmatter.order).toBe(rule.order);
    }
  });

  it('同一条链内 order 严格升序且无冲突', () => {
    for (const stage of STAGES) {
      const orders = RULE_REGISTRY[stage].map((rule) => rule.order);
      const sorted = [...orders].sort((a, b) => a - b);
      expect(orders, `${stage} 链的注册顺序必须按 order 升序`).toEqual(sorted);
      expect(new Set(orders).size, `${stage} 链的 order 不许重复`).toBe(orders.length);
    }
  });

  it('CHAIN.md 的成员行与注册表一致', () => {
    const chain = readFileSync(join(rulesDir, 'CHAIN.md'), 'utf8');
    for (const stage of STAGES) {
      const heading = new RegExp(`## .*${stage} 链[\\s\\S]*?成员（机器维护）：([^\\n]+)`);
      const match = heading.exec(chain);
      expect(match, `CHAIN.md 缺少 ${stage} 链的成员行`).not.toBeNull();
      const members = match![1]!.trim();
      const expected =
        RULE_REGISTRY[stage].length === 0
          ? '（空）'
          : RULE_REGISTRY[stage]
              .map((r) => `${String(r.order).padStart(2, '0')}-${r.name}`)
              .join('、');
      expect(members).toBe(expected);
    }
  });

  it('README.md 清单表覆盖每条已注册规则', () => {
    const readme = readFileSync(join(rulesDir, 'README.md'), 'utf8');
    for (const rule of registeredRules()) {
      const folder = `${String(rule.order).padStart(2, '0')}-${rule.name}`;
      expect(readme, `README 清单缺少 ${folder}`).toContain(folder);
    }
  });
});
