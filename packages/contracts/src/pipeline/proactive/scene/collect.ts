/**
 * ① **搜集层**：本地、零 LLM 成本地找出"哪些场景有可能成立"。
 *
 * 三个纪律（违反任何一条，三层拆分就白做了）：
 *   1. **纯函数**：不读墙上时钟（时间从 evidence 传）、不做 IO、不用随机数；
 *   2. **只做能不能**：预筛命中 ≠ 场景成立（成立与否是 LLM 的事），
 *      预筛未命中 **也不否决** 别人；
 *   3. **不决定谁赢**：这里只产出候选并估算权重，胜负在 veto.ts。
 *
 * 全局保险（"没人理我就停"）刻意放在这一层的**入口**而不是某个场景的
 * `precheck` 里：没人理是会话级事实，写进某个场景会让别的场景绕过它。
 */
/**
 * ① **搜集层**：本地、零 LLM 成本地找出"哪些场景有可能成立"。
 *
 * 三个纪律（违反任何一条，三层拆分就白做了）：
 *   1. **纯函数**：不读墙上时钟（时间从 evidence 传）、不做 IO、不用随机数；
 *   2. **只做能不能**：预筛命中 ≠ 场景成立（成立与否是 LLM 的事），
 *      预筛未命中 **也不否决** 别人；
 *   3. **不决定谁赢**：这里只产出候选并估算权重，胜负在 veto.ts。
 *
 * 全局保险（"没人理我就停"）刻意放在这一层的**入口**而不是某个场景的
 * `precheck` 里：没人理是会话级事实，写进某个场景会让别的场景绕过它。
 */
import type { InterestPool } from '../interests/pool.js';
import type { ConversationState } from './state.js';
import type {
  SceneCandidate,
  SceneDefinition,
  SceneEvidence,
  SceneId,
  SceneTrigger,
} from '../contract.js';
export interface BotReferenceHit {
  /** 'alias' = 命中精确别名（高置信）；'generic' = 泛称 + 动作词（需 LLM 复核） */
  kind: 'alias' | 'generic';
  matched: string;
}
export type detectBotReference = (input: {
  text: string;
  botAliases: readonly string[];
  atSelf?: boolean;
}) => BotReferenceHit | undefined;
/**
 * 五个场景的**静态描述**：名字、触发面、本地预筛。
 * criteria 文本不在这里——它属于 LLM 层（judge.ts），两层的耦合只有 SceneId。
 */
export type SCENE_DEFINITIONS = readonly SceneDefinition[];
/** 按全局顺序排列的场景定义（顺序唯一来源见 contract.ts 的 SCENE_ORDER）。 */
export type SCENE_REGISTRY = readonly SceneDefinition[];
export type getScene = (id: SceneId) => SceneDefinition | undefined;
/** 某触发面下参与的场景（弱信号场景因此不会被每条消息惊动）。 */
export type scenesForTrigger = (trigger: SceneTrigger) => readonly SceneDefinition[];
/**
 * 从会话状态组装一次评估的**全部证据**。
 *
 * 这是 `SceneEvidence` 的唯一生产入口（除测试外）。在此之前这些字段靠调用方
 * 手填，实际结果是永远取默认值——场景 1/2/3/5 因此结构性不可能触发，
 * 而且没有任何报错。现在每个字段都有明确来源：
 *
 * | 字段 | 来源 |
 * |---|---|
 * | `message` | 本轮消息（探针/滚动触发时为空） |
 * | `botAliases` | 配置（`proactive.botAliases`） |
 * | `lastBotSpeakAt` / `inBotTopicWindow` / `topic` | `ConversationState` 的活动窗口 |
 * | `recentMessageCount` / `recentHumanCount` | 同上（按窗口过滤） |
 * | `pendingQuestionCount` | 未答问题台账（本地疑问句识别 + TTL） |
 * | `session` | `ConversationState` 的话题 session（LLM 开的那一次，三字段） |
 * | `matchedInterestIds` | 兴趣池（本地关键词命中） |
 * | `unansweredStreak` | bot 发言计数 / 人类消息归零 |
 *
 * `sceneRates` **刻意不填**：它要的是回放统计（每个场景的命中×发言历史频率），
 * 目前没有任何数据管道产出它。留空 → 分位数预算退化为固定顺序（见 veto.ts），
 * 这也是 `quantileBudget` 默认关闭的原因。
 */
export type buildSceneEvidence = (input: {
  state: ConversationState;
  trigger: SceneTrigger;
  now: number;
  /** 本轮消息（`question-probe` / `topic-roll` 触发时为空） */
  message?: SceneEvidence['message'];
  interests?: InterestPool;
  botAliases?: readonly string[];
  /** 兴趣匹配用的文本（缺省取本轮消息文本） */
  text?: string;
  /** 本次是"让路后到期重查"时，指明被唤醒的那个对象（见 contract.ts） */
  waitWakeup?: SceneEvidence['waitWakeup'];
}) => SceneEvidence;
/**
 * 本地预筛的**唯一入口**：
 *   - 「没人理我就停」保险（命中 → 返回空数组，谁都不参与）；
 *   - 只跑该触发面下的场景；
 *   - 输出按全局顺序排列的候选（含估算权重）。
 *
 * `maxUnansweredStreak` 由调用方从 VetoPolicy 传入——本层不持有配置，
 * 但**执行**这条保险（它必须在 LLM 之前短路，否则白花一次调用）。
 */
export type collectCandidates = (
  evidence: SceneEvidence,
  options?: {
    maxUnansweredStreak?: number;
  }
) => readonly SceneCandidate[];
