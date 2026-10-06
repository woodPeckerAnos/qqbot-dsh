/**
 * ③ **否决层**：确定性约束 + **顺序与预算的唯一实现**。
 *
 * 这一层是三层里唯一"能做决定"的地方，也是唯一被允许知道"额度"的地方。
 * 三条纪律：
 *   1. **无语义判断**：只看结构化的数字、布尔与场景标签——不读消息文本，
 *      不调用 LLM，因此可以完全用单测穷举；
 *   2. **顺序在这里落地**：「多个场景同时成立时取第一个」是本文件的一行
 *      `reduce`，不是 prompt 里的一句话；
 *   3. **只收紧不放宽**：任何约束命中都只会让结果更保守。
 *
 * 决策顺序（短路，越靠前越"全局"）：
 *   no-candidate（本地没候选）→ no-scene（模型全判不成立，可能转 wait）
 *   → rate-limit（硬限流）→ topic-spent（同一话题已说过）
 *   → budget（顺序 / 分位数预算）→ speak
 *
 * 注意 `no-response`（没人理我就停）**不在这里**：它必须在调用 LLM 之前短路，
 * 因此由 collect.ts 的入口执行、由调用方从 VetoPolicy 传入上限（见 §"三层分工"）。
 */

import {
  sceneOrder,
  type ProactiveDecision,
  type SceneCandidate,
  type SceneId,
  type SceneVerdict,
  type VetoContext,
  type VetoPolicy,
  type VetoReason,
  DEFAULT_VETO_POLICY,
} from '../contract.js';

/** 采纳 LLM 的 wait 建议时默认推迟多久（与既有 gate-wait 重查同量级）。 */
export const DEFAULT_WAIT_MS = 30_000;

/**
 * 按场景置信度加权的**分位数预算**：选出"在预算内最值得说"的场景。
 *
 * 机制（源自 MaiBot 的 DynamicReplyGate，见架构方案 §13.2）：
 *   目标次数 = targetRate × Σ(各候选的估算命中率)
 *   阈值     = 把候选按 `confidence × expectedRate` 降序累加，
 *              刚好用满目标次数时那一档的分数
 *   → 分数 ≥ 阈值者入选；高权重场景**自然突破**，不需要给它开后门。
 *
 * 返回值是入选集合。**默认不启用**（`quantileBudget: false`）：先用固定顺序，
 * 等 S4 有回放数据、`sceneRates` 不再是先验值时再开。
 */
export function selectByQuantileBudget(
  scored: ReadonlyArray<{ scene: SceneId; score: number; expectedRate: number }>,
  targetRate: number,
): ReadonlySet<SceneId> {
  if (scored.length === 0) return new Set();
  const target = Math.max(0, targetRate) * scored.reduce((sum, item) => sum + item.expectedRate, 0);
  const sorted = [...scored].sort((left, right) => right.score - left.score);
  const selected = new Set<SceneId>();
  let accumulated = 0;
  for (const item of sorted) {
    // 至少入选一个：预算是"收紧"而不是"关掉"（target=0 时仍允许一次）
    if (accumulated >= target && selected.size > 0) break;
    selected.add(item.scene);
    accumulated += 1;
  }
  return selected;
}

/**
 * 否决层的唯一入口：把「候选 + 逐场景判定 + 额度上下文」压成一个终局。
 *
 * 纯函数：相同输入必然得到相同输出（这是离线回放能复现的前提）。
 */
export function evaluateVeto(
  input: {
    candidates: readonly SceneCandidate[];
    verdicts: readonly SceneVerdict[];
    context: VetoContext;
  },
  policy: VetoPolicy = DEFAULT_VETO_POLICY,
): ProactiveDecision {
  const { candidates, verdicts, context } = input;

  // ① 本地没有候选：连问都不用问（省一次 LLM 调用）
  if (candidates.length === 0) return silent('no-candidate');

  // ② 模型判定成立的场景，按全局顺序排列
  const satisfied = verdicts
    .filter((verdict) => verdict.satisfied && verdict.scene !== undefined)
    .sort((left, right) => sceneOrder(left.scene) - sceneOrder(right.scene));
  if (satisfied.length === 0) {
    // 模型可能建议"等一会更合适"——是否采纳仍由本层决定
    const waiter = verdicts.find((verdict) => verdict.suggestsWait === true);
    if (waiter !== undefined && context.waitRetries < policy.maxWaitRetries) {
      return { action: 'wait', scene: waiter.scene, delayMs: DEFAULT_WAIT_MS, reason: waiter.reason };
    }
    return silent(
      waiter === undefined ? 'no-scene' : 'wait-exhausted',
      waiter === undefined ? undefined : 'wait 建议已用尽',
    );
  }

  // ③ 硬限流：最保守的一道，先于一切"策略"
  if (context.spokeCount10Min >= policy.maxPer10Min) {
    return silent('rate-limit', `10 分钟已介入 ${context.spokeCount10Min} 次`);
  }
  if (context.spokeCount1Hour >= policy.maxPerHour) {
    return silent('rate-limit', `1 小时已介入 ${context.spokeCount1Hour} 次`);
  }

  // ④ 话题预算：同一话题已经说过就不再说（除非是新的话题）
  if (context.topicBotSpeaks >= policy.maxPerTopic) {
    return silent('topic-spent', `本话题已介入 ${context.topicBotSpeaks} 次`);
  }

  // ⑤ 顺序 / 分位数预算：**「取第一个」在这里落地**
  const candidateByScene = new Map(candidates.map((item) => [item.scene, item]));
  const orderedIds =
    context.order === undefined
      ? satisfied.map((verdict) => verdict.scene)
      : [...satisfied.map((verdict) => verdict.scene)].sort(
          (left, right) =>
            (context.order as readonly SceneId[]).indexOf(left) -
            (context.order as readonly SceneId[]).indexOf(right),
        );

  let winner = orderedIds[0] as SceneId;
  if (policy.quantileBudget) {
    const scored = satisfied.map((verdict) => {
      const candidate = candidateByScene.get(verdict.scene);
      const expectedRate = candidate?.expectedRate ?? 0.3;
      return {
        scene: verdict.scene,
        // 权重 = 语义置信度 × 估算命中率 × 顺序折减
        score:
          verdict.confidence *
          expectedRate *
          (1 - sceneOrder(verdict.scene) / (sceneOrder.length + 1)),
        expectedRate,
      };
    });
    const selected = selectByQuantileBudget(scored, policy.targetRate);
    if (selected.size === 0) return silent('budget', '分位数预算未选中任何场景');
    // 预算选中的集合里，仍按**全局顺序**取第一个（策略可替换，顺序始终是最终裁决）
    winner = orderedIds.find((scene) => selected.has(scene)) ?? winner;
  }

  const winnerVerdict = satisfied.find((verdict) => verdict.scene === winner) as SceneVerdict;
  const alsoMatched = satisfied
    .map((verdict) => verdict.scene)
    .filter((scene) => scene !== winner);

  return {
    action: 'speak',
    scene: winner,
    confidence: winnerVerdict.confidence,
    reason: winnerVerdict.reason,
    alsoMatched,
    ...(winnerVerdict.evidence === undefined ? {} : { evidence: winnerVerdict.evidence }),
    ...(winnerVerdict.directive === undefined ? {} : { directive: winnerVerdict.directive }),
  };
}

function silent(reason: VetoReason, detail?: string): ProactiveDecision {
  return detail === undefined
    ? { action: 'silent', reason }
    : { action: 'silent', reason, detail };
}
