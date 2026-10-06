/**
 * 主动介入的**场景注册表（接缝草案）** —— docs/PROACTIVE-INTERVENTION-ARCH.md §4。
 *
 * 这份文件是本方案的「形状定义」，不是实现：
 *   - 它给出 5 个业务场景的类型、顺序、触发平面、本地预筛谓词与 criteria 片段；
 *   - 它**不**发起 LLM 调用、不持有状态、不排定时器、不 import 任何运行时模块；
 *   - 它当前不参与任何运行时路径（main.ts / orchestrator 都不 import 它）。
 *
 * 设计纪律（与 src/intervention/contract.ts 的既有纪律同构）：
 *   1. 顺序唯一来源：`SCENE_ORDER`。prompt 渲染、trace 记账、「取第一个」
 *      的仲裁全部读它，任何一层都不许再写第二份顺序。
 *   2. 预筛是纯函数：不读墙上时钟（时间一律从 ctx 传入）、不做 IO、不用随机数。
 *      预筛只回答「这个场景**有没有可能**成立」，**不否决**其他场景。
 *   3. 触发平面编码在场景定义里：场景 2/5 永远不在 `message` 触发下出现——
 *      「每条消息都判一次兴趣话题」从类型层面就不可能发生。
 *   4. criteria 是自然语言，需求即 prompt（沿用 P0 方案 §5.6）；实施 S1 时
 *      它应来自各场景文件夹的 REQUIREMENT.md，这里只是逐字草案。
 *
 * 实施路径（S1，见方案 §8）：本文件被 src/pipeline/proactive/scenes/registry.ts
 * 取代，每个场景拆成一个文件夹（REQUIREMENT.md + scene.ts + scene.test.ts）。
 */

// ---------------------------------------------------------------------------
// 场景标识与顺序
// ---------------------------------------------------------------------------

export type SceneId = 'scene-1' | 'scene-2' | 'scene-3' | 'scene-4' | 'scene-5';

/** 仲裁结果：命中的场景 + 要不要说 + 为什么。 */
export interface SceneVerdict {
  /** 唯一命中场景（多场景同时成立时取 order 最小者） */
  scenario: SceneId;
  decision: 'speak' | 'wait' | 'silent';
  /** 0..1；低置信可被 speak 链的预算进一步否决（进 trace，不单独设硬阈值） */
  confidence: number;
  /** 一句话理由（进 trace 与 /listen why） */
  reason: string;
  /** 同时命中的其他场景（不发言也记录，用于事后调序，见方案 §3.2） */
  alsoMatched?: SceneId[];
  /** 场景 1/2 的事实性纠错：被纠错的原文片段（criteria 强制要求） */
  evidence?: string;
  /** 场景 3：那个没人应答的问题原文 */
  question?: string;
  /** 交给介入 turn 的「该说什么」要点（合成 prompt 时使用） */
  directive?: string;
}

// ---------------------------------------------------------------------------
// 触发平面（deterministic，本地，零 LLM 成本）
// ---------------------------------------------------------------------------

/**
 * 一次仲裁的触发来源。场景通过 `triggers` 声明自己会在哪些来源下参与，
 * 于是「时机」不再是散落在 runner 里的 if。
 *
 * - `message`          ：一条旁听消息到达（场景 1、4）
 * - `question-probe`   ：问题台账的探针到期（场景 3，T1=90s / T2=10min）
 * - `topic-roll`       ：话题滚动收敛点（场景 2、5，每 N 条或 M 分钟）
 * - `speak-followup`   ：bot 刚在 FOCUS 相位内发过言，接续对它的回应（可选的收紧通道）
 */
export type SceneTrigger = 'message' | 'question-probe' | 'topic-roll' | 'speak-followup';

/** 本地预筛的输入：全部由 runner 从旁听缓冲与共享状态备好，纯数据。 */
export interface ScenePrecheckContext {
  /** 平台无关会话键，如 `ob11:g123456` */
  readonly convKey: string;
  /** 归一化消息（官方适配器只实现了子集，其余字段缺失即视为不成立） */
  readonly message: {
    readonly msgId?: string;
    readonly kind?: string;
    readonly senderId?: string;
    readonly senderName?: string;
    /** 纯文本渲染（@ 段不进正文） */
    readonly text: string;
    /** 平台提供的「@ 了 bot」标记 */
    readonly atSelf?: boolean;
    /** 引用的原消息文本（引用回复场景） */
    readonly quotedText?: string;
  };
  /** bot 本群别名（含全角/简称写法；配置注入，见方案 §3.5 指代场景） */
  readonly botAliases: readonly string[];
  readonly now: number;
  /** bot 最近一次在本群发言的时间；undefined = 本轮对话里没说过话 */
  readonly lastBotSpeakAt?: number;
  /** 当前话题（本地聚簇的结果，可能为 undefined = 尚无活跃话题） */
  readonly topic?: {
    readonly id: string;
    readonly startedAt: number;
    readonly lastAt: number;
    /** 参与人数（含 bot？否——只数人类） */
    readonly humanParticipants: number;
    /** bot 在该话题里说过几次 */
    readonly botSpeaks: number;
  };
  /**
   * 是否存在「bot 是该话题参与方」的窗口：bot 发言后同一话题仍在延续。
   * 与 `lastBotSpeakAt` 的区别：这个标记由话题聚簇给出，口径是**话题**而非时间。
   */
  readonly inBotTopicWindow?: boolean;
  /** 问题台账里该会话挂起的问题数（场景 3 在地板上用；探针触发时另走 question-probe） */
  readonly pendingQuestionCount?: number;
  /**
   * 连续「介入后无人回应」的次数（任何用户发言即归零）。
   * 达到配置上限时**所有场景一律不参与仲裁**——「没人理我就停」是全局保险，
   * 不是某个场景的判据（生态对照：astrbot 主动聊天的 unanswered 计数，默认 2）。
   */
  readonly unansweredStreak?: number;
  /** 本轮旁听窗口内的消息条数与人头数（场景 2 的活跃度预筛） */
  readonly recentMessageCount?: number;
  readonly recentHumanCount?: number;
  /** 命中的兴趣池条目 id 列表（场景 5 的廉价预筛；空数组 = 无候选） */
  readonly matchedInterestIds?: readonly string[];
}

/** 预筛命中：只带证据与置信度，场景 id 由 registry 绑定（避免各写一份）。 */
export interface SceneHit {
  confidence: number;
  /** 命中证据（进 trace；例如命中的别名、命中的兴趣条目 id） */
  evidence?: string;
}

/** 场景定义：一个业务场景的全部静态描述。 */
export interface SceneDefinition {
  readonly id: SceneId;
  /** 越小越优先；「取第一个」= order 最小。全局唯一来源。 */
  readonly order: number;
  /** 短名，进日志与 /listen scenes */
  readonly name: string;
  readonly enabled: boolean;
  /** 该场景会在哪些触发来源下参与仲裁（不在列 = 永不被评估） */
  readonly triggers: readonly SceneTrigger[];
  /** 进 LLM prompt 的自然语言段（实施期来自 REQUIREMENT.md 的 criteria 段） */
  readonly criteria: string;
  /** 本地预筛：纯函数；返回 undefined = 本次不参与仲裁（不否决他人） */
  readonly precheck?: (ctx: ScenePrecheckContext) => SceneHit | undefined;
}

// ---------------------------------------------------------------------------
// 小工具（纯函数）
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// 场景 4 的本地预筛：无 @ 的指代检测
// ---------------------------------------------------------------------------

/** 泛称：单独出现不足以判定「在对 bot 说」，需要配合动作/诉求词。 */
const GENERIC_BOT_WORDS = ['机器人', 'bot', 'Bot', 'BOT', '助手'];

/**
 * 动作/诉求词：泛称与它同现时才算「在对 bot 说话」。
 *
 * 刻意**不含**「是不是坏了 / 怎么不说话了」这类**议论**用语——它们多半是
 * 在跟群友抱怨 bot，而不是在对 bot 说。预筛宁漏不误报；反过来，
 * 预筛即使误放行也还有 criteria 里的方向复核兜底（见 SCENE_4_CRITERIA）。
 */
const ADDRESS_CUES = [
  '帮我', '帮忙', '能不能', '能不能帮', '可以帮', '试一下', '试试',
  '看下', '看一下', '问一下', '请问', '在吗', '在不在', '有没有',
];

export interface BotReferenceContext {
  readonly text: string;
  readonly botAliases: readonly string[];
  readonly atSelf?: boolean;
}

export interface BotReferenceHit {
  /** 'alias' = 命中精确别名（高置信）；'generic' = 泛称 + 动作词（需 LLM 复核） */
  kind: 'alias' | 'generic';
  matched: string;
}

/**
 * 指代检测（场景 4 的本地预筛）。
 *
 * 两条召回路径，风险不同：
 *   - 精确别名（bot 的名字/昵称）命中即高置信；
 *   - 泛称（「机器人」）必须与动作词同现——否则「这机器人是不是坏了」这类
 *     **议论**会被误当成**对话**（criteria 里还有一道 LLM 复核，见 SCENE_4_CRITERIA）。
 */
export function detectBotReference(ctx: BotReferenceContext): BotReferenceHit | undefined {
  const text = ctx.text;
  if (text.trim() === '') return undefined;
  // @ 了 bot 就不是本场景（那是正常提问路径，应走既有的 group-at-message）
  if (ctx.atSelf === true) return undefined;

  for (const alias of ctx.botAliases) {
    const trimmed = alias.trim();
    if (trimmed !== '' && text.includes(trimmed)) {
      return { kind: 'alias', matched: trimmed };
    }
  }
  const generic = GENERIC_BOT_WORDS.find((word) => text.includes(word));
  if (generic === undefined) return undefined;
  const cue = ADDRESS_CUES.find((word) => text.includes(word));
  if (cue === undefined) return undefined;
  return { kind: 'generic', matched: `${generic}+${cue}` };
}

// ---------------------------------------------------------------------------
// 五个场景的 criteria（需求即 prompt 的草案；实施期搬到各 REQUIREMENT.md）
// ---------------------------------------------------------------------------

const SCENE_1_CRITERIA = [
  'SCENE-1 续聊追问：bot 刚参与过这个话题，现在有人就同一话题继续追问或延伸。',
  'speak：与 bot 上一条发言同一话题，且该疑问尚未被任何人解决（含提问者自己）。',
  'silent：只是继续闲聊、话题已转向、已被群友充分回答。',
  '纠错纪律：只纠**可确证**的事实（可枚举、可计算、可查证），必须给出被纠错的原文片段；',
  '观点、偏好、预测、价值判断一律 silent；不确定就 silent，不要「温和地补充一点」。',
].join('\n');

const SCENE_2_CRITERIA = [
  'SCENE-2 持续讨论：多名群友围绕一个话题来回讨论，bot 没有参与。',
  '三个判据至少一个成立才考虑 speak：',
  '  (a) 讨论中出现了 bot 具备的能力域需求（查资料 / 跑代码脚本 / 数据与图表 / 文件生成转换 / 多步任务）；',
  '  (b) 存在无人应答且 bot 能答的问题；',
  '  (c) 有人说了可确证的事实性错误。',
  '并且必须能提供**信息增量**——群友已经说清楚的东西不要复述。',
  'silent：纯观点碰撞、情绪与闲聊、玩笑、已被群友充分回答、bot 无信息增量。',
  '这是最容易被反感的一类介入：宁可漏，不可多。',
].join('\n');

const SCENE_3_CRITERIA = [
  'SCENE-3 无人应答：会话里有一个具体问题长时间没人回答。',
  '转录会给出【挂起问题】台账（问题原文 + 已静默时长）；只考虑台账里的问题。',
  'speak：问题仍未被回答 + 问题落在 bot 能力域内 + 已静默足够久（≥90 秒，越久越应该答）。',
  'wait：群里有人正在回应（例如刚有人接话、有人在补充信息）——再等一会更合适。',
  'silent：问题已被回答、问题面向特定某人、属于私人或情绪话题、超出 bot 能力域。',
].join('\n');

const SCENE_4_CRITERIA = [
  'SCENE-4 指代：消息没有 @ bot，但谈到了对 bot 的指代。',
  '先判方向——是「在对 bot 说」，还是「在议论 bot」：',
  'speak：用户的话其实是说给 bot 的（提问、请求、确认 bot 的能力或状态）。',
  'silent：只是在议论 bot（例如评价 bot 好不好用、讨论要不要换个机器人）、',
  '  或者「机器人」指的是别的东西、或者话题与 bot 无关。',
  '注意：这类介入最容易被当成抢话，只在明确是对话时才说。',
].join('\n');

const SCENE_5_CRITERIA = [
  'SCENE-5 兴趣 / 性格话题：讨论命中了 bot 的兴趣池条目（见【兴趣池】）。',
  'speak：话题停在「没有结论」或「没人动手」处，且 bot 能补一句**可以立刻使用**的结果',
  '  （一条结论、一段代码、一张图、一个文件），而不是附和、评论或感想。',
  'silent：话题仍在推进、已有群友给了同等或更好的答案、bot 只能贡献感想、',
  '  该条目在本话题已经说过一次（每话题每条目至多 1 次）。',
  '这是门槛最高的一类：说不出有用的话就不说。',
].join('\n');

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

/**
 * 场景顺序（越小越优先）——**建议值，待维护者拍板**（方案 §11.1）：
 *
 *   4 指代（被点到名字）→ 1 续聊追问（刚聊过的延续）→ 3 无人应答（时效最紧）
 *   → 2 持续讨论（最需克制）→ 5 兴趣 / 性格（最容易饿死）
 *
 * 注意：优先级只决定「谁先被听到」，**不**决定能不能说——
 * 硬限流 / 焦点预算 / 准入 try 对所有场景一律生效（方案 §0.3）。
 */
export const SCENE_ORDER: readonly SceneId[] = [
  'scene-4',
  'scene-1',
  'scene-3',
  'scene-2',
  'scene-5',
];

export const SCENE_DEFINITIONS: readonly SceneDefinition[] = [
  {
    id: 'scene-1',
    order: SCENE_ORDER.indexOf('scene-1'),
    name: '续聊追问',
    enabled: true,
    triggers: ['message', 'speak-followup'],
    criteria: SCENE_1_CRITERIA,
    precheck: (ctx) => {
      if (ctx.inBotTopicWindow !== true) return undefined;
      const lastBotSpeakAt = ctx.lastBotSpeakAt;
      if (lastBotSpeakAt === undefined) return undefined;
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
    order: SCENE_ORDER.indexOf('scene-2'),
    name: '持续讨论',
    enabled: true,
    triggers: ['topic-roll'],
    criteria: SCENE_2_CRITERIA,
    precheck: (ctx) => {
      const humans = ctx.recentHumanCount ?? 0;
      const messages = ctx.recentMessageCount ?? 0;
      if (humans < 2 || messages < 3) return undefined;
      if ((ctx.topic?.botSpeaks ?? 0) > 0) return undefined;
      return { confidence: 0.4, evidence: `近窗 ${messages} 条 / ${humans} 人` };
    },
  },
  {
    id: 'scene-3',
    order: SCENE_ORDER.indexOf('scene-3'),
    name: '无人应答',
    enabled: true,
    triggers: ['question-probe'],
    criteria: SCENE_3_CRITERIA,
    precheck: (ctx) => {
      if ((ctx.pendingQuestionCount ?? 0) <= 0) return undefined;
      return {
        confidence: 0.7,
        evidence: `台账挂起 ${ctx.pendingQuestionCount ?? 0} 个问题`,
      };
    },
  },
  {
    id: 'scene-4',
    order: SCENE_ORDER.indexOf('scene-4'),
    name: '指代',
    enabled: true,
    triggers: ['message'],
    criteria: SCENE_4_CRITERIA,
    precheck: (ctx) => {
      const hit = detectBotReference({
        text: ctx.message.text,
        botAliases: ctx.botAliases,
        atSelf: ctx.message.atSelf === true,
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
    order: SCENE_ORDER.indexOf('scene-5'),
    name: '兴趣 / 性格话题',
    enabled: true,
    triggers: ['topic-roll'],
    criteria: SCENE_5_CRITERIA,
    precheck: (ctx) => {
      const ids = ctx.matchedInterestIds ?? [];
      if (ids.length === 0) return undefined;
      if ((ctx.topic?.botSpeaks ?? 0) > 0) return undefined;
      return { confidence: 0.35, evidence: `兴趣条目：${ids.join(', ')}` };
    },
  },
];

/** 按 order 升序的场景清单（registry 的装配结果；顺序唯一来源见 `SCENE_ORDER`）。 */
export const SCENE_REGISTRY: readonly SceneDefinition[] = [...SCENE_DEFINITIONS].sort(
  (left, right) => left.order - right.order,
);

/**
 * 「没人理我就停」的全局保险：连续若干次介入后群里毫无回应 → 所有场景一起沉默
 * （任何用户发言即归零）。它刻意**不是**某个场景的判据——没人理是会话级事实，
 * 不该由某个场景独自承担（生态对照：astrbot 主动聊天的 `unanswered_count`）。
 */
export const DEFAULT_MAX_UNANSWERED_STREAK = 2;

export function isMutedByNoResponse(
  ctx: ScenePrecheckContext,
  maxStreak: number = DEFAULT_MAX_UNANSWERED_STREAK,
): boolean {
  return (ctx.unansweredStreak ?? 0) >= maxStreak;
}

export function getScene(id: SceneId): SceneDefinition | undefined {
  return SCENE_REGISTRY.find((scene) => scene.id === id);
}

/** 某场景是否在给定触发来源下参与仲裁（场景 2/5 因此永远不会被每条消息惊动）。 */
export function scenesForTrigger(trigger: SceneTrigger): readonly SceneDefinition[] {
  return SCENE_REGISTRY.filter(
    (scene) => scene.enabled && scene.triggers.includes(trigger),
  );
}

/** 按全局顺序排列场景 id（仲裁输出与 trace 都用它归一化）。 */
export function sortSceneIds(ids: readonly SceneId[]): SceneId[] {
  return [...ids].sort(
    (left, right) => (getScene(left)?.order ?? 0) - (getScene(right)?.order ?? 0),
  );
}

/**
 * 「同时命中多个场景时取第一个」的唯一实现（方案 §1.1）。
 * 输入的顺序无关紧要——结果由 `SCENE_ORDER` 决定，因而可复现、可测试。
 */
export function selectScene(hits: readonly SceneId[]): {
  winner?: SceneId;
  alsoMatched: SceneId[];
} {
  const sorted = sortSceneIds(hits);
  const winner = sorted[0];
  return winner === undefined
    ? { alsoMatched: [] }
    : { winner, alsoMatched: sorted.slice(1) };
}

/**
 * 统一入口：按触发来源收集本地预筛命中。
 *
 * 这里集中两件**全局**的事，任何场景都不必自己重复：
 *   1. 「没人理我就停」保险（§9 / 生态对照 astrbot）——命中即全体沉默；
 *   2. 只跑该触发面下的场景（场景 2/5 永远不会被每条消息惊动）。
 * 返回的 Map 顺序即 `SCENE_ORDER`，可直接喂给 `renderSceneCriteria`。
 */
export function collectSceneHits(
  trigger: SceneTrigger,
  ctx: ScenePrecheckContext,
  maxUnansweredStreak: number = DEFAULT_MAX_UNANSWERED_STREAK,
): Map<SceneId, SceneHit> {
  const hits = new Map<SceneId, SceneHit>();
  if (isMutedByNoResponse(ctx, maxUnansweredStreak)) return hits;
  for (const scene of scenesForTrigger(trigger)) {
    const hit = scene.precheck?.(ctx);
    if (hit !== undefined) hits.set(scene.id, hit);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// prompt 渲染与解析辅助
// ---------------------------------------------------------------------------

/**
 * 把有资格参与本次仲裁的场景渲染成 LLM 的 criteria 正文。
 * `precheck` 未命中的场景**也在清单里**，但标注 `（本地未命中）`——
 * 这是为了让模型仍有机会推翻本地预筛（例如别名表没覆盖到的新叫法），
 * 代价只是几十个 token。
 */
export function renderSceneCriteria(
  trigger: SceneTrigger,
  hits: ReadonlyMap<SceneId, SceneHit>,
): string {
  const lines: string[] = [
    `【本次触发来源】${trigger}`,
    '【场景判定规则】若多个场景同时成立，**只输出 order 最小的那个**；',
    '若没有任何场景成立，输出 decision=silent 并给出理由。',
    '',
  ];
  for (const scene of scenesForTrigger(trigger)) {
    const hit = hits.get(scene.id);
    lines.push(`── order ${scene.order}｜${scene.id} ${scene.name}${hit === undefined ? '（本地未命中）' : ''}`);
    lines.push(scene.criteria);
    lines.push('');
  }
  return lines.join('\n');
}

/** 仲裁输出的 JSON 契约（gate-client 负责拼在 system 段；严格 JSON，解析失败即 silent）。 */
export const SCENE_OUTPUT_CONTRACT = [
  '你只能输出一个 JSON 对象，不要输出任何其他内容：',
  '{"scenario":"scene-1|scene-2|scene-3|scene-4|scene-5",',
  ' "decision":"speak|wait|silent","confidence":0.0,',
  ' "reason":"<20字内理由>","alsoMatched":[],"evidence":"","directive":""}',
  'scenario 必须是本次清单里出现过的场景 id；decision 只能是 speak / wait / silent。',
  '多场景同时成立时，scenario 只填 order 最小的那个，其余填进 alsoMatched。',
].join('\n');

/** 把模型输出（未知类型）解析成 SceneVerdict；失败返回 undefined（调用方按 silent 处理）。 */
export function parseSceneVerdict(raw: unknown, allowed: readonly SceneId[]): SceneVerdict | undefined {
  const record = asRecord(raw);
  const scenario = record['scenario'];
  const decision = record['decision'];
  if (typeof scenario !== 'string' || !allowed.includes(scenario as SceneId)) return undefined;
  if (decision !== 'speak' && decision !== 'wait' && decision !== 'silent') return undefined;

  const confidence = asNumber(record['confidence']);
  const reason = record['reason'];
  const alsoMatchedRaw = record['alsoMatched'];
  const alsoMatched = Array.isArray(alsoMatchedRaw)
    ? alsoMatchedRaw.filter(
        (item): item is SceneId => typeof item === 'string' && allowed.includes(item as SceneId),
      )
    : [];

  const verdict: SceneVerdict = {
    scenario: scenario as SceneId,
    decision,
    confidence: confidence === undefined ? 0 : Math.min(1, Math.max(0, confidence)),
    reason: typeof reason === 'string' && reason !== '' ? reason : '(无理由)',
  };
  if (alsoMatched.length > 0) verdict.alsoMatched = alsoMatched;
  for (const key of ['evidence', 'question', 'directive'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') verdict[key] = value;
  }
  return verdict;
}
