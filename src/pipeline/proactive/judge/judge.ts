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

import {
  isSessionDirective,
  isWaitReason,
  SCENE_ORDER,
  sceneOrder,
  type SceneCandidate,
  type SceneEvidence,
  type SceneId,
  type SceneVerdict,
  type SessionDirective,
} from '../contract.js';

// ---------------------------------------------------------------------------
// 每个场景的判据正文（自然语言；需求即 prompt）
// ---------------------------------------------------------------------------

const SCENE_1_CRITERIA = [
  'SCENE-1 续聊追问：bot 刚参与过这个话题，现在有人就同一话题继续追问或延伸。',
  '成立条件：与 bot 上一条发言同一话题，且该疑问尚未被任何人解决（含提问者自己）。',
  '不成立：只是继续闲聊、话题已转向、已被群友充分回答。',
  '纠错纪律：只纠**可确证**的事实（可枚举、可计算、可查证），必须给出被纠错的原文片段；',
  '观点、偏好、预测、价值判断一律不成立；不确定就判不成立，不要"温和地补充一点"。',
].join('\n');

const SCENE_2_CRITERIA = [
  'SCENE-2 持续讨论：多名群友围绕一个话题来回讨论，bot 没有参与。',
  '三个条件至少一个成立：',
  '  (a) 讨论中出现了 bot 具备的能力域需求（查资料 / 跑代码脚本 / 数据与图表 / 文件生成转换 / 多步任务）；',
  '  (b) 存在无人应答且 bot 能答的问题；',
  '  (c) 有人说了可确证的事实性错误。',
  '并且必须能提供**信息增量**——群友已经说清楚的东西不要复述。',
  '不成立：纯观点碰撞、情绪与闲聊、玩笑、已被群友充分回答、bot 无信息增量。',
  '这是最容易被反感的一类介入：宁可漏，不可多。',
].join('\n');

/**
 * 场景 3 的**三态**判据。
 *
 * 改写理由（见 docs/WAIT-CONVERGENCE-REQUIREMENT.md）：旧版让模型对一件
 * "要不要等"的事回答一个布尔值，于是一个布尔值同时承担了三件时间尺度完全
 * 不同的事，最后被实现成一个不绑定任何对象的新调度机制（占比 46%、产出为零）。
 * 现在模型必须说清**是哪种"先别说"**，而每种理由对应完全不同的唤醒责任人。
 */
const SCENE_3_CRITERIA = [
  'SCENE-3 无人应答：会话里有一个具体问题长时间没人回答。',
  '只考虑【结构化事实】里列出的挂起问题；没有挂起问题就判不成立。',
  '成立条件：问题仍未被回答 + 落在 bot 能力域内 + 已静默足够久（越久越应该答）。',
  '若你认为"先别说"，判 satisfied=false，并用 waitReason 说明是**哪一种**先别说：',
  '  - "yielding"：有人在答（正在打字、刚接话、刚补充信息）→ 过几十秒再看；',
  '  - "not-yet" ：还没到时候（问题太新、话题刚起）→ 交给既有的 90 秒探针；',
  '  - "watching"：bot 刚说完、正在看反应 → 不排唤醒，等群里下一条消息。',
  'waitReason 必须如实反映现场：没人在答就不要给 "yielding"。',
  '若给出 "yielding"，必须把你所指的那个挂起问题的 id（见【结构化事实】）原样写进',
  'evidence，例如 "q:msg-123@1700000000000"；给不出有效 id 时请改用 "not-yet"。',
  '不成立且不涉及等待：问题已被回答、问题面向特定某人、私人或情绪话题、超出 bot 能力域。',
].join('\n');

/**
 * 话题 session 的**三态指引**（判定层新增的一段正文，见需求 §六）。
 *
 * 为什么单独抽成一段而不是重复进五个场景：`session` 是**会话级**字段，
 * 与"哪个场景成立"无关——每个场景都抄一遍只会让判据变长、口径漂移。
 *
 * 为什么必须是三态（`new-topic` 那一档的由来）：维护者口径是"session 不由预算
 * 驱动，它的驱动动机只是话题"。预算用尽后要重新开一个会话，就必须有人说明
 * **话题已经换了**——那是语义判断，只有模型能做。两态时这句话无处表达，
 * 只能靠"关掉旧会话、下次唤醒再开"，于是"预算一重置就能接着说"，预算形同虚设。
 */
const SESSION_CRITERIA = [
  '关于「话题会话」（session，会话级，不是场景级）：',
  '代码会记住"这次话题是 bot 主动开口聊起来的"，并给这个话题几句话的发言预算；',
  '预算用完它就会在这个话题里闭嘴（代码里的硬闸门），要重新开口必须**换话题**。',
  '每次判定你都要回答：**当前这段对话的话题，应该有一个怎样的会话**。三选一：',
  '  - "keep-open"：还是刚才那个话题，会话该继续（没有会话就开一个）；',
  '  - "close"   ：刚才那个话题已经收口——问题被答了、讨论有结论了。会话到此为止；',
  '    注意：给 close 时，本次该说的这句**照样会说**，关闭只影响之后；',
  '  - "new-topic"：**已经换到另一个话题了**（和你前面几句聊的不是一回事）。',
  '    代码会关掉旧会话，并为现在这个新话题重新开始一个（预算重置）。',
  '判断依据是**这段对话本身**（转录 + 结构化事实），不是时间过去了多久：',
  '只是在同一件事上继续问、继续补充 → "keep-open"；说到另一件事上了 → "new-topic"。',
  '即使这次没有场景成立，只要你认为话题收口了，也可以给 "close"。',
  '拿不准就给 "keep-open"：预算与静默超时是代码里的硬闸门，不需要你替它省。',
].join('\n');

const SCENE_4_CRITERIA = [
  'SCENE-4 指代：消息没有 @ bot，但谈到了对 bot 的指代。',
  '先判方向——是"在对 bot 说"，还是"在议论 bot"：',
  '成立：用户的话其实是说给 bot 的（提问、请求、确认 bot 的能力或状态）。',
  '不成立：只是在议论 bot（评价 bot 好不好用、讨论要不要换个机器人）、',
  '  "机器人"指的是别的东西、或话题与 bot 无关。',
  '这类介入最容易被当成抢话：只在明确是对话时才判成立。',
].join('\n');

const SCENE_5_CRITERIA = [
  'SCENE-5 兴趣 / 性格话题：讨论命中了 bot 的兴趣池条目（见【结构化事实】）。',
  '成立条件：话题停在"没有结论"或"没人动手"处，且 bot 能补一句**可以立刻使用**的结果',
  '  （一条结论、一段代码、一张图、一个文件），而不是附和、评论或感想。',
  '不成立：话题仍在推进、已有群友给了同等或更好的答案、bot 只能贡献感想、',
  '  该条目在本话题已经说过一次。',
  '这是门槛最高的一类：说不出有用的话就不成立。',
].join('\n');

const CRITERIA_TEXT: Readonly<Record<SceneId, string>> = {
  'scene-1': SCENE_1_CRITERIA,
  'scene-2': SCENE_2_CRITERIA,
  'scene-3': SCENE_3_CRITERIA,
  'scene-4': SCENE_4_CRITERIA,
  'scene-5': SCENE_5_CRITERIA,
};

/**
 * 判据清单，**按 SCENE_ORDER 排列**——顺序在这里由构造方式保证，
 * 而不是靠人工维护的一致性（新增场景若忘了加 criteria，这里会少一项，
 * 契约测试立刻失败）。
 */
export const SCENE_CRITERIA: ReadonlyArray<{ scene: SceneId; criteria: string }> =
  SCENE_ORDER.map((scene) => ({ scene, criteria: CRITERIA_TEXT[scene] }));

function criteriaFor(scene: SceneId): string {
  return CRITERIA_TEXT[scene];
}

// ---------------------------------------------------------------------------
// prompt 渲染
// ---------------------------------------------------------------------------

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
export function extractWaitTargetId(evidence: string | undefined): string | undefined {
  if (evidence === undefined) return undefined;
  const matched = /q:([^\s，。；、）)"'】\]]+)/i.exec(evidence);
  return matched?.[1];
}

/** 结构化事实块：把状态计数交给模型，省掉"从转录里数数"的幻觉来源。 */
function renderFacts(evidence: SceneEvidence, candidates: readonly SceneCandidate[]): string {
  const lines = [`触发来源：${evidence.trigger}`];
  if (evidence.pendingQuestions.length > 0) {
    lines.push(`挂起问题（要给 yielding 就回抄它的 id）：`);
    for (const question of evidence.pendingQuestions) {
      lines.push(
        `  id=${WAIT_TARGET_PREFIX}${question.id}｜${question.askerLabel}：${question.text}` +
          `（已静默 ${question.silentSeconds} 秒，探针 ${question.probes} 次）`,
      );
    }
  }
  if (evidence.session !== undefined) {
    const openedSeconds = Math.max(0, Math.round((evidence.now - evidence.session.openedAt) / 1000));
    const spoke =
      evidence.session.lastSpokeAt === undefined
        ? '还没在本会话里发过言'
        : `上次发言 ${Math.max(0, Math.round((evidence.now - evidence.session.lastSpokeAt) / 1000))} 秒前`;
    lines.push(
      `本话题会话（session）：已开启 ${openedSeconds} 秒，${spoke}，` +
        `本话题预算还剩 ${evidence.session.budgetLeft} 句`,
    );
    if (evidence.session.budgetLeft <= 0) {
      lines.push(
        '⚠️ 本话题的预算已用尽：代码会挡住你在**这个话题**里继续发言。' +
          '若你判断话题已经换了，给 session="new-topic"（会重新开始一个会话）；' +
          '若还是同一个话题，给 "keep-open" 即可（代码不会放行）。',
      );
    }
  } else {
    lines.push('本话题会话（session）：当前没有开启中的会话');
  }
  if (evidence.topic !== undefined) {
    lines.push(
      `当前话题：${evidence.topic.id}（参与 ${evidence.topic.humanParticipants} 人，` +
        `bot 在该话题发过 ${evidence.topic.botSpeaks} 次）`,
    );
  }
  if (evidence.lastBotSpeakAt !== undefined) {
    const seconds = Math.max(0, Math.round((evidence.now - evidence.lastBotSpeakAt) / 1000));
    lines.push(`bot 上次在本群发言：${seconds} 秒前`);
  }
  lines.push(`近窗群消息：${evidence.recentMessageCount} 条 / ${evidence.recentHumanCount} 人`);
  lines.push(`挂起问题数（无人应答台账）：${evidence.pendingQuestionCount}`);
  if (evidence.matchedInterestIds.length > 0) {
    lines.push(`命中的兴趣池条目：${evidence.matchedInterestIds.join('、')}`);
  }
  lines.push(`连续未被回应的介入次数：${evidence.unansweredStreak}`);
  if (evidence.waitWakeup !== undefined) {
    lines.push(
      `本次是**让路后的重查**：你上一轮说"有人在答"，现在已过 ` +
        `${Math.round(evidence.waitWakeup.yieldedForMs / 1000)} 秒，对象是 ` +
        `${WAIT_TARGET_PREFIX}${evidence.waitWakeup.targetId}。`,
    );
  }
  if (candidates.length > 0) {
    const local = candidates
      .map((item) => `${item.scene}(本地置信 ${item.localConfidence.toFixed(2)})`)
      .join('、');
    lines.push(`本地预筛认为可能成立的场景：${local}`);
  }
  return `<结构化事实>\n${lines.join('\n')}\n</结构化事实>`;
}

/**
 * 渲染 system 段的判据清单：**只列本次候选场景**（及其顺序），
 * 并要求逐场景给出判定。顺序由 `SCENE_ORDER` 决定，与 prompt 的措辞无关——
 * 这就是"顺序可参数化、可回放对比"的前提。
 */
export function renderJudgeCriteria(candidates: readonly SceneCandidate[]): string {
  const ordered = [...candidates].sort(
    (left, right) => sceneOrder(left.scene) - sceneOrder(right.scene),
  );
  const lines: string[] = [
    '你是 QQ 群里一个**任务型助手**（能查资料、跑代码、执行多步任务）的发言守门人。',
    '你的唯一工作是：判断下面列出的**每一个候选场景**是否成立。',
    '',
    '规则：',
    '1. 逐个候选场景给出判定，不要遗漏、不要新增清单外的场景；',
    '2. 场景之间**不互斥**——可以多个同时成立；谁最终发言不是你的决定，',
    '   你只需如实判定每个场景；',
    '3. `confidence` 是你对该判定的把握（0..1），不是"该不该说话"的意愿；',
    '4. 场景 1/2 的"事实性错误"只认**可确证**的事实，必须把被纠错的原文片段写进 `evidence`；',
    '5. 如果你认为"现在不该说"，把该场景判 `satisfied:false` 并用 `waitReason` 说明',
    '   是**哪一种**先别说（三选一，见该场景判据）；是否真的等待、等多久，仍由代码决定；',
    '6. `waitReason` 只能是 "yielding" / "not-yet" / "watching" / ""（空串 = 不是在等）；',
    '7. `session` 只能是 "keep-open" / "close" / "new-topic"（含义见下）；',
    '8. 宁缺勿滥：不确定就判不成立。',
    '',
    SESSION_CRITERIA,
    '',
  ];
  for (const candidate of ordered) {
    lines.push(`── ${candidate.scene}（优先级第 ${sceneOrder(candidate.scene) + 1} 位）`);
    lines.push(criteriaFor(candidate.scene));
    if (candidate.evidence !== undefined) lines.push(`本地看到的证据：${candidate.evidence}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 仲裁输出的 JSON 契约（由 gate-client 固定拼接在 system 段尾）。
 * 未知场景 id / 非法字段一律由 `parseSceneVerdicts` 丢弃，绝不整条降级。
 *
 * 相比上一版**只加了一个字段** `session`（需求 §六）。
 */
export const JUDGE_OUTPUT_CONTRACT = [
  '你只能输出一个 JSON 对象，不要输出任何其他内容：',
  '{"verdicts":[{"scene":"scene-1","satisfied":true,"confidence":0.0,',
  ' "reason":"<20字内理由>","evidence":"","directive":"","waitReason":"",',
  ' "session":"keep-open"}]}',
  'verdicts 必须覆盖上面列出的每一个候选场景 id，且只能是这些 id。',
  'satisfied 为布尔值；confidence 为 0..1 的数；evidence/directive 可为空字符串。',
  'waitReason 三选一或空串："yielding"（有人在答）/"not-yet"（还没到时候）',
  ' /"watching"（刚说完看反应）；只有 satisfied=false 时才可能有值。',
  'session 三选一："keep-open"（这个话题继续）/"close"（这个话题收口了）',
  ' /"new-topic"（已经换到另一个话题，会话应当重新开始）。',
].join('\n');

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

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
export function parseSceneVerdicts(
  raw: string,
  candidates: readonly SceneCandidate[],
): readonly SceneVerdict[] | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const text = (fenced?.[1] ?? raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const list = asRecord(parsed)['verdicts'];
  if (!Array.isArray(list)) return undefined;

  const allowed = new Set<SceneId>(candidates.map((item) => item.scene));
  const byScene = new Map<SceneId, SceneVerdict>();
  for (const item of list) {
    const record = asRecord(item);
    const scene = record['scene'];
    if (typeof scene !== 'string' || !allowed.has(scene as SceneId)) continue;
    const confidence = record['confidence'];
    const satisfied = record['satisfied'] === true;
    // waitReason 只认三个合法值：模型编出来的第四个值一律丢弃（不是整条降级）。
    // 已经是 satisfied 的判定不再带理由——"成立"与"先别说"不可能同时为真。
    const rawReason = record['waitReason'];
    const waitReason = !satisfied && isWaitReason(rawReason) ? rawReason : undefined;
    // session 指令（会话级）：与 satisfied 无关，两个方向都要如实收下——
    // `close` + `satisfied:false` 是合法组合（"该收口了"与"这次没什么可补"
    // 是两个维度，见需求边界表）。非法值一律丢弃。
    const rawSession = record['session'];
    const session: SessionDirective | undefined = isSessionDirective(rawSession)
      ? rawSession
      : undefined;
    const verdict: SceneVerdict = {
      scene: scene as SceneId,
      satisfied,
      confidence:
        typeof confidence === 'number' && Number.isFinite(confidence)
          ? clamp01(confidence)
          : 0,
      reason: optionalString(record, 'reason') ?? '(无理由)',
      ...(optionalString(record, 'evidence') === undefined
        ? {}
        : { evidence: optionalString(record, 'evidence') as string }),
      ...(optionalString(record, 'directive') === undefined
        ? {}
        : { directive: optionalString(record, 'directive') as string }),
      ...(waitReason === undefined ? {} : { waitReason }),
      ...(session === undefined ? {} : { session }),
    };
    byScene.set(verdict.scene, verdict);
  }
  if (byScene.size === 0) return undefined; // 一条有效判定都没有 = 解析失败

  return candidates.map((candidate) => {
    const found = byScene.get(candidate.scene);
    return (
      found ?? {
        scene: candidate.scene,
        satisfied: false,
        confidence: 0,
        reason: '模型未给出该场景判定（按不成立处理）',
      }
    );
  });
}

/** 供测试与文档使用：当前场景全集（顺序即优先级）。 */
export const SCENE_IDS: readonly SceneId[] = [...SCENE_ORDER];
