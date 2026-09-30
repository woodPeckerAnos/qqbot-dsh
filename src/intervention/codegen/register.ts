/**
 * 注册器：把新规则写进 rules/index.ts、README.md 清单、CHAIN.md 成员行。
 *
 * 全部是纯文本变换（纯函数，可单测）。生成器写文件但不提交——注册 diff
 * 必须经人审入 git（方案 §5.7 闸 ⑤）。
 */

import type { RuleRequirement } from './template.js';

/** 把 kebab-case 规则名转成注册表里的标识符（master-switch → masterSwitch）。 */
export function ruleIdentifier(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/** 规则文件夹名（NN-name）。 */
export function ruleFolderName(order: number, name: string): string {
  return `${String(order).padStart(2, '0')}-${name}`;
}

/** 在 index.ts 里注册：加一行 import + 插入对应 stage 的链数组（按 order 升序）。 */
export function renderIndexRegistration(source: string, req: RuleRequirement): string {
  const folder = ruleFolderName(req.frontmatter.order, req.frontmatter.rule);
  const ident = ruleIdentifier(req.frontmatter.rule);

  // import 行：插到最后一条规则 import 之后
  const importLine = `import { rule as ${ident} } from './${folder}/rule.js';`;
  const importMatches = [...source.matchAll(/^import \{ rule as \w+ \} from '\.\/.+';\n/gm)];
  if (importMatches.length === 0) {
    throw new Error('rules/index.ts 里找不到规则 import 行，注册表格式已漂移，请手工注册');
  }
  const lastImport = importMatches[importMatches.length - 1]!;
  let out =
    source.slice(0, lastImport.index! + lastImport[0].length) +
    `${importLine}\n` +
    source.slice(lastImport.index! + lastImport[0].length);

  // 链数组：`  intake: [masterSwitch, groupWhitelist],` 形态（可跨行）
  const stagePattern = new RegExp(`(  ${req.frontmatter.stage}: \\[)([\\s\\S]*?)(\\],)`);
  const stageMatch = stagePattern.exec(out);
  if (stageMatch === null) {
    throw new Error(`rules/index.ts 里找不到 ${req.frontmatter.stage} 链数组，请手工注册`);
  }
  const existing = stageMatch[2]!
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (existing.includes(ident)) {
    throw new Error(`规则 ${req.frontmatter.rule} 已在注册表里`);
  }
  // 按 order 升序插入：从 import 行反推每个标识符的 order（NN-name 前缀）
  const orderOf = new Map<string, number>();
  for (const m of out.matchAll(/import \{ rule as (\w+) \} from '\.\/(\d+)-[\w-]+\/rule\.js';/g)) {
    orderOf.set(m[1]!, Number(m[2]));
  }
  existing.push(ident);
  existing.sort((a, b) => (orderOf.get(a) ?? 999) - (orderOf.get(b) ?? 999));
  out = `${out.slice(0, stageMatch.index)}${stageMatch[1]}${existing.join(', ')}${stageMatch[3]}${out.slice(stageMatch.index! + stageMatch[0].length)}`;
  return out;
}

/** 在 README.md 的规则清单表里插入一行（按文件夹编号升序）。 */
export function renderReadmeRegistration(
  source: string,
  req: RuleRequirement,
  phase: string,
): string {
  const folder = ruleFolderName(req.frontmatter.order, req.frontmatter.rule);
  const summary = oneLineSummary(req.description);
  const row = `| \`${folder}\` | ${req.frontmatter.stage} | ${summary} | ${phase} |`;
  const lines = source.split('\n');
  // 清单按编号升序：插到第一个编号更大的行之前；没有更大的就插到表格末尾。
  let tableEnd = -1;
  let insertBefore = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const rowMatch = /^\| (?:\[)?`?(\d+)-[\w-]+/.exec(lines[i]!);
    if (rowMatch === null) continue;
    tableEnd = i;
    if (insertBefore === -1 && Number(rowMatch[1]) > req.frontmatter.order) {
      insertBefore = i;
    }
  }
  if (tableEnd === -1) throw new Error('rules/README.md 里找不到规则清单表，请手工登记');
  const at = insertBefore === -1 ? tableEnd + 1 : insertBefore;
  lines.splice(at, 0, row);
  return lines.join('\n');
}

/** 在 CHAIN.md 对应 stage 的「成员（机器维护）」行里加入新规则。 */
export function renderChainRegistration(source: string, req: RuleRequirement): string {
  const folder = ruleFolderName(req.frontmatter.order, req.frontmatter.rule);
  const lines = source.split('\n');
  // 找到该 stage 标题（如「## ② intake 链」）之后的第一行「成员（机器维护）：」
  const stageHeading = new RegExp(`^## .*${req.frontmatter.stage}\\s*链`);
  let inStage = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (stageHeading.test(lines[i]!)) {
      inStage = true;
      continue;
    }
    if (inStage && lines[i]!.startsWith('## ')) break;
    if (inStage && lines[i]!.startsWith('成员（机器维护）：')) {
      const current = lines[i]!.slice('成员（机器维护）：'.length).trim();
      const members = current === '（空）' || current === '' ? [] : current.split('、');
      if (members.includes(folder)) return source;
      members.push(folder);
      members.sort();
      lines[i] = `成员（机器维护）：${members.join('、')}`;
      return lines.join('\n');
    }
  }
  throw new Error(
    `CHAIN.md 里找不到 ${req.frontmatter.stage} 链的「成员（机器维护）」行，请手工登记`,
  );
}

/** 需求描述 → 清单表的一句话摘要（第一个句号前，最长 40 字）。 */
function oneLineSummary(description: string): string {
  const firstLine = description.split('\n')[0]!.trim();
  const sentence = firstLine.split(/[。！？]/)[0]!.trim();
  return sentence.length > 40 ? `${sentence.slice(0, 40)}…` : sentence;
}
