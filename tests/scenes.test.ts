/**
 * 主动介入**场景注册表契约测试**（纯函数、离线、不触网）。
 *
 * 这些用例锁的是 proposals 的「形状」，不是行为阈值：
 *   - 顺序唯一来源（`SCENE_ORDER`）与「取第一个」的确定性；
 *   - 触发平面绑定（场景 2/5 永远不被每条消息惊动）；
 *   - 场景 4 的指代预筛（别名 vs 泛称 + 动作词；@ 了 bot 不算）；
 *   - 仲裁输出的解析容错（未知场景 / 非法 decision / 置信度越界一律安全降级）。
 *
 * 实施 S1 时本文件随 `src/pipeline/proactive/scenes/registry.ts` 一起迁移。
 */

import { describe, expect, it } from 'vitest';

import {
  SCENE_ORDER,
  SCENE_REGISTRY,
  collectSceneHits,
  detectBotReference,
  getScene,
  parseSceneVerdict,
  renderSceneCriteria,
  scenesForTrigger,
  selectScene,
  sortSceneIds,
  type SceneId,
  type ScenePrecheckContext,
} from '../src/pipeline/proactive/scenes.js';

function makeContext(overrides: Partial<ScenePrecheckContext> = {}): ScenePrecheckContext {
  return {
    convKey: 'ob11:g123456',
    message: { msgId: 'm1', kind: 'group-message', senderId: 'u1', senderName: '张三', text: '' },
    botAliases: ['小助手'],
    now: 1_000_000,
    ...overrides,
  };
}

describe('场景注册表', () => {
  it('验收1：registry 按 order 升序，且与 SCENE_ORDER 完全一致', () => {
    const registryOrder = SCENE_REGISTRY.map((scene) => scene.id);
    expect(registryOrder).toEqual([...SCENE_ORDER]);
    // 顺序是下标绑定的，改 SCENE_ORDER 必须同时改 order 字段
    for (const [index, scene] of SCENE_REGISTRY.entries()) {
      expect(scene.order).toBe(index);
      expect(getScene(scene.id)).toBe(scene);
    }
  });

  it('验收2：触发平面绑定——场景 2/5 只走 topic-roll，场景 1/4 只走消息事件', () => {
    const onMessage = scenesForTrigger('message').map((scene) => scene.id);
    expect(onMessage).toContain('scene-1');
    expect(onMessage).toContain('scene-4');
    expect(onMessage).not.toContain('scene-2');
    expect(onMessage).not.toContain('scene-5');
    expect(onMessage).not.toContain('scene-3');

    expect(scenesForTrigger('topic-roll').map((scene) => scene.id)).toEqual([
      'scene-2',
      'scene-5',
    ]);
    expect(scenesForTrigger('question-probe').map((scene) => scene.id)).toEqual(['scene-3']);
  });

  it('验收3：取第一个——结果只由 order 决定，与输入顺序无关', () => {
    expect(selectScene(['scene-5', 'scene-1', 'scene-3'])).toEqual({
      winner: 'scene-1',
      alsoMatched: ['scene-3', 'scene-5'],
    });
    expect(selectScene(['scene-3', 'scene-1', 'scene-5'])).toEqual({
      winner: 'scene-1',
      alsoMatched: ['scene-3', 'scene-5'],
    });
    expect(selectScene([])).toEqual({ alsoMatched: [] });
    // 建议顺序：指代最优先
    expect(selectScene(['scene-1', 'scene-4']).winner).toBe('scene-4');
  });
});

describe('场景 4 指代预筛', () => {
  it('验收4：精确别名命中即高置信；@ 了 bot 走正常提问路径不算指代', () => {
    expect(detectBotReference({ text: '小助手你有空吗', botAliases: ['小助手'] })).toEqual({
      kind: 'alias',
      matched: '小助手',
    });
    expect(
      detectBotReference({ text: '小助手在吗', botAliases: ['小助手'], atSelf: true }),
    ).toBeUndefined();
  });

  it('验收5：泛称必须与动作词同现——「议论 bot」不触发，「对 bot 说」才触发', () => {
    expect(
      detectBotReference({ text: '这机器人是不是坏了，怎么不说话了', botAliases: [] }),
    ).toBeUndefined();
    expect(
      detectBotReference({ text: '机器人能帮我把这个表格转成 csv 吗', botAliases: [] }),
    ).toEqual({ kind: 'generic', matched: '机器人+帮我' });
    expect(detectBotReference({ text: '今天天气不错', botAliases: [] })).toBeUndefined();
  });
});

describe('场景 1/2/5 的本地预筛', () => {
  it('验收6：场景 1 只在「bot 参与过该话题」的窗口内出现', () => {
    const scene1 = getScene('scene-1');
    expect(scene1?.precheck?.(makeContext({ inBotTopicWindow: true }))).toBeUndefined();
    const hit = scene1?.precheck?.(
      makeContext({
        inBotTopicWindow: true,
        lastBotSpeakAt: 999_000,
        topic: { id: 't1', startedAt: 990_000, lastAt: 999_500, humanParticipants: 2, botSpeaks: 1 },
      }),
    );
    expect(hit?.confidence).toBeGreaterThan(0);
    expect(hit?.evidence).toContain('t1');
  });

  it('验收7：场景 2 要求多人 + 多轮且 bot 未参与；场景 5 要求命中兴趣条目且本话题未说过', () => {
    const scene2 = getScene('scene-2');
    expect(
      scene2?.precheck?.(makeContext({ recentHumanCount: 1, recentMessageCount: 9 })),
    ).toBeUndefined();
    expect(
      scene2?.precheck?.(makeContext({ recentHumanCount: 2, recentMessageCount: 3 })),
    ).toBeDefined();
    // bot 已经在这个话题里说过话 → 交给场景 1，场景 2 让位
    expect(
      scene2?.precheck?.(
        makeContext({
          recentHumanCount: 3,
          recentMessageCount: 6,
          topic: { id: 't1', startedAt: 1, lastAt: 2, humanParticipants: 3, botSpeaks: 1 },
        }),
      ),
    ).toBeUndefined();

    const scene5 = getScene('scene-5');
    expect(scene5?.precheck?.(makeContext({ matchedInterestIds: [] }))).toBeUndefined();
    expect(scene5?.precheck?.(makeContext({ matchedInterestIds: ['plotting'] }))).toBeDefined();
  });
});

describe('仲裁输出契约', () => {
  const allowed = [...SCENE_ORDER] as SceneId[];

  it('验收8：合法输出解析为 verdict（含 alsoMatched 过滤与置信度钳制）', () => {
    const verdict = parseSceneVerdict(
      {
        scenario: 'scene-3',
        decision: 'speak',
        confidence: 1.7,
        reason: '无人应答',
        alsoMatched: ['scene-5', 'scene-99', 42],
        evidence: '谁能跑一下',
      },
      allowed,
    );
    expect(verdict).toEqual({
      scenario: 'scene-3',
      decision: 'speak',
      confidence: 1,
      reason: '无人应答',
      alsoMatched: ['scene-5'],
      evidence: '谁能跑一下',
    });
  });

  it('验收9：未知场景 / 非法 decision / 非对象一律返回 undefined（调用方按 silent 处理）', () => {
    expect(parseSceneVerdict({ scenario: 'scene-9', decision: 'speak' }, allowed)).toBeUndefined();
    expect(parseSceneVerdict({ scenario: 'scene-1', decision: 'shout' }, allowed)).toBeUndefined();
    expect(parseSceneVerdict('speak', allowed)).toBeUndefined();
    expect(parseSceneVerdict(null, allowed)).toBeUndefined();
  });

  it('验收10：criteria 渲染按顺序、只含该触发面的场景、并标注本地未命中', () => {
    const text = renderSceneCriteria('message', new Map());
    const order4 = text.indexOf('scene-4');
    const order1 = text.indexOf('scene-1');
    expect(order4).toBeGreaterThanOrEqual(0);
    expect(order1).toBeGreaterThan(order4);
    expect(text).not.toContain('scene-2');
    expect(text).toContain('（本地未命中）');
  });
});

describe('全局保险与预筛收集', () => {
  it('验收11：没人理我就停——连续未回应达上限时所有场景一律不参与仲裁', () => {
    const noisy = {
      recentHumanCount: 3,
      recentMessageCount: 6,
      matchedInterestIds: ['plotting'],
      inBotTopicWindow: true,
      lastBotSpeakAt: 999_000,
      pendingQuestionCount: 1,
    };
    // 未达上限：按触发面命中（message 面命中场景 1，不含场景 2/5）
    const onMessage = collectSceneHits('message', makeContext(noisy));
    expect([...onMessage.keys()]).toEqual(['scene-1']);
    const onRoll = collectSceneHits('topic-roll', makeContext(noisy));
    expect([...onRoll.keys()]).toEqual(['scene-2', 'scene-5']);
    // 达上限：全体沉默（保险优先于任何场景判据）
    const muted = makeContext({ ...noisy, unansweredStreak: 2 });
    expect(collectSceneHits('message', muted).size).toBe(0);
    expect(collectSceneHits('topic-roll', muted).size).toBe(0);
    expect(collectSceneHits('question-probe', muted).size).toBe(0);
  });

  it('验收12：命中集合的顺序即全局场景顺序（可直接喂给 criteria 渲染）', () => {
    const hits = collectSceneHits(
      'topic-roll',
      makeContext({ recentHumanCount: 2, recentMessageCount: 4, matchedInterestIds: ['x'] }),
    );
    expect([...hits.keys()]).toEqual(sortSceneIds([...hits.keys()]));
  });
});
