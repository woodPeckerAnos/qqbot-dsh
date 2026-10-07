/**
 * 主动介入**三层契约测试**（纯函数、离线、不触网、不需要真 LLM）。
 *
 * 三组用例分别锁住三层的边界：
 *   ① 搜集层：纯本地、只判断"有没有可能"、执行全局保险、不做裁决
 *   ② LLM 层：逐场景多标签、容错（未知标签丢弃而非整条降级）、prompt 可复现
 *   ③ 否决层：**「取第一个」与所有额度的唯一实现**，可穷举、可解释
 *
 * 三层的独立性由用例显式断言：搜集层不需要 LLM，LLM 层不需要额度，
 * 否决层不需要消息文本。
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SCENE_ORDER,
  sceneOrder,
  sortSceneIds,
  type SceneCandidate,
  type SceneEvidence,
  type SceneVerdict,
  type VetoContext,
} from '../src/pipeline/proactive/contract.js';
import type { NormalizedMessage } from '../src/core/connector.js';
import { ConversationState } from '../src/pipeline/proactive/scene/state.js';
import {
  SCENE_REGISTRY,
  buildSceneEvidence,
  collectCandidates,
  detectBotReference,
  getScene,
  scenesForTrigger,
} from '../src/pipeline/proactive/scene/collect.js';
import {
  JUDGE_OUTPUT_CONTRACT,
  SCENE_CRITERIA,
  parseSceneVerdicts,
  renderJudgeCriteria,
} from '../src/pipeline/proactive/judge/judge.js';
import { parseInterestPool } from '../src/pipeline/proactive/interests/pool.js';
import {
  DEFAULT_VETO_POLICY,
  evaluateVeto,
  selectByQuantileBudget,
} from '../src/pipeline/proactive/veto/veto.js';

/** 当前生效场景的**自然语言真相源**（人话版说明书）。 */
const SCENES_DOC = '../src/pipeline/proactive/interests/SCENES.md';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function evidence(overrides: Partial<SceneEvidence> = {}): SceneEvidence {
  return {
    convKey: 'ob11:g123456',
    trigger: 'message',
    now: 1_000_000,
    message: { msgId: 'm1', senderId: 'u1', senderName: '张三', text: '' },
    botAliases: ['小助手'],
    inBotTopicWindow: false,
    recentMessageCount: 0,
    recentHumanCount: 0,
    pendingQuestionCount: 0,
    matchedInterestIds: [],
    unansweredStreak: 0,
    ...overrides,
  };
}

/** 造一条旁听消息（旁听不需要 parts，只要判定需要的字段）。 */
function makeObserved(msgId: string, senderId: string, text: string, ts: number): NormalizedMessage {
  return {
    kind: 'group-message',
    target: { platform: 'onebot', kind: 'group', id: '1', key: 'ob11:g1' },
    eventId: `evt-${msgId}`,
    msgId,
    senderId,
    content: text,
    ts,
    raw: {},
  };
}

function candidate(
  scene: SceneCandidate['scene'],
  overrides: Partial<SceneCandidate> = {},
): SceneCandidate {
  return { scene, localConfidence: 0.5, expectedRate: 0.4, ...overrides };
}

function verdict(
  scene: SceneVerdict['scene'],
  overrides: Partial<SceneVerdict> = {},
): SceneVerdict {
  return { scene, satisfied: true, confidence: 0.8, reason: '成立', ...overrides };
}

function vetoContext(overrides: Partial<VetoContext> = {}): VetoContext {
  return {
    now: 1_000_000,
    spokeCount10Min: 0,
    spokeCount1Hour: 0,
    topicBotSpeaks: 0,
    waitRetries: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 顺序（三层共用的唯一来源）
// ---------------------------------------------------------------------------

describe('顺序唯一来源', () => {
  it('验收1：registry 与 SCENE_ORDER 完全一致，order 由下标决定', () => {
    expect(SCENE_ORDER).toEqual(['scene-4', 'scene-1', 'scene-3', 'scene-2', 'scene-5']);
    expect(SCENE_REGISTRY.map((scene) => scene.id)).toEqual([...SCENE_ORDER]);
    for (const [index, id] of SCENE_ORDER.entries()) expect(sceneOrder(id)).toBe(index);
    expect(sceneOrder('scene-9' as never)).toBe(SCENE_ORDER.length);
    expect(sortSceneIds(['scene-5', 'scene-4', 'scene-1'])).toEqual([
      'scene-4',
      'scene-1',
      'scene-5',
    ]);
  });
});

// ---------------------------------------------------------------------------
// ① 搜集层
// ---------------------------------------------------------------------------

describe('① 搜集层：本地、只判断可能、不做裁决', () => {
  it('验收2：触发面绑定——弱信号场景（2/5）永远不会被每条消息惊动', () => {
    expect(scenesForTrigger('message').map((scene) => scene.id)).toEqual(['scene-4', 'scene-1']);
    expect(scenesForTrigger('topic-roll').map((scene) => scene.id)).toEqual(['scene-2', 'scene-5']);
    expect(scenesForTrigger('question-probe').map((scene) => scene.id)).toEqual(['scene-3']);
  });

  it('验收3：候选按全局顺序输出，且不需要任何 LLM', () => {
    const hits = collectCandidates(
      evidence({
        inBotTopicWindow: true,
        lastBotSpeakAt: 999_000,
        topic: { id: 't1', startedAt: 990_000, lastAt: 999_500, humanParticipants: 2, botSpeaks: 1 },
        message: { text: '小助手你刚才说的那个再讲一下', atSelf: false },
      }),
    );
    // 同时命中指代(4) 与续聊(1)：候选按 order 排，4 在前
    expect(hits.map((item) => item.scene)).toEqual(['scene-4', 'scene-1']);
    expect(hits[0]?.evidence).toContain('指代词');
    expect(hits[0]?.localConfidence).toBeGreaterThan(hits[1]?.localConfidence ?? 1);
  });

  it('验收4：全局保险（没人理我就停）在搜集层入口短路——不产生任何候选', () => {
    const noisy = evidence({
      matchedInterestIds: ['plotting'],
      recentHumanCount: 3,
      recentMessageCount: 6,
      trigger: 'topic-roll',
    });
    expect(collectCandidates(noisy, { maxUnansweredStreak: 2 }).length).toBeGreaterThan(0);
    expect(collectCandidates({ ...noisy, unansweredStreak: 2 }, { maxUnansweredStreak: 2 })).toEqual([]);
  });

  it('验收5：指代检测宁漏不误报——议论 bot 不算，@ 了 bot 也不算', () => {
    expect(detectBotReference({ text: '小助手你有空吗', botAliases: ['小助手'] })).toEqual({
      kind: 'alias',
      matched: '小助手',
    });
    expect(
      detectBotReference({ text: '小助手在吗', botAliases: ['小助手'], atSelf: true }),
    ).toBeUndefined();
    expect(detectBotReference({ text: '这机器人是不是坏了', botAliases: [] })).toBeUndefined();
    expect(detectBotReference({ text: '机器人能帮我转个表吗', botAliases: [] })).toEqual({
      kind: 'generic',
      matched: '机器人+帮我',
    });
  });

  it('验收6：场景 2 要求多人多轮且 bot 未参与；场景 5 要求命中兴趣且本话题没说过', () => {
    const scene2 = getScene('scene-2');
    expect(
      scene2?.precheck?.({ ...evidence({ recentHumanCount: 1, recentMessageCount: 9 }), scene: 'scene-2' }),
    ).toBeUndefined();
    expect(
      scene2?.precheck?.({ ...evidence({ recentHumanCount: 2, recentMessageCount: 3 }), scene: 'scene-2' }),
    ).toBeDefined();
    expect(
      scene2?.precheck?.({
        ...evidence({
          recentHumanCount: 3,
          recentMessageCount: 6,
          topic: { id: 't1', startedAt: 1, lastAt: 2, humanParticipants: 3, botSpeaks: 1 },
        }),
        scene: 'scene-2',
      }),
    ).toBeUndefined();

    const scene5 = getScene('scene-5');
    expect(
      scene5?.precheck?.({ ...evidence({ matchedInterestIds: [] }), scene: 'scene-5' }),
    ).toBeUndefined();
    expect(
      scene5?.precheck?.({ ...evidence({ matchedInterestIds: ['plotting'] }), scene: 'scene-5' }),
    ).toBeDefined();
  });

  it('验收7b：buildSceneEvidence 从会话状态与兴趣池推导全部字段（调用方不手填）', () => {
    const pool = parseInterestPool(
      'interests:\n  - {id: plotting, topic: 画图, keywords: [折线图]}',
      'test.yml',
    );
    const state = new ConversationState('ob11:g1', { activityWindowMs: 60_000 });
    const now = 1_000_000;
    // 两个人来回聊，其中一条是没被回答的问题
    state.observe(makeObserved('m1', 'u1', '折线图怎么画才好看', now - 30_000));
    state.observe(makeObserved('m2', 'u2', '这个我也不太会', now - 20_000));
    state.observe(makeObserved('m3', 'u1', '要不你画一个给我看看', now - 15_000));

    const built = buildSceneEvidence({
      state,
      trigger: 'topic-roll',
      now,
      message: { text: '折线图还是不行' },
      interests: pool,
      botAliases: ['小助手'],
    });
    expect(built.matchedInterestIds).toEqual(['plotting']);
    expect(built.botAliases).toEqual(['小助手']);
    expect(built.recentHumanCount).toBe(2);
    expect(built.recentMessageCount).toBe(3);
    expect(built.pendingQuestionCount).toBe(1);
    expect(built.unansweredStreak).toBe(0);
    expect(built.inBotTopicWindow).toBe(false);
    expect(built.topic?.id).toBe(`topic:${now - 30_000}`);
    // 场景 2 与 5 因此真的能进候选（这正是"字段恒为空"时做不到的）
    expect(collectCandidates(built).map((item) => item.scene)).toEqual(['scene-2', 'scene-5']);

    // 没配兴趣池 / 没配别名 → 空（场景 5 不触发，属预期），但计数照旧有生产者
    const bare = buildSceneEvidence({ state, trigger: 'topic-roll', now });
    expect(bare.matchedInterestIds).toEqual([]);
    expect(bare.botAliases).toEqual([]);
    expect(bare.recentHumanCount).toBe(2);
  });

  it('验收7c：bot 发言后无人回应 → 保险生效；有人回应 → 场景 1 的参与窗口打开', () => {
    const now = 2_000_000;
    const state = new ConversationState('ob11:g1', { activityWindowMs: 60_000 });
    state.observe(makeObserved('m1', 'u1', '帮我看看这个报错', now - 40_000));
    state.recordBotSpoke(now - 30_000);

    const afterBot = buildSceneEvidence({ state, trigger: 'message', now });
    expect(afterBot.inBotTopicWindow).toBe(true);
    expect(afterBot.topic?.botSpeaks).toBe(1);
    expect(afterBot.unansweredStreak).toBe(1);
    expect(collectCandidates(afterBot, { maxUnansweredStreak: 2 }).length).toBeGreaterThan(0);

    // 连续两次无人回应 → 全体静默（保险在 LLM 之前短路）
    state.recordBotSpoke(now - 20_000);
    const twice = buildSceneEvidence({ state, trigger: 'message', now });
    expect(twice.unansweredStreak).toBe(2);
    expect(collectCandidates(twice, { maxUnansweredStreak: 2 })).toEqual([]);

    // 有人说话 → 计数归零（并刷新活动窗口）
    state.observe(makeObserved('m2', 'u2', '我试了下还是不行', now - 10_000));
    const answered = buildSceneEvidence({ state, trigger: 'message', now });
    expect(answered.unansweredStreak).toBe(0);
    expect(collectCandidates(answered, { maxUnansweredStreak: 2 }).length).toBeGreaterThan(0);
  });

  it('验收7：估算权重优先取回放统计，缺省退化为先验', () => {
    const rated = collectCandidates(
      evidence({
        trigger: 'topic-roll',
        recentHumanCount: 2,
        recentMessageCount: 4,
        matchedInterestIds: ['x'],
        sceneRates: { 'scene-2': 0.9 },
      }),
    );
    expect(rated.map((item) => item.scene)).toEqual(['scene-2', 'scene-5']);
    expect(rated[0]?.expectedRate).toBe(0.9);
    expect(rated[1]?.expectedRate).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ② LLM 层
// ---------------------------------------------------------------------------

describe('② LLM 层：逐场景判定与容错', () => {
  const candidates = [candidate('scene-4'), candidate('scene-3')];

  it('验收8：prompt 只列候选场景，顺序与 SCENE_ORDER 一致（顺序可参数化的前提）', () => {
    const text = renderJudgeCriteria([candidate('scene-3'), candidate('scene-4')]);
    expect(text.indexOf('scene-4')).toBeLessThan(text.indexOf('scene-3'));
    expect(text).not.toContain('scene-5');
    expect(text).toContain('场景之间**不互斥**');
    expect(SCENE_CRITERIA.map((item) => item.scene)).toEqual([...SCENE_ORDER]);
    expect(JUDGE_OUTPUT_CONTRACT).toContain('verdicts');
  });

  it('验收9：合法输出解析为逐场景判定（覆盖全部候选、顺序与候选一致）', () => {
    const parsed = parseSceneVerdicts(
      JSON.stringify({
        verdicts: [
          { scene: 'scene-3', satisfied: true, confidence: 0.9, reason: '无人答', evidence: '谁能跑一下' },
          { scene: 'scene-4', satisfied: false, confidence: 0.2, reason: '在议论' },
        ],
      }),
      candidates,
    );
    expect(parsed?.map((item) => item.scene)).toEqual(['scene-4', 'scene-3']);
    expect(parsed?.[1]).toMatchObject({ satisfied: true, evidence: '谁能跑一下' });
  });

  it('验收10：一个幻觉标签不毁掉其余判定——未知场景丢弃、缺失场景补不成立', () => {
    const parsed = parseSceneVerdicts(
      JSON.stringify({
        verdicts: [
          { scene: 'scene-99', satisfied: true, confidence: 1, reason: '幻觉' },
          { scene: 'scene-3', satisfied: true, confidence: 5, reason: '无人答' },
        ],
      }),
      candidates,
    );
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]).toMatchObject({ scene: 'scene-4', satisfied: false }); // 缺失 → 不成立
    expect(parsed?.[1]).toMatchObject({ scene: 'scene-3', confidence: 1 }); // 5 被钳到 1
  });

  it('验收11：整条不可解析 / 无有效判定 → undefined（调用方按 silent；fail-closed）', () => {
    expect(parseSceneVerdicts('模型今天不想输出 JSON', candidates)).toBeUndefined();
    expect(parseSceneVerdicts('{"verdicts":"nope"}', candidates)).toBeUndefined();
    expect(
      parseSceneVerdicts('{"verdicts":[{"scene":"scene-99","satisfied":true}]}', candidates),
    ).toBeUndefined();
    const fenced = parseSceneVerdicts(
      '好的，结果如下：\n```json\n{"verdicts":[{"scene":"scene-3","satisfied":true,"confidence":0.7,"reason":"x"}]}\n```\n',
      candidates,
    );
    expect(fenced?.[1]).toMatchObject({ scene: 'scene-3', satisfied: true, confidence: 0.7 });
  });

  it('验收12：suggestsWait 被保留（是否采纳由否决层决定）', () => {
    const parsed = parseSceneVerdicts(
      JSON.stringify({
        verdicts: [
          { scene: 'scene-3', satisfied: false, confidence: 0.5, reason: '有人正在答', suggestsWait: true },
        ],
      }),
      candidates,
    );
    expect(parsed?.[1]?.suggestsWait).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ③ 否决层
// ---------------------------------------------------------------------------

describe('③ 否决层：顺序、额度与终局', () => {
  it('验收13：「取第一个」在这里落地——多场景同时成立时取 order 最小者', () => {
    const decision = evaluateVeto({
      candidates: [candidate('scene-4'), candidate('scene-1'), candidate('scene-3')],
      verdicts: [verdict('scene-1'), verdict('scene-3'), verdict('scene-4')],
      context: vetoContext(),
    });
    expect(decision).toMatchObject({
      action: 'speak',
      scene: 'scene-4',
      alsoMatched: ['scene-1', 'scene-3'],
    });
    const again = evaluateVeto({
      candidates: [candidate('scene-4'), candidate('scene-1'), candidate('scene-3')],
      verdicts: [verdict('scene-4'), verdict('scene-3'), verdict('scene-1')],
      context: vetoContext(),
    });
    expect(again).toMatchObject({ action: 'speak', scene: 'scene-4' });
  });

  it('验收14：顺序可被覆盖（回放对比 / A-B 的前提），且只影响裁决不影响判据', () => {
    const flipped = evaluateVeto({
      candidates: [candidate('scene-4'), candidate('scene-1')],
      verdicts: [verdict('scene-4'), verdict('scene-1')],
      context: vetoContext({ order: ['scene-1', 'scene-4'] }),
    });
    expect(flipped).toMatchObject({ action: 'speak', scene: 'scene-1' });
  });

  it('验收15：硬限流与话题预算只收紧不放宽，且先于预算裁决', () => {
    const limited = evaluateVeto(
      {
        candidates: [candidate('scene-4')],
        verdicts: [verdict('scene-4')],
        context: vetoContext({ spokeCount10Min: 3 }),
      },
      DEFAULT_VETO_POLICY,
    );
    expect(limited).toMatchObject({ action: 'silent', reason: 'rate-limit' });

    const hourly = evaluateVeto(
      {
        candidates: [candidate('scene-4')],
        verdicts: [verdict('scene-4')],
        context: vetoContext({ spokeCount1Hour: 8 }),
      },
      DEFAULT_VETO_POLICY,
    );
    expect(hourly).toMatchObject({ action: 'silent', reason: 'rate-limit' });

    const spent = evaluateVeto(
      {
        candidates: [candidate('scene-4')],
        verdicts: [verdict('scene-4')],
        context: vetoContext({ topicBotSpeaks: 1 }),
      },
      DEFAULT_VETO_POLICY,
    );
    expect(spent).toMatchObject({ action: 'silent', reason: 'topic-spent' });
  });

  it('验收16：无候选直接 silent（省一次 LLM 调用）；全判不成立 → no-scene', () => {
    expect(evaluateVeto({ candidates: [], verdicts: [], context: vetoContext() })).toMatchObject({
      action: 'silent',
      reason: 'no-candidate',
    });
    expect(
      evaluateVeto({
        candidates: [candidate('scene-4')],
        verdicts: [verdict('scene-4', { satisfied: false })],
        context: vetoContext(),
      }),
    ).toMatchObject({ action: 'silent', reason: 'no-scene' });
  });

  it('验收17：wait 建议由本层决定是否采纳，超过上限即 wait-exhausted', () => {
    const waiting: SceneVerdict = {
      scene: 'scene-3',
      satisfied: false,
      confidence: 0.5,
      reason: '有人正在答',
      suggestsWait: true,
    };
    const first = evaluateVeto({
      candidates: [candidate('scene-3')],
      verdicts: [waiting],
      context: vetoContext(),
    });
    expect(first).toMatchObject({ action: 'wait', scene: 'scene-3' });
    const second = evaluateVeto({
      candidates: [candidate('scene-3')],
      verdicts: [waiting],
      context: vetoContext({ waitRetries: 1 }),
    });
    expect(second).toMatchObject({ action: 'silent', reason: 'wait-exhausted' });
  });

  it('验收18：分位数预算默认关闭；开启后高权重场景自然突破且不产生空集合', () => {
    const scored = [
      { scene: 'scene-4' as const, score: 0.9, expectedRate: 0.4 },
      { scene: 'scene-5' as const, score: 0.1, expectedRate: 0.1 },
    ];
    expect(selectByQuantileBudget(scored, 1.0).has('scene-4')).toBe(true);
    // 预算再紧也至少放行一个（"收紧"而非"关掉"）
    expect(selectByQuantileBudget(scored, 0).size).toBe(1);

    const withBudget = evaluateVeto(
      {
        candidates: [candidate('scene-4'), candidate('scene-5', { expectedRate: 0.1 })],
        verdicts: [verdict('scene-4', { confidence: 0.9 }), verdict('scene-5', { confidence: 0.2 })],
        context: vetoContext(),
      },
      { ...DEFAULT_VETO_POLICY, quantileBudget: true, targetRate: 1.0 },
    );
    expect(withBudget).toMatchObject({ action: 'speak', scene: 'scene-4' });
  });

  it('验收19：否决层是纯函数——相同输入必然相同输出（离线回放可复现的前提）', () => {
    const input = {
      candidates: [candidate('scene-1'), candidate('scene-3')],
      verdicts: [verdict('scene-3', { confidence: 0.66 }), verdict('scene-1', { confidence: 0.9 })],
      context: vetoContext(),
    };
    expect(JSON.stringify(evaluateVeto(input))).toBe(JSON.stringify(evaluateVeto(input)));
  });
});

// ---------------------------------------------------------------------------
// 场景清单与自然语言文档的一致性（维护者约定：先写人话，再写代码）
// ---------------------------------------------------------------------------

describe('SCENES.md 与代码的一致（契约测试强制）', () => {
  const doc = readFileSync(fileURLToPath(new URL(SCENES_DOC, import.meta.url)), 'utf8');

  it('验收20：SCENE_ORDER 里每个场景都在自然语言文档里有一节，且描述里带场景名', () => {
    expect(doc).toContain('当前生效的主动介入场景');
    for (const [index, id] of SCENE_ORDER.entries()) {
      const scene = getScene(id);
      expect(scene).toBeDefined();
      // 每个生效场景必须有一节标题 "## 场景 N · 名字"
      const ordinal = id.replace('scene-', '');
      expect(doc).toContain(`## 场景 ${ordinal} · ${scene?.name}`);
      // 且给出它排第几（顺序也是文档的一部分）
      expect(doc).toContain(`| ${index + 1} | **${ordinal} · ${scene?.name}** |`);
    }
  });

  it('验收21：文档里描述的场景数与代码一致，不允许多写或少写', () => {
    const headings = [...doc.matchAll(/^## 场景 (\d+) · /gm)].map((match) => match[1]);
    expect(headings).toEqual(SCENE_ORDER.map((id) => id.replace('scene-', '')));
  });

  it('验收22b：SCENES.md 里的相对链接都指向真实存在的文件（文档不许指向不存在的路径）', () => {
    const links = [...doc.matchAll(/\]\((\.\.?\/[^)]+)\)/g)].map((match) => match[1] as string);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const resolved = fileURLToPath(new URL(link, new URL(SCENES_DOC, import.meta.url)));
      expect(existsSync(resolved), `SCENES.md 链接失效：${link}`).toBe(true);
    }
  });

  it('验收22：新增场景的约定写在文档里（先写人话再写代码，且指明要改的三处）', () => {
    expect(doc).toContain('后续新增场景');
    for (const file of ['contract.ts', 'collect.ts', 'judge.ts']) {
      expect(doc).toContain(file);
    }
    // 每个新场景必须交代的四件事
    for (const required of ['什么情况下出现', '什么算命中', '典型对话', '误报的代价']) {
      expect(doc).toContain(required);
    }
  });
});
