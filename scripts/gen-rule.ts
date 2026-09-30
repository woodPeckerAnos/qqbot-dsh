/**
 * 规则生成口 CLI（方案 §5.7）。
 *
 * 用法：
 *   npm run gen:rule -- "群里有人提问且 90 秒无人应答时，bot 可以回答"
 *   npm run gen:rule -- --from-requirement src/intervention/rules/11-strong-open-question
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY（或 GEN_RULE_API_KEY）  必填，LLM 密钥
 *   GEN_RULE_API_BASE                        默认 https://api.deepseek.com
 *   GEN_RULE_MODEL                           默认 deepseek-flash（与 dsh 默认模型一致）
 *
 * 管道：① LLM 结构化需求 → ② 人工确认草稿 → ③ 生成实现与单测 →
 * ④ 机器校验（静态纪律 → tsc → vitest + 链冒烟；失败喂回修复 ≤3 轮，
 * 仍失败移入 rules/_rejected/）→ ⑤ 注册 diff（不提交，git 人审）。
 */

import { createInterface } from 'node:readline/promises';

import { createChatClient } from '../src/intervention/gate-client.js';
import { generateRule, regenerateRule } from '../src/intervention/codegen/pipeline.js';
import { createRealExecutor } from '../src/intervention/codegen/validate.js';
import { RULE_REGISTRY } from '../src/intervention/rules/index.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fromRequirement = args[0] === '--from-requirement' ? args[1] : undefined;
  const requirement = fromRequirement === undefined ? args.join(' ').trim() : undefined;

  if (fromRequirement === undefined && (requirement === undefined || requirement === '')) {
    process.stderr.write(
      '用法：npm run gen:rule -- "<自然语言需求>"\n' +
        '      npm run gen:rule -- --from-requirement <规则文件夹>\n',
    );
    process.exit(2);
  }

  const apiKey = process.env['GEN_RULE_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    process.stderr.write('缺少 DEEPSEEK_API_KEY（或 GEN_RULE_API_KEY）——生成器需要 LLM。\n');
    process.exit(2);
  }

  const llm = createChatClient({
    apiBase: process.env['GEN_RULE_API_BASE'] ?? 'https://api.deepseek.com',
    apiKey,
    model: process.env['GEN_RULE_MODEL'] ?? 'deepseek-flash',
    timeoutMs: 120_000,
  });

  const registered = [
    ...RULE_REGISTRY.continuation,
    ...RULE_REGISTRY.intake,
    ...RULE_REGISTRY.evaluate,
    ...RULE_REGISTRY.speak,
  ];

  const confirm = async (draft: string): Promise<boolean> => {
    process.stdout.write(`\n────────── REQUIREMENT.md 草稿 ──────────\n${draft}\n────────────────────────────────────────\n`);
    // 管道输入（echo y | …）：stdin 可能在提问前已到 EOF 触发 close，
    // readline.question 会抛 ERR_USE_AFTER_CLOSE——直接读全量 stdin。
    if (!process.stdin.isTTY) {
      let data = '';
      for await (const chunk of process.stdin) data += String(chunk);
      process.stdout.write(`确认这份需求草稿？[y/N] ${data.trim()}\n`);
      return data.trim().toLowerCase() === 'y';
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question('确认这份需求草稿？[y/N] ');
      return answer.trim().toLowerCase() === 'y';
    } finally {
      rl.close();
    }
  };

  try {
    const deps = {
      llm,
      confirm,
      exec: createRealExecutor(),
      projectRoot: process.cwd(),
      registered,
      log: (msg: string) => process.stdout.write(`[gen-rule] ${msg}\n`),
    };
    const result =
      fromRequirement !== undefined
        ? await regenerateRule(fromRequirement, deps)
        : await generateRule(requirement!, deps);

    if (!result.ok) {
      process.stderr.write(`\n生成失败：${result.reason}\n`);
      process.exit(1);
    }
    process.stdout.write(`\n✔ 规则已生成并通过校验：src/intervention/rules/${result.folder}/\n`);
    if (result.touchedFiles.length > 0) {
      process.stdout.write(`注册 diff 已写入：${result.touchedFiles.join('、')}\n请 git diff 审查后提交。\n`);
    }
  } finally {
    // 交互式 readline 已在 confirm 内部按需创建与关闭，这里无需收尾
  }
}

void main();
