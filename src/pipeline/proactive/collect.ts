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

import {
  sceneOrder,
  type SceneCandidate,
  type SceneDefinition,
  type SceneEvidence,
  type SceneHit,
  type SceneId,
  type ScenePrecheckContext,
  type SceneTrigger,
} from './contract.js';

// ---------------------------------------------------------------------------
// 场景 4 的指代检测（搜集层最"重"的一段本地逻辑）
// ---------------------------------------------------------------------------

/** 泛称：单独出现不足以判定"在对 bot 说"，需要配合动作/诉求词。 */
const GENERIC_BOT_WORDS = ['机器人', 'bot', 'Bot', 'BOT', '助手'];

/**
 * 动作/诉求词：泛称与它同现时才算"在对 bot 说话"。
 *
 * 刻意**不含**「是不是坏了 / 怎么不说话了」这类**议论**用语——它们多半是
 * 在跟群友抱怨 bot，而不是在对 bot 说。预筛宁漏不误报；反过来，预筛即使
 * 误放行，LLM 层还有一道"是对话还是议论"的方向复核。
 */
const ADDRESS_CUES = [
  '帮我', '帮忙', '能不能', '可以帮', '试一下', '试试',
  '看下', '看一下', '问一下', '请问', '在吗', '在不在', '有没有',
];

export interface BotReferenceHit {
  /** 'alias' = 命中精确别名（高置信）；'generic' = 泛称 + 动作词（需 LLM 复核） */
  kind: 'alias' | 'generic';
  matched: string;
}

export function detectBotReference(input: {
  text: string;
  botAliases: readonly string[];
  atSelf?: boolean;
}): BotReferenceHit | undefined {
  const text = input.text;
  if (text.trim() === '') return undefined;
  // @ 了 bot 就不是本场景（那是正常提问路径）
  if (input.atSelf === true) return undefined;

  for (const alias of input.botAliases) {
    const trimmed = alias.trim();
    if (trimmed !== '' && text.includes(trimmed)) return { kind: 'alias', matched: trimmed };
  }
  const generic = GENERIC_BOT_WORDS.find((word) => text.includes(word));
  if (generic === undefined) return undefined;
  const cue = ADDRESS_CUES.find((word) => text.includes(word));
  if (cue === undefined) return undefined;
  return { kind: 'generic', matched: `${generic}+${cue}` };
}

// ---------------------------------------------------------------------------
// 场景注册表（搜集层的静态描述）
// ---------------------------------------------------------------------------

/**
 * 五个场景的**静态描述**：名字、触发面、本地预筛。
 * criteria 文本不在这里——它属于 LLM 层（judge.ts），两层的耦合只有 SceneId。
 */
export const SCENE_DEFINITIONS: readonly SceneDefinition[] = [
  {
    id: 'scene-1',
    name: '续聊追问',
    triggers: ['message', 'speak-followup'],
    precheck: (ctx) => {
      if (!ctx.inBotTopicWindow) return undefined;
      if (ctx.lastBotSpeakAt === undefined) return undefined;
      const topicId = ctx.topic?.id;
      return {
        confidence: 0.6,
        evidence:
          topicId === undefined
            ? '在 bot 参与过的话题窗口内'
            : `话题 ${topicId} 内 bot 说过 ${ctx.topic?.botSpeaks ?? 1} 次`,
      };
    },
  },
  {
    id: 'scene-2',
    name: '持续讨论',
    triggers: ['topic-roll'],
    precheck: (ctx) => {
      if (ctx.recentHumanCount < 2 || ctx.recentMessageCount < 3) return undefined;
      if ((ctx.topic?.botSpeaks ?? 0) > 0) return undefined;
      return {
        confidence: 0.4,
        evidence: `近窗 ${ctx.recentMessageCount} 条 / ${ctx.recentHumanCount} 人`,
      };
    },
  },
  {
    id: 'scene-3',
    name: '无人应答',
    triggers: ['question-probe'],
    precheck: (ctx) =>
      ctx.pendingQuestionCount <= 0
        ? undefined
        : { confidence: 0.7, evidence: `台账挂起 ${ctx.pendingQuestionCount} 个问题` },
  },
  {
    id: 'scene-4',
    name: '指代',
    triggers: ['message'],
    precheck: (ctx) => {
      const hit = detectBotReference({
        text: ctx.message?.text ?? '',
        botAliases: ctx.botAliases,
        atSelf: ctx.message?.atSelf === true,
      });
      if (hit === undefined) return undefined;
      return {
        confidence: hit.kind === 'alias' ? 0.8 : 0.45,
        evidence: `指代词：${hit.matched}`,
      };
    },
  },
  {
    id: 'scene-5',
    name: '兴趣 / 性格话题',
    triggers: ['topic-roll'],
    precheck: (ctx) => {
      if (ctx.matchedInterestIds.length === 0) return undefined;
      if ((ctx.topic?.botSpeaks ?? 0) > 0) return undefined;
      return {
        confidence: 0.35,
        evidence: `兴趣条目：${ctx.matchedInterestIds.join(', ')}`,
      };
    },
  },
];

/** 按全局顺序排列的场景定义（顺序唯一来源见 contract.ts 的 SCENE_ORDER）。 */
export const SCENE_REGISTRY: readonly SceneDefinition[] = [...SCENE_DEFINITIONS].sort(
  (left, right) => sceneOrder(left.id) - sceneOrder(right.id),
);

export function getScene(id: SceneId): SceneDefinition | undefined {
  return SCENE_REGISTRY.find((scene) => scene.id === id);
}

/** 某触发面下参与的场景（弱信号场景因此不会被每条消息惊动）。 */
export function scenesForTrigger(trigger: SceneTrigger): readonly SceneDefinition[] {
  return SCENE_REGISTRY.filter((scene) => scene.triggers.includes(trigger));
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 各场景在无历史数据时的先验权重（分位数预算的兜底，不外露）。 */
const PRIOR_CONFIDENCE: Record<SceneId, number> = {
  'scene-1': 0.5,
  'scene-2': 0.35,
  'scene-3': 0.6,
  'scene-4': 0.5,
  'scene-5': 0.3,
};

/**
 * 本地预筛的**唯一入口**：
 *   - 「没人理我就停」保险（命中 → 返回空数组，谁都不参与）；
 *   - 只跑该触发面下的场景；
 *   - 输出按全局顺序排列的候选（含估算权重）。
 *
 * `maxUnansweredStreak` 由调用方从 VetoPolicy 传入——本层不持有配置，
 * 但**执行**这条保险（它必须在 LLM 之前短路，否则白花一次调用）。
 */
export function collectCandidates(
  evidence: SceneEvidence,
  options: { maxUnansweredStreak?: number } = {},
): readonly SceneCandidate[] {
  if (evidence.unansweredStreak >= (options.maxUnansweredStreak ?? 2)) return [];

  const candidates: SceneCandidate[] = [];
  for (const scene of scenesForTrigger(evidence.trigger)) {
    const ctx: ScenePrecheckContext = { ...evidence, scene: scene.id };
    const hit: SceneHit | undefined = scene.precheck?.(ctx);
    if (hit === undefined) continue;
    const rate = evidence.sceneRates?.[scene.id] ?? PRIOR_CONFIDENCE[scene.id];
    candidates.push(
      hit.evidence === undefined
        ? { scene: scene.id, localConfidence: hit.confidence, expectedRate: rate }
        : {
            scene: scene.id,
            localConfidence: hit.confidence,
            evidence: hit.evidence,
            expectedRate: rate,
          },
    );
  }
  return candidates.sort((left, right) => sceneOrder(left.scene) - sceneOrder(right.scene));
}
