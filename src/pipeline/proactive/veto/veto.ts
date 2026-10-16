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
 *   no-candidate（本地没候选）→ no-scene（模型全判不成立）
 *   → **wait 的那一支**（见下）→ rate-limit（硬限流）
 *   → **session 闸门**（没有则开、有则查预算与最小间隔）→ budget（顺序 / 分位数预算）→ speak
 *
 * ## session 闸门（本节对应 docs/TOPIC-SESSION-REQUIREMENT.md 判定二/四）
 *
 * 它接替的是原来"每话题一次"那一行**位置**，但语义完全不同：不再按"话题"
 * 记账（话题是 LLM 之后才明确的东西，本地记不准），只按"LLM 开的那一次会话 +
 * 预算"记账。四类不过（穷举）：
 *
 * | 原因 | 条件 | 计入 |
 * |---|---|---|
 * | `no-session` | 没有开启中的 session（模型也没判"值得"，否则本次就会开一个） | `proactiveNoSession` |
 * | `budget-exhausted` | `budgetLeft <= 0`（**预算不关会话，只闭嘴**） | `proactiveBudgetExhausted` |
 * | `min-gap` | `now - lastSpokeAt < sessionMinGapMs` | `proactiveMinGap` |
 * | `no-new-content` | 转录自上次评估无新增 | 不单独计数（属"未进入判定"） |
 *
 * 最后一类**不在这里**：它在调度层就短路了（连判定都不发起），见 watcher.ts。
 * 这里负责的是"判定跑完之后"的三类，且顺序恒为 rate-limit → session 闸门 → 预算
 * （验收 10：10 分钟 3 次的上限不受 session 预算放宽）。
 *
 * ## 预算耗尽之后怎么办（维护者口径：session 不由预算驱动）
 *
 * 预算减到 0 **不关闭 session**：这个话题的会话继续开着，闸门只是一次次地不放行。
 * 要重新开口，只有两条正门，**都由话题驱动**：
 *   1. 模型说换话题了（`session:'new-topic'`）→ 关旧会话、为新话题开一个（预算重置）；
 *   2. 静默到 `idle`（或模型说收口 `close`）→ 会话结束 → 下次唤醒由 LLM 决定要不要
 *      为当前话题开一个新的。
 *
 * ⚠️ `new-topic` 只重置**预算**，**不**重置节奏：最小间隔照样要过（`min-gap`）。
 * 否则模型只要一直说"换话题了"就能连着说——那就把上限挪回模型手里了。
 *
 * ## `wait` 的唯一入口（本节对应 docs/WAIT-CONVERGENCE-REQUIREMENT.md 判定二）
 *
 * ```
 * 候选为空                        → silent('no-candidate')
 * 无 satisfied 且无 waiter        → 有 session ? silent('no-scene') : silent('no-session')
 * 无 satisfied 且有 waiter：
 *     ├ waiter 引用无效 / 缺失    → silent（调度层计 wait_ticket_invalid_target）
 *     ├ waiter.reason ≠ yielding  → silent('wait-declined')  ← not-yet / watching
 *     ├ 对象已关闭（问题已答/过期）→ silent（调度层计 wait_ticket_stale）
 *     └ 对象仍挂起：
 *          ├ 该对象让路预算已用尽 → silent('wait-spent')
 *          └ 否则 → wait（建票据，计 wait_ticket_created）
 * ```
 *
 * `satisfied` 非空时的优先级**不变**（顺序 → 硬限流 → session 闸门）——
 * wait 只是"没有场景成立"这一支的细化，不去抢成立场景的名额。
 *
 * 注意 `no-response`（没人理我就停）**不在这里**：它必须在调用 LLM 之前短路，
 * 因此由 collect.ts 的入口执行、由调用方从 VetoPolicy 传入上限（见 §"三层分工"）。
 */

import {
  aggregateSessionDirective,
  DEFAULT_VETO_POLICY,
  effectiveMaxWaitPerItem,
  effectiveSessionMinGapMs,
  sceneOrder,
  type ProactiveDecision,
  type SceneCandidate,
  type SceneId,
  type SceneVerdict,
  type VetoContext,
  type VetoPolicy,
  type VetoReason,
  type WaitReason,
} from '../contract.js';

export { DEFAULT_VETO_POLICY, MAX_WAIT_PER_ITEM_CAP } from '../contract.js';

/**
 * 从一条判定里取出模型想表达的理由（三态）。
 *
 * 兼容口径：存量回放数据里只有布尔 `suggestsWait`，它表达的正是
 * "有人在答"这一种（三态拆分前它同时承担了三件事），因此等价映射为 `yielding`。
 * **判据正文与 JSON 契约已经不再产出它**，这里只是让旧样本仍可离线回放。
 */
function waitReasonOf(verdict: SceneVerdict): WaitReason | undefined {
  if (verdict.waitReason !== undefined) return verdict.waitReason;
  if (verdict.suggestsWait === true) return 'yielding';
  return undefined;
}

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
    // 模型说"先别说"——**采纳与否只由这一支决定**（旧实现在这里排了一个
    // 与任何对象都无关的定时器，于是 wait 占比 46%、产出为零）。
    const decided = decideWait(verdicts, context, policy);
    // "让路"这一支的终局**优先于** session 闸门：wait 票据挂在**挂起问题**上，
    // 与有没有 session 无关。把它压在 `no-session` 之下，等于让"有人在答、
    // 过 45 秒再看"这条唯一的等待机制整体失效。
    if (!(decided.action === 'silent' && decided.reason === 'no-scene')) return decided;
    // ③ 没有场景成立、也没有任何"让路"声明：本次唤醒什么都不会发生。
    //    在账上它属于哪一类"没过闸门"，取决于当时有没有 session：
    //      没有 session → `no-session`（模型没判"值得"，就不会开 session；验收 2）
    //      有 session   → `no-scene`（模型自己说这次没什么可补；session 保持开启）
    return context.session === undefined
      ? silent('no-session', '没有开启中的 session（模型本次未判"值得"）')
      : silent('no-scene');
  }

  // ④ 硬限流：最保守的一道，先于一切"策略"（也先于 session 闸门——
  //    10 分钟 3 次的上限**不因** session 预算放宽而放宽，见验收 10）
  if (context.spokeCount10Min >= policy.maxPer10Min) {
    return silent('rate-limit', `10 分钟已介入 ${context.spokeCount10Min} 次`);
  }
  if (context.spokeCount1Hour >= policy.maxPerHour) {
    return silent('rate-limit', `1 小时已介入 ${context.spokeCount1Hour} 次`);
  }

  // ⑤ session 闸门（接替原来"每话题一次"的位置）：
  //    - **没有 session** → 本次发言会**开**一个新 session（调度层写 budgetLeft），
  //      这里不拦：LLM 刚判"值得"，那正是 session 的定义（验收 1）；
  //    - 有 session → 两道确定性检查：预算还剩吗、距上次发言够久吗。
  const session = context.session;
  if (session !== undefined) {
    // 模型明确说"换话题了"→ 这是一次**重启**：预算是新会话的（调度层会关旧开新），
    // 因此预算那一道不适用。它只重置预算，不重置节奏（见下）。
    const { restart } = aggregateSessionDirective(verdicts);
    if (session.budgetLeft <= 0 && !restart) {
      // 本话题的发言额度用尽 → **闭嘴，但不关会话**（维护者口径：session 不该被
      // 预算驱动）。后续每次唤醒都会落在这里，直到模型说换话题（`new-topic`）、
      // 说收口（`close`）或静默到 `idle` —— 那时才会由调度层关掉它。
      return silent(
        'budget-exhausted',
        `本话题的发言预算已用尽（会话开启于 ${session.openedAt}）；` +
          `等话题收口（close）、换新（new-topic）或静默超时`,
      );
    }
    const lastSpokeAt = session.lastSpokeAt;
    if (lastSpokeAt !== undefined) {
      const gap = effectiveSessionMinGapMs(policy.sessionMinGapMs);
      if (context.now - lastSpokeAt < gap) {
        // ⚠️ 换话题（`new-topic`）**也**要过这一道：模型只有重置预算的权力，
        // 没有重置节奏的权力。否则"一直说换话题"就能连着刷——上限又回到模型手里。
        return silent(
          'min-gap',
          `距上次发言 ${context.now - lastSpokeAt}ms（下限 ${gap}ms），本次不消耗预算`,
        );
      }
    }
  }

  // ⑥ 顺序 / 分位数预算：**「取第一个」在这里落地**
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

/**
 * "模型全判不成立"这一支的终局——wait 的**唯一入口**。
 *
 * 纯函数：所有判断依据都已经在 `context.wait` 里被结构化（对象是否仍挂起、
 * 让路预算用了多少），因此这一整棵决策树可以被单测穷举，不需要真 LLM。
 */
function decideWait(
  verdicts: readonly SceneVerdict[],
  context: VetoContext,
  policy: VetoPolicy,
): ProactiveDecision {
  // 谁在说"先别说"：三态理由里只有 `yielding` 需要排唤醒，其余按 silent 处理。
  let waiter: { verdict: SceneVerdict; reason: WaitReason } | undefined;
  for (const verdict of verdicts) {
    const reason = waitReasonOf(verdict);
    if (reason === undefined) continue;
    // 已成立的场景不会走到这里（调用方只在 satisfied 为空时进来），
    // 但"成立却又说在等"是自相矛盾的判定，一律不采纳。
    if (verdict.satisfied) continue;
    // 多个候选同时说"先别说"：取全局顺序里的第一个（与 speak 的裁决同构）
    if (waiter === undefined || sceneOrder(verdict.scene) < sceneOrder(waiter.verdict.scene)) {
      waiter = { verdict, reason };
    }
  }
  if (waiter === undefined) return silent('no-scene');

  // ① 引用无效：模型报了一个台账里**从来没有过**的 id（`q:<id>` 回抄错了、
  //    或者是幻觉）。不猜、不建票据、不退化回无限等待。
  //    这一条**不产生票据**，所以不进账目等式（见需求验收 11）。
  const target = context.wait;
  if (target === undefined || !target.exists) {
    return silent(
      'wait-declined',
      `wait:invalid-target|理由 ${waiter.reason}，对象 ${target?.id ?? '(未给出)'} 不在台账里`,
    );
  }

  // ② 理由不排唤醒：`not-yet`（交给既有的 90 秒探针）/ `watching`（等下一条
  //    人类消息）。它们**不是"被否决"**，是"模型说不用等"，因此必须有独立
  //    计数，否则"模型为什么没让 bot 说话"在指标里彻底消失。
  //    （非法的理由在解析期就已经被丢弃，走不到这里。）
  if (waiter.reason !== 'yielding') {
    return silent('wait-declined', `wait:${waiter.reason}`);
  }

  // ③ 对象存在但已关闭（问题被答 / 过期 / 话题翻篇）→ **不建票据、不花 LLM**。
  //    这类是"好消息"：本地检查替我们省下了一次调用。
  if (!target.open) return silent('wait-declined', `wait:stale|${target.id}`);

  // ④ 该对象的"让路"预算用尽：`maxWaitPerItem` 是代码里的硬上限，
  //    模型再给多少次 yielding 都过不去（The cap must live below the model）。
  const budget = effectiveMaxWaitPerItem(policy.maxWaitPerItem);
  if (target.yieldBudgetUsed >= budget) {
    return silent(
      'wait-spent',
      `${target.id} 已让路 ${target.yieldBudgetUsed} 次（上限 ${budget}）`,
    );
  }

  // ⑤ 采纳：建票据（调度层按 waitYieldMs 排**每会话一个**唤醒点）。
  return { action: 'wait', reason: 'yielding', targetId: target.id };
}
