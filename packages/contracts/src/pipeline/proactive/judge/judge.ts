import { immutableConstant } from '../../../readonly.js';
/**
 * ② **LLM 层**：对每个候选场景逐个回答"它成立吗"。
 *
 * 这一层只有一件语义工作，且刻意**不做**另三件事：
 *   - 不做优先级 / 预算裁决（策略，属否决层）；
 *   - 不产生候选之外的场景（模型没有那些场景的事实依据）；
 *   - 不决定"说不说"（成立 ≠ 该说：还要过限流、话题预算、无人回应保险）。
 *
 * 输出是**逐场景的多标签**而不是"五选一 + 是否发言"。理由见 contract.ts 顶部：
 * 「取第一个」是资源分配问题，必须在代码里可测、可参数化、可回放对比。
 */
/**
 * ② **LLM 层**：对每个候选场景逐个回答"它成立吗"。
 *
 * 这一层只有一件语义工作，且刻意**不做**另三件事：
 *   - 不做优先级 / 预算裁决（策略，属否决层）；
 *   - 不产生候选之外的场景（模型没有那些场景的事实依据）；
 *   - 不决定"说不说"（成立 ≠ 该说：还要过限流、话题预算、无人回应保险）。
 *
 * 输出是**逐场景的多标签**而不是"五选一 + 是否发言"。理由见 contract.ts 顶部：
 * 「取第一个」是资源分配问题，必须在代码里可测、可参数化、可回放对比。
 */
import type { SceneCandidate, SceneId, SceneVerdict } from '../contract.js';
/**
 * 判据清单，**按 SCENE_ORDER 排列**——顺序在这里由构造方式保证，
 * 而不是靠人工维护的一致性（新增场景若忘了加 criteria，这里会少一项，
 * 契约测试立刻失败）。
 */
export type SCENE_CRITERIA = ReadonlyArray<{
  scene: SceneId;
  criteria: string;
}>;
/**
 * 挂起问题在 prompt 里的**对象引用前缀**。
 *
 * 模型要给 `yielding` 就必须报出"在等的是哪一个挂起问题"，而"引用一个对象"
 * 要求那个对象**有稳定的名字**——所以结构化事实块里的每条挂起问题都带上
 * `q:<id>`，模型原样回抄，否决层据此在台账里查。
 */
export const WAIT_TARGET_PREFIX = 'q:';
/**
 * 从模型给的 `evidence` 里取出它对挂起问题的**对象引用**。
 *
 * 容错纪律：只认原样回抄的 `q:<id>`（大小写不敏感、允许中文括号/空格围栏）。
 * 取不到就返回 undefined——**不猜**、不退化回"随便挑一个挂起问题"，
 * 因为"引用无效"本身就是要被计数的模型行为（`wait_ticket_invalid_target`）。
 */
export type extractWaitTargetId = (evidence: string | undefined) => string | undefined;
/**
 * 渲染 system 段的判据清单：**只列本次候选场景**（及其顺序），
 * 并要求逐场景给出判定。顺序由 `SCENE_ORDER` 决定，与 prompt 的措辞无关——
 * 这就是"顺序可参数化、可回放对比"的前提。
 */
export type renderJudgeCriteria = (candidates: readonly SceneCandidate[]) => string;
/**
 * 仲裁输出的 JSON 契约（由 gate-client 固定拼接在 system 段尾）。
 * 未知场景 id / 非法字段一律由 `parseSceneVerdicts` 丢弃，绝不整条降级。
 *
 * 相比上一版**只加了一个字段** `session`（需求 §六）。
 */
export type JUDGE_OUTPUT_CONTRACT = string;
/**
 * 把模型输出解析成逐场景判定。
 *
 * 容错纪律（逐条对应三层拆分的收益）：
 *   - **未知场景 id → 丢弃该项**（不是整条降级为 silent：一个幻觉标签不该毁掉
 *     其余四条正确判定）；
 *   - 候选里**缺失**的场景 → 按 `satisfied:false` 补一条（宁缺勿滥）；
 *   - 模型多给的、候选之外的场景 → 丢弃（它没有那些场景的事实依据）；
 *   - 整个 JSON 无法解析 → 返回 `undefined`（调用方按 silent 处理，fail-closed）。
 */
export type parseSceneVerdicts = (
  raw: string,
  candidates: readonly SceneCandidate[]
) => readonly SceneVerdict[] | undefined;
/** 供测试与文档使用：当前场景全集（顺序即优先级）。 */
export const SCENE_IDS: readonly SceneId[] = immutableConstant([...SCENE_ORDER]);

import { SCENE_ORDER } from '../contract.js';
