/**
 * 规则链 runner：把同一 stage 的规则按 order 一层一层执行，拦截即短路。
 *
 * runner 本身不做任何判定——所有判定都在规则里；它只负责：
 *   - 逐层调用 evaluate，累积 marks；
 *   - halt / defer 短路并记录 reason；
 *   - 规则抛错按 fail-closed 处理（视为 halt('rule-error')），绝不让一条
 *     坏规则击穿整条链；
 *   - 产出逐层 trace（`01✓02✓05✗halt(at-others)`）——日志读起来就是规则清单，
 *     这是「规则可读性」在运行期的兑现（方案 §5.4）。
 *
 * 规则可被配置单独停用（enabled:false → 该层恒 pass，trace 记 `−`）。
 */

import type {
  InterventionRule,
  RuleContext,
  RuleMarks,
  RuleParamValue,
  RuleVerdict,
} from './contract.js';

export interface ChainTraceStep {
  /** 规则名（与文件夹一致） */
  rule: string;
  /** 编号前缀（trace 里显示用） */
  order: number;
  action: RuleVerdict['action'] | 'skip';
  reason?: string;
}

export interface ChainResult {
  /** passed = 全层通过；halted = 被某层拦截；deferred = 某层要求延迟重查 */
  outcome: 'passed' | 'halted' | 'deferred';
  haltedBy?: string;
  reason?: string;
  deferMs?: number;
  marks: RuleMarks;
  trace: ChainTraceStep[];
}

/** 每条规则的参数解析器：默认值 ∪ 全局注入 ∪ 配置覆盖（由 watcher 提供）。 */
export type ParamsResolver = (
  rule: InterventionRule,
) => Readonly<Record<string, RuleParamValue>>;

/** 判断某条规则是否被配置停用。 */
export type EnabledProbe = (rule: InterventionRule) => boolean;

/** 链上下文里「不属于任何单条规则」的部分（watcher 每次执行时构造）。 */
export type ChainBaseContext = Omit<RuleContext, 'params'>;

/**
 * 依序执行一条链。rules 必须已按 order 升序（注册表负责；这里防御性再排一次
 * 会掩盖注册表与 CHAIN.md 的不一致——所以**不排序**，顺序错误由链冒烟测试暴露）。
 */
export async function runChain(
  rules: readonly InterventionRule[],
  base: ChainBaseContext,
  resolveParams: ParamsResolver,
  isEnabled: EnabledProbe,
): Promise<ChainResult> {
  const marks: RuleMarks = {};
  const trace: ChainTraceStep[] = [];

  for (const rule of rules) {
    if (!isEnabled(rule)) {
      trace.push({ rule: rule.name, order: rule.order, action: 'skip' });
      continue;
    }
    let verdict: RuleVerdict;
    try {
      verdict = await rule.evaluate({ ...base, marks: { ...marks }, params: resolveParams(rule) });
    } catch (error) {
      // fail-closed：规则抛错 = 该层拦截。错误详情进日志（watcher 负责），
      // trace 里只留可读的 reason。
      verdict = { action: 'halt', reason: 'rule-error' };
      trace.push({ rule: rule.name, order: rule.order, action: 'halt', reason: 'rule-error' });
      return {
        outcome: 'halted',
        haltedBy: rule.name,
        reason: `rule-error: ${error instanceof Error ? error.message : String(error)}`,
        marks,
        trace,
      };
    }

    switch (verdict.action) {
      case 'pass':
        trace.push({ rule: rule.name, order: rule.order, action: 'pass' });
        break;
      case 'mark':
        Object.assign(marks, verdict.marks);
        trace.push({ rule: rule.name, order: rule.order, action: 'mark' });
        break;
      case 'defer':
        trace.push({ rule: rule.name, order: rule.order, action: 'defer', reason: verdict.reason });
        return {
          outcome: 'deferred',
          haltedBy: rule.name,
          reason: verdict.reason,
          deferMs: verdict.ms,
          marks,
          trace,
        };
      case 'halt':
        trace.push({ rule: rule.name, order: rule.order, action: 'halt', reason: verdict.reason });
        return {
          outcome: 'halted',
          haltedBy: rule.name,
          reason: verdict.reason,
          marks,
          trace,
        };
    }
  }
  return { outcome: 'passed', marks, trace };
}

/**
 * 把 trace 渲染成一行紧凑文本：`01✓02−05✗halt(at-others)`。
 * 符号：✓ 放行、◦ 标注、… 延迟、✗ 拦截、− 停用跳过。
 */
export function formatTrace(trace: readonly ChainTraceStep[]): string {
  return trace
    .map((step) => {
      const nn = String(step.order).padStart(2, '0');
      switch (step.action) {
        case 'pass':
          return `${nn}✓`;
        case 'mark':
          return `${nn}◦`;
        case 'skip':
          return `${nn}−`;
        case 'defer':
          return `${nn}…(${step.reason ?? ''})`;
        case 'halt':
          return `${nn}✗(${step.reason ?? ''})`;
      }
    })
    .join('');
}
