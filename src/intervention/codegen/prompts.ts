/**
 * 生成器的 LLM prompt 构造（纯函数，便于单测与审阅）。
 *
 * 三个 prompt 对应管道的三步：
 *   ① structure：自然语言 → REQUIREMENT.md 草稿（真相源，先过人工确认闸）；
 *   ③ generate：REQUIREMENT.md → rule.ts + rule.test.ts（需求的投影）；
 *   ④ repair：校验失败 → 带着失败摘要重新生成（≤3 轮）。
 *
 * 输出契约刻意简单：结构化步输出一份完整 Markdown；生成步输出恰好两个
 * ```ts 围栏块（rule.ts 在前，rule.test.ts 在后）。
 */

import type { ChatMessage } from '../gate-client.js';

const TEMPLATE_GUIDE = `
REQUIREMENT.md 的固定结构（必须严格遵守）：

1. YAML frontmatter（--- 包裹）：
   rule: 小写 kebab-case 规则名（如 at-others）
   stage: continuation | intake | evaluate | speak
   order: 正整数（链内执行顺序；intake 用 5-19，evaluate 用 20-29，speak 用 30-39，continuation 用 40-49；避开已占用的编号）
   params: 参数数组（每项 { name, default, meaning }；无参数写 params: []）
   stats: 拦截计数的统计键（如 halt_at_others）
2. 正文六个固定小节（# 一级标题，顺序固定）：
   # 原始需求 —— 逐字保留输入的自然语言，一个字都不改
   # 需求描述 —— 什么情况下、做什么判断、产生什么结果（一段人话）
   # 判定 —— 输入 / 各条件 → 动作（pass|mark|defer|halt + reason）
   # 参数 —— 表格：名字 | 默认值 | 含义（无参数写「无。」）
   # 验收标准 —— 有序列表（1. … 2. …），每条必须可离线断言（不触网、不依赖时间流逝；时间条件用注入时钟表达）
   # 背景与调研来源 —— 为什么需要这条规则
`.trim();

export function buildStructureMessages(input: {
  requirement: string;
  existingRules: string; // 已注册规则的「编号-名字: 一句话」清单（避免编号/职责冲突）
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是 QQ 群机器人「话题介入规则」的需求工程师。把用户的一句自然语言需求，',
        '严格展开成一份 REQUIREMENT.md（规则文件夹的真相源）。',
        '',
        TEMPLATE_GUIDE,
        '',
        '硬性要求：',
        '- 只输出 REQUIREMENT.md 全文，不要输出任何其他内容；',
        '- 「原始需求」小节逐字保留用户输入；',
        '- 验收标准必须逐条可离线断言（纯函数级），每条能直接翻译成单测；',
        '- 判定动作只能是 pass / mark / defer / halt（halt 必须带小写 kebab reason）；',
        '- 一条规则只做一层判定；需要共享状态（相位、限流窗口）的需求要在需求描述里',
        '  说明它读取什么状态，而不是自己持有状态。',
        '',
        '已注册的规则（避免职责与编号冲突）：',
        input.existingRules,
      ].join('\n'),
    },
    { role: 'user', content: input.requirement },
  ];
}

export function buildGenerateMessages(input: {
  requirementMd: string;
  contractSource: string;
  exampleRequirement: string;
  exampleRule: string;
  exampleTest: string;
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是 QQ 群机器人「话题介入规则」的实现工程师。根据一份 REQUIREMENT.md，',
        '生成它的实现与单测——代码是需求的投影，逐条对应「判定」与「验收标准」。',
        '',
        '拦截器契约（contract.ts 全文）：',
        '```ts',
        input.contractSource,
        '```',
        '',
        '纪律（静态校验会机器检查）：',
        '- rule.ts 只允许 import ../../contract.js；',
        '- 禁止 Date.now / new Date / Math.random / setTimeout / setInterval / setImmediate',
        '  / fetch / require / process.* / globalThis.*——时间用 ctx.now，参数用 ctx.params；',
        '- 必须 export const rule: InterventionRule，name/stage/order 与 frontmatter 一致；',
        '- frontmatter 声明了 params 就必须有对应的 paramsSpec；',
        '- fail-closed：输入缺失或判定不了的情形一律 halt；',
        '- rule.test.ts 必须为每条验收标准写一个用例，测试名含「验收N」编号；',
        '  再加一个「契约：name/stage/order 与 frontmatter 一致」用例；',
        '- 测试用 vitest，状态用 new ConversationWatchState(key, { maxMessages, maxAgeMs })',
        '  构造（见示例），不 import vitest 以外的东西。',
        '',
        '示例规则文件夹（01-master-switch，照它的形态写）：',
        '【REQUIREMENT.md】',
        input.exampleRequirement,
        '【rule.ts】',
        input.exampleRule,
        '【rule.test.ts】',
        input.exampleTest,
        '',
        '输出契约：恰好两个 ```ts 围栏块——第一个是 rule.ts，第二个是 rule.test.ts，',
        '不要输出任何其他内容。',
      ].join('\n'),
    },
    { role: 'user', content: input.requirementMd },
  ];
}

export function buildRepairMessages(input: {
  requirementMd: string;
  ruleTs: string;
  testTs: string;
  failures: string[];
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '上次生成的介入规则没有通过机器校验。根据失败摘要修复，纪律与输出契约不变：',
        '恰好两个 ```ts 围栏块（rule.ts 在前，rule.test.ts 在后），无其他内容。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '【REQUIREMENT.md】',
        input.requirementMd,
        '【当前的 rule.ts】',
        input.ruleTs,
        '【当前的 rule.test.ts】',
        input.testTs,
        '【校验失败摘要】',
        input.failures.join('\n'),
      ].join('\n\n'),
    },
  ];
}

/** 从生成输出里提取两个 ts 围栏块（rule.ts / rule.test.ts）。不足两块抛错。 */
export function parseGeneratedCode(raw: string): { ruleTs: string; testTs: string } {
  const blocks = [...raw.matchAll(/```ts\s*\n([\s\S]*?)```/g)].map((m) => m[1]!.trim());
  if (blocks.length !== 2) {
    throw new Error(`生成输出应含恰好两个 \`\`\`ts 块（rule.ts / rule.test.ts），实得 ${blocks.length} 个`);
  }
  return { ruleTs: blocks[0]!, testTs: blocks[1]! };
}
