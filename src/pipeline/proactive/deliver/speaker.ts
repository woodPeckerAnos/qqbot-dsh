import type {
  ProactiveTrigger,
  ProactiveDegradeReason,
  ProactiveOutcome,
  ProactiveDelivery,
  ProactiveMetrics,
  ProactiveSpeakerOptions,
} from '@qqbot/contracts';
/**
 * 主动发言（proactive speak）—— 能力契约、投放入口与记账。
 *
 * ## 这个模块为什么存在
 *
 * "主动发言"在架构上只有一个差异点：**没有用户消息可以锚定**。被动回复
 * （reply）在两条通道上都成立；主动发一条 bot 自己发起的话，OneBot 可以，
 * 官方 QQ 不行（主动推送 2025-04-21 起停用、群聊每月 4 条、用户可关闭接收）。
 *
 * 本模块把这件事收敛成**一个平台能力 + 一条外层逻辑**：
 *
 *   适配器（BotConnector.proactive）：如实表达平台能力，不支持就 do nothing
 *                  │  ProactiveResult{ ok } | { ok:false, reason, retryable }
 *                  ▼
 *   本模块（ProactiveSpeaker.deliver）：唯一的主动发言出口
 *     · 全局闸门（enabled / 降级策略）
 *     · 把缺省与返回值统一成有序的降级原因（disabled → unsupported → quota → …）
 *     · 静默降级 + 计数（绝不抛错、绝不重试、绝不排队）
 *
 * 于是"外层逻辑保持一致"不是靠纪律，而是靠**类型**：调用方只写一次
 * `speaker.deliver(...)`，官方通道的所有差异都在适配器返回值里。
 *
 * ## 纪律（不可协商）
 *
 * 1. **降级只能发生在交付前**：一旦适配器返回 `ok: true`，上层就当作已送达，
 *    不做"再发一次"；主动发言补投在业务上没有意义（话题已经翻篇）。
 * 2. **永不抛错**：任何失败都表达成 `ProactiveOutcome`，调用方不需要 try/catch。
 * 3. **禁排队**：拿不到能力/额度就丢弃（与 ingress 的准入 try 语义一致）。
 * 4. **记账必须可观测**：每次发言/降级都进 metrics，否则"官方通道静默不发言"
 *    在现场会变成"bot 坏了"。
 */
import type { ConversationTarget, ProactiveRejectReason } from '@qqbot/contracts';

// ---------------------------------------------------------------------------
// 触发来源
// ---------------------------------------------------------------------------

/**
 * 这次主动发言是被什么触发的。
 *
 * 只用于**记账与日志**：它让 `/metrics` 能回答"哪个场景在说话、哪个通道在降级"。
 * 平台侧看不到它，也不要拿它做任何判定。
 *
 * `manual` 与 `system-event` 是介入之外的两类主动发言（运维命令、进群问候），
 * 它们共用同一条投放路径——这正是"能力统一"的收益。
 */
export type { ProactiveTrigger } from '@qqbot/contracts';

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

/**
 * 降级原因，**有序**：数组顺序即排查顺序，也是决策表里"先看哪个"的顺序。
 *
 * 与适配器侧的 `ProactiveRejectReason` 的区别：适配器只表达平台视角
 * （unsupported / quota / rate-limit / error），这里多了**外层**自己会产生的原因
 * （disabled / empty）。
 */
export type { ProactiveDegradeReason } from '@qqbot/contracts';

/** 降级原因的排查顺序（同时是 `/metrics` 的输出顺序）。 */
export { PROACTIVE_DEGRADE_ORDER } from '@qqbot/contracts';

export type { ProactiveOutcome } from '@qqbot/contracts';

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

export type { ProactiveDelivery } from '@qqbot/contracts';

/**
 * 主动发言的记账口。由组装层接到 PipelineStats / health 快照上。
 *
 * 用接口而不是直接 import stats：本模块与 pipeline 其他部分解耦，
 * 单测可以注入 fake 计数（与接入层用回调上报转发结果是对称的做法）。
 */
export type { ProactiveMetrics } from '@qqbot/contracts';

/** 无操作的记账实现（单测 / 未接入统计时使用）。 */
export const NULL_PROACTIVE_METRICS: ProactiveMetrics = {
  sent: () => {},
  degraded: () => {},
};

export type { ProactiveSpeakerOptions } from '@qqbot/contracts';

/**
 * 主动发言的唯一出口。
 *
 * 线程安全说明：本类不持有跨调用的可变状态（计数在 metrics 里），
 * 因此可以并发调用；节流/预算属于**会话层**（`src/intervention/` 的 speak 链），
 * 不在这里重复实现——两处都做会形成两套账。
 */
export class ProactiveSpeaker {
  private readonly options: ProactiveSpeakerOptions;

  constructor(options: ProactiveSpeakerOptions) {
    this.options = options;
  }

  /** 当前是否具备主动发言能力（供 health / 控制面展示，不参与判定）。 */
  capability(target: ConversationTarget): 'ready' | 'unsupported' | 'no-connector' {
    const connector = this.options.connectorFor(target);
    if (connector === undefined) return 'no-connector';
    return typeof connector.proactive === 'function' ? 'ready' : 'unsupported';
  }

  /**
   * 投放一次主动发言。**永不抛错**。
   *
   * 降级顺序（短路）：
   *   disabled → empty → no-connector/proactive 缺省(unsupported) →
   *   适配器返回值(unsupported/quota/rate-limit/error)
   */
  async deliver(delivery: ProactiveDelivery): Promise<ProactiveOutcome> {
    const { trigger, target, content } = delivery;
    const metrics = this.options.metrics ?? NULL_PROACTIVE_METRICS;

    if (!this.options.enabled) {
      return this.degrade('disabled', trigger, undefined, false, metrics);
    }
    if (content.text.trim() === '' && (content.attachments ?? []).length === 0) {
      return this.degrade('empty', trigger, '文本为空且无附件', false, metrics);
    }

    const connector = this.options.connectorFor(target);
    if (connector === undefined) {
      return this.degrade('error', trigger, '找不到该会话对应的连接器', true, metrics);
    }
    // 缺省实现 = 平台不支持：与"官方层 do nothing"同义（见 core/connector.ts 注释）。
    if (typeof connector.proactive !== 'function') {
      return this.degrade('unsupported', trigger, '适配器未实现 proactive()', false, metrics);
    }

    // dryRun 在**调用适配器之前**短路：观察模式不该真的碰平台。
    if (this.options.dryRun === true) {
      metrics.sent(trigger);
      this.options.logger.info('主动发言（dryRun：判定通过，未发送）', {
        conversation: target.key,
        trigger,
        reason: delivery.reason,
        length: content.text.length,
      });
      return { status: 'would-send', trigger };
    }

    let result;
    try {
      result = await connector.proactive(target, content);
    } catch (error) {
      // 适配器契约要求用返回值表达失败；真抛了错也在这里兜住，绝不外溢。
      const detail = error instanceof Error ? error.message : String(error);
      this.options.logger.warn('主动发言适配器抛错（已按 error 降级）', {
        conversation: target.key,
        trigger,
        detail,
      });
      return this.degrade('error', trigger, detail, true, metrics);
    }

    if (!result.ok) {
      return this.degrade(
        normalizeReason(result.reason),
        trigger,
        result.detail,
        result.retryable,
        metrics
      );
    }

    metrics.sent(trigger);
    this.options.logger.debug('主动发言已送达', {
      conversation: target.key,
      trigger,
      reason: delivery.reason,
      length: content.text.length,
      attachments: content.attachments?.length ?? 0,
    });
    return { status: 'sent', trigger };
  }

  private degrade(
    reason: ProactiveDegradeReason,
    trigger: ProactiveTrigger,
    detail: string | undefined,
    retryable: boolean,
    metrics: ProactiveMetrics
  ): ProactiveOutcome {
    metrics.degraded(reason, trigger);
    this.options.logger.debug('主动发言降级（不发送）', {
      trigger,
      reason,
      detail,
      retryable,
    });
    return detail === undefined
      ? { status: 'degraded', trigger, reason, retryable }
      : { status: 'degraded', trigger, reason, detail, retryable };
  }
}

/** 适配器返回的原因 → 外层降级原因（同一枚举源，未知值一律归 error）。 */
function normalizeReason(reason: ProactiveRejectReason): ProactiveDegradeReason {
  switch (reason) {
    case 'unsupported':
    case 'quota':
    case 'rate-limit':
    case 'error':
      return reason;
    default:
      return 'error';
  }
}

/** 是否是一次成功投放（给调用方省一个判断）。 */
export function isSent(outcome: ProactiveOutcome): boolean {
  return outcome.status === 'sent';
}

/** 是否是"判定通过但被 dryRun 按住"（观察模式的信号）。 */
export function isWouldSend(outcome: ProactiveOutcome): boolean {
  return outcome.status === 'would-send';
}
