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
import type { ProactiveDecision, SceneCandidate, SceneId, SceneVerdict, VetoContext, VetoPolicy } from '../contract.js';
export { DEFAULT_VETO_POLICY, MAX_WAIT_PER_ITEM_CAP } from '../contract.js';
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
export type selectByQuantileBudget = (scored: ReadonlyArray<{
    scene: SceneId;
    score: number;
    expectedRate: number;
}>, targetRate: number) => ReadonlySet<SceneId>;
/**
 * 否决层的唯一入口：把「候选 + 逐场景判定 + 额度上下文」压成一个终局。
 *
 * 纯函数：相同输入必然得到相同输出（这是离线回放能复现的前提）。
 */
export type evaluateVeto = (input: {
    candidates: readonly SceneCandidate[];
    verdicts: readonly SceneVerdict[];
    context: VetoContext;
}, policy?: VetoPolicy) => ProactiveDecision;
