/**
 * 话题介入的拦截器契约（规则层的唯一接缝）。
 *
 * 设计纪律（docs/TOPIC-INTERVENTION-PLAN.md §5.1，生成器的静态校验据此实现）：
 *   1. 需求即真相源：每条规则对应 rules/<NN-name>/REQUIREMENT.md，代码是它的投影；
 *   2. 规则是纯的：evaluate 不做 IO、不读墙上时钟（只能用 ctx.now）、不用随机数、
 *      不持有定时器；一切副作用（缓冲写入、调度、LLM 调用、turn 投递）归 runner；
 *   3. 一条规则只做一层判定：裁决只有 pass / mark / defer / halt 四种。
 *
 * 规则文件夹永不 import runner；runner 经 rules/index.ts 的静态注册表 import 规则，
 * 依赖单向。
 */

import type { NormalizedObservedMessage } from '../core/connector.js';
import type { ConversationStateView } from './state.js';

/** 规则所属链：续聊晋升 → 入站预筛 → 语义评估 → 发言否决（按消息生命周期排序）。 */
export type RuleStage = 'continuation' | 'intake' | 'evaluate' | 'speak';

/** 上游规则写入的标注位（下游规则与 runner 据此决策）。 */
export interface RuleMarks {
  /** 强介入信号（09–12 号规则写入；见各自 REQUIREMENT.md） */
  strongSignal?: 'quick-reply' | 'quote-bot' | 'open-question' | 'keyword-echo';
  /** 采样计数达标（13 号规则写入） */
  samplingHit?: boolean;
  /** 语义 Gate 的裁决（20 号规则写入；silent 表达为 halt 不进 marks） */
  gateDecision?: 'speak' | 'wait';
  /**
   * 续聊窗口内合格、应晋升为正常提问（40 号规则写入）。
   * runner 据此把消息还原成 NormalizedMessage（origin:'continuation'）回投编排层；
   * 没有此标注的链放行 ≠ 晋升（落回 intake 链按普通旁听处理）。
   */
  promote?: boolean;
  /**
   * turn 在途，晋升转入 pending 合并队列而不是立即回投（41 号规则写入；
   * 与 promote 同时出现，runner 决定入队还是直投）。
   */
  merge?: boolean;
}

/** 规则裁决：四种，且只有四种。 */
export type RuleVerdict =
  /** 放行，进入下一层 */
  | { action: 'pass' }
  /** 标注后继续（强信号类规则） */
  | { action: 'mark'; marks: Partial<RuleMarks> }
  /** 延迟重查（答案窗口到期 / Gate 判 wait），runner 负责排定时器 */
  | { action: 'defer'; ms: number; reason: string }
  /**
   * 拦截，链在此短路；reason 进 trace 日志与统计。
   * `buffer: true` 表示「不评估，但仍入旁听缓冲做上下文」（05/06 号规则用；
   * 缺省 = 完全丢弃，连缓冲都不进——01/02 的隐私语义）。
   */
  | { action: 'halt'; reason: string; buffer?: boolean };

/** 链执行的触发来源（answer-window 重入时 ctx.message 携带原始问句；debounce /
 *  gate-wait-recheck 触发时 ctx.message 为空）。 */
export type RuleTrigger = 'message' | 'debounce' | 'answer-window' | 'gate-wait-recheck';

/** 规则参数值：只允许标量（frontmatter 声明默认值，qqbot.yml 按规则名覆盖）。 */
export type RuleParamValue = number | string | boolean;

/** 语义 Gate 的判定结果（gate-client 与 20 号规则共用）。 */
export interface GateVerdict {
  decision: 'speak' | 'wait' | 'silent';
  /** 简短理由（进 debug 日志与 trace） */
  reason: string;
}

/**
 * 语义 Gate 能力接口。runner 持有真实实现（gate-client.ts）并注入
 * evaluate 链；测试注入 fake。规则文件夹不直接 import gate-client。
 */
export interface GateClient {
  judge(input: GateJudgeInput): Promise<GateVerdict>;
}

export interface GateJudgeInput {
  /** 边界标记包裹的近期群聊转录（transcript.ts 渲染） */
  transcript: string;
  /** bot 状态块（距上次发言、近期介入次数、时段、活跃度等，已渲染成文本） */
  stateSummary: string;
  /**
   * 判定标准正文：来自 20 号规则的 REQUIREMENT.md 投影（params.criteria），
   * 需求即 prompt（方案 §5.6）；输出契约段由客户端固定拼接，不在需求文档里。
   */
  criteria: string;
}

export interface RuleContext {
  /** 触发本次链执行的消息；定时器触发（trigger ≠ 'message'）时为空 */
  readonly message: NormalizedObservedMessage | undefined;
  readonly trigger: RuleTrigger;
  /** 该群共享状态的只读视图（缓冲、去重查询、运行期开关……） */
  readonly state: ConversationStateView;
  /** 本链上游规则写入的标注位（逐层累积） */
  readonly marks: RuleMarks;
  /**
   * 本规则的生效参数：REQUIREMENT.md frontmatter 声明的默认值
   * ∪ 全局注入（如 master-switch 的 enabled 来自 intervention.enabled）
   * ∪ qqbot.yml 的 intervention.rules.<name>.params 覆盖。
   */
  readonly params: Readonly<Record<string, RuleParamValue>>;
  /** 注入时钟；规则禁止用 Date.now() */
  readonly now: number;
  /** 语义 Gate 能力（仅 evaluate 链注入） */
  readonly gate?: GateClient;
  /** 惰性转录：需要时才渲染，被拦截的消息不付渲染成本 */
  readonly transcript?: () => string;
  /** 惰性 bot 状态块（同 transcript，仅 evaluate 链注入） */
  readonly stateSummary?: () => string;
  /**
   * 当前是否谷时段（03 号规则用；runner 每次链执行时从注入探针计算，
   * undefined = 无探针，规则按「不拦」放行——@ 路径的谷时段闸不受影响）。
   */
  readonly offpeakNow?: boolean;
  /**
   * 全局并发是否还有名额（32 号规则用；runner 在 speak 链执行前从准入闸门
   * 探测，真正的原子 try 仍在 runner 侧完成）。
   */
  readonly admissionFree?: boolean;
}

/** 一条介入规则。name/stage/order 必须与 REQUIREMENT.md frontmatter 一致。 */
export interface InterventionRule {
  /** 规则名 = 文件夹名后缀（如 'at-others'） */
  readonly name: string;
  readonly stage: RuleStage;
  /** 链内执行顺序 = 文件夹编号前缀 */
  readonly order: number;
  /** 参数默认值（frontmatter 的 params 段）；无参数的规则省略 */
  readonly paramsSpec?: Readonly<Record<string, RuleParamValue>>;
  evaluate(ctx: RuleContext): RuleVerdict | Promise<RuleVerdict>;
}
