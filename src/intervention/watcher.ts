/**
 * TopicWatcher：话题介入的入口与调度器（runner）。
 *
 * 它是介入层**唯一有副作用的组件**（方案 §5.5）：规则文件夹全是纯函数，
 * 这里负责——
 *   - 持有每群共享状态（state.ts）与规则链（rules/index.ts 注册表）；
 *   - 把 observed 消息喂给 intake 链，逐层触发；
 *   - 链放行后写入旁听缓冲（Phase 0 的终局；评估/发言在 Phase 2 加入）；
 *   - trace 日志与统计。
 *
 * 平台无关：只依赖 core 的 NormalizedObservedMessage，不 import 任何
 * adapters/* 内部实现（与编排层既有纪律一致）。
 *
 * Phase 0 的 intake 链只有三层：01-master-switch / 02-group-whitelist /
 * 04-duplicate-event，终局是「入缓冲」。之后每期就是往链上加规则文件夹。
 */

import type { NormalizedObservedMessage } from '../core/connector.js';
import type { Logger } from '../logger.js';
import type { PipelineStats } from '../pipeline/stats.js';
import { formatTrace, runChain, type ChainResult } from './chain.js';
import type { InterventionRule, RuleParamValue } from './contract.js';
import { ConversationWatchState } from './state.js';

/** 介入层的运行时配置（由 config.ts 产出；见 Config.intervention）。 */
export interface InterventionConfig {
  /** 全局总开关（默认 false，fail-closed；规则 01 消费） */
  enabled: boolean;
  /** 灰度开关：判定照跑、trace 照记、永不发言（Phase 2 生效） */
  dryRun: boolean;
  /** 静态群白名单（来自 BOT_LISTEN_GROUPS，形如 onebot:123456） */
  whitelistGroups: string[];
  buffer: {
    maxMessages: number;
    maxAgeMs: number;
  };
  /** 按规则名的覆盖：enabled 单独停用某层；params 覆盖该规则参数 */
  rules: Record<
    string,
    { enabled?: boolean; params?: Record<string, RuleParamValue> }
  >;
}

/** 规则注册表（rules/index.ts 的形状；按 stage 分链，链内按 order 升序）。 */
export interface RuleRegistry {
  continuation: InterventionRule[];
  intake: InterventionRule[];
  evaluate: InterventionRule[];
  speak: InterventionRule[];
}

/** health / /listen status 用的介入层快照。 */
export interface InterventionSnapshot {
  enabled: boolean;
  dryRun: boolean;
  conversations: Array<{
    key: string;
    buffered: number;
    runtimeEnabled?: boolean;
  }>;
  /** 按规则名的拦截计数（进程期累计） */
  halts: Record<string, number>;
}

export interface TopicWatcherDeps {
  config: InterventionConfig;
  rules: RuleRegistry;
  stats: PipelineStats;
  logger: Logger;
  now?: () => number;
}

export class TopicWatcher {
  private readonly states = new Map<string, ConversationWatchState>();
  /** 按规则名的拦截计数（health 展示用） */
  private readonly halts = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: TopicWatcherDeps) {
    this.now = deps.now ?? Date.now;
    this.assertRegistryKnown();
  }

  /**
   * 入口：一条旁听到的群消息。同步收口、异步执行（P0 的规则全是同步的，
   * 异步形态是为 evaluate 链的 LLM 判定预留）；任何异常只记日志，不外抛
   * （Orchestrator 的「永不抛错」契约延伸到介入层）。
   */
  observe(message: NormalizedObservedMessage): void {
    this.deps.stats.observed += 1;
    const state = this.stateFor(message.target.key);
    void this.runIntake(message, state).catch((error: unknown) => {
      this.deps.logger.warn('介入链执行失败（按不处理）', {
        conversation: message.target.key,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * 一条 @ 消息到达时调用（Orchestrator 在 handleMessage 入口通知）：
   * 官方全量模式下同一 msgId 可能同时以 at/observed 两个事件到达，
   * 把缓冲里对应条目标记 addressed，介入评估跳过它（方案 §12 幂等）。
   */
  markAddressed(conversationKey: string, msgId: string): void {
    this.states.get(conversationKey)?.markAddressed(msgId);
  }

  /** 运行期群开关（/listen on|off，Phase 2 的命令层写入）。 */
  setRuntimeEnabled(conversationKey: string, enabled: boolean): void {
    this.stateFor(conversationKey).runtimeEnabled = enabled;
  }

  /** health / 命令展示用快照。 */
  snapshot(): InterventionSnapshot {
    const conversations: InterventionSnapshot['conversations'] = [];
    for (const [key, state] of this.states) {
      conversations.push({
        key,
        buffered: state.entries.length,
        ...(state.runtimeEnabled !== undefined
          ? { runtimeEnabled: state.runtimeEnabled }
          : {}),
      });
    }
    return {
      enabled: this.deps.config.enabled,
      dryRun: this.deps.config.dryRun,
      conversations,
      halts: Object.fromEntries(this.halts),
    };
  }

  // -------------------------------------------------------------------------

  private async runIntake(
    message: NormalizedObservedMessage,
    state: ConversationWatchState,
  ): Promise<void> {
    const result: ChainResult = await runChain(
      this.deps.rules.intake,
      {
        message,
        trigger: 'message',
        state,
        marks: {},
        now: this.now(),
      },
      (rule) => this.resolveParams(rule),
      (rule) => this.isRuleEnabled(rule),
    );

    this.deps.logger.debug('rules-trace', {
      conversation: message.target.key,
      msgId: message.msgId,
      trigger: 'message',
      trace: formatTrace(result.trace),
    });

    if (result.outcome === 'halted' || result.outcome === 'deferred') {
      if (result.haltedBy !== undefined) {
        this.halts.set(result.haltedBy, (this.halts.get(result.haltedBy) ?? 0) + 1);
        this.deps.stats.observedHalted += 1;
      }
      return;
    }

    // Phase 0 的终局：入旁听缓冲。评估与发言（Phase 2）从这里分出去。
    state.pushEntry(message, this.now());
  }

  private stateFor(conversationKey: string): ConversationWatchState {
    let state = this.states.get(conversationKey);
    if (state === undefined) {
      state = new ConversationWatchState(conversationKey, {
        maxMessages: this.deps.config.buffer.maxMessages,
        maxAgeMs: this.deps.config.buffer.maxAgeMs,
      });
      this.states.set(conversationKey, state);
    }
    return state;
  }

  /**
   * 参数合并：规则 paramsSpec 默认值 ← 全局注入（master-switch 的 enabled 来自
   * 总开关，group-whitelist 的 groups 来自 BOT_LISTEN_GROUPS）← qqbot.yml 的
   * intervention.rules.<name>.params 覆盖。
   */
  private resolveParams(rule: InterventionRule): Readonly<Record<string, RuleParamValue>> {
    const merged: Record<string, RuleParamValue> = { ...rule.paramsSpec };
    if (rule.name === 'master-switch') {
      merged['enabled'] = this.deps.config.enabled;
    }
    if (rule.name === 'group-whitelist') {
      merged['groups'] = this.deps.config.whitelistGroups.join(',');
    }
    const override = this.deps.config.rules[rule.name]?.params;
    if (override !== undefined) Object.assign(merged, override);
    return merged;
  }

  private isRuleEnabled(rule: InterventionRule): boolean {
    return this.deps.config.rules[rule.name]?.enabled !== false;
  }

  /** 启动期校验：配置里出现的规则名必须已注册（拼错键名不静默放过）。 */
  private assertRegistryKnown(): void {
    const registered = new Set(
      [
        ...this.deps.rules.continuation,
        ...this.deps.rules.intake,
        ...this.deps.rules.evaluate,
        ...this.deps.rules.speak,
      ].map((rule) => rule.name),
    );
    for (const name of Object.keys(this.deps.config.rules)) {
      if (!registered.has(name)) {
        this.deps.logger.warn('配置里出现未注册的介入规则名，将被忽略', {
          rule: name,
          registered: [...registered],
        });
      }
    }
  }
}
