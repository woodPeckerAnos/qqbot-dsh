/**
 * 会话级旁听状态单测（离线、纯状态机、不读墙上时钟）。
 *
 * 这是"`SceneEvidence` 每个字段都有生产者"的兑现处。用例按**字段**分组，
 * 每个计数器/窗口都有正反两面（什么时候涨、什么时候归零）。
 */

import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../src/core/connector.js';
import {
  ConversationState,
  ConversationStateStore,
  looksLikeQuestion,
} from '../src/pipeline/proactive/scene/state.js';

const T0 = 1_700_000_000_000;

function msg(
  msgId: string,
  senderId: string,
  content: string,
  ts: number,
  username?: string,
): NormalizedMessage {
  return {
    kind: 'group-message',
    target: { platform: 'onebot', kind: 'group', id: '8888', key: 'ob11:g8888' },
    eventId: `evt-${msgId}`,
    msgId,
    senderId,
    ...(username !== undefined ? { username } : {}),
    content,
    ts,
    raw: {},
  };
}

function state(options = {}) {
  return new ConversationState('ob11:g8888', { activityWindowMs: 60_000, ...options });
}

describe('疑问句识别（场景 3 的入口）', () => {
  it('验收1：问号结尾或含疑问词，且正文够长才算', () => {
    expect(looksLikeQuestion('这个接口的分页参数怎么传？')).toBe(true);
    expect(looksLikeQuestion('有没有人知道这个报错')).toBe(true);
    expect(looksLikeQuestion('谁能跑一下这个脚本')).toBe(true);
  });

  it('验收2：短追问、命令、纯媒体、陈述句都不算（宁漏不误报）', () => {
    expect(looksLikeQuestion('在？')).toBe(false);
    expect(looksLikeQuestion('?')).toBe(false);
    expect(looksLikeQuestion('啥？')).toBe(false);
    expect(looksLikeQuestion('/new 开个新会话吧')).toBe(false);
    expect(looksLikeQuestion('[图片: x.jpg]')).toBe(false);
    expect(looksLikeQuestion('好的我知道了')).toBe(false);
  });

  it('验收2b：本地识别**故意**粗——闲聊里的疑问词也会登记，靠判定层收敛', () => {
    // "今天中午吃啥好呢" 含疑问词且够长 → 本地登记进台账（多一次判定）
    // 这是刻意的取舍：本地漏掉真问题（宁漏勿误报的反面）代价更大，
    // 而闲聊噪声由 judge 的 SCENE-3 criteria 与台账 TTL 一起收敛。
    expect(looksLikeQuestion('今天中午吃啥好呢')).toBe(true);
    const s = state();
    s.observe(msg('m1', 'u1', '今天中午吃啥好呢', T0));
    expect(s.pendingQuestions(T0 + 1_000)).toHaveLength(1);
  });
});

describe('活动窗口与 bot 参与窗口', () => {
  it('验收3：窗口内多人多轮 → 人头/条数有生产者；窗口过期 → 归零', () => {
    const s = state();
    s.observe(msg('m1', 'u1', 'A', T0));
    s.observe(msg('m2', 'u2', 'B', T0 + 5_000));
    s.observe(msg('m3', 'u1', 'C', T0 + 9_000));
    expect(s.humanParticipants(T0 + 10_000)).toBe(2);
    expect(s.messageCount(T0 + 10_000)).toBe(3);
    expect(s.topicId(T0 + 10_000)).toBe(`topic:${T0}`);

    // 超过活动窗口没有新消息 → 话题翻篇
    const later = T0 + 10_000 + 61_000;
    expect(s.humanParticipants(later)).toBe(0);
    expect(s.messageCount(later)).toBe(0);
    expect(s.botSpeaks(later)).toBe(0);
  });

  it('验收4：bot 发言后窗口打开（场景 1 的预筛条件），窗口过期即关闭', () => {
    const s = state();
    s.observe(msg('m1', 'u1', '帮我看看这个报错', T0));
    expect(s.inBotTopicWindow(T0 + 1_000)).toBe(false);
    s.recordBotSpoke(T0 + 1_000);
    expect(s.inBotTopicWindow(T0 + 2_000)).toBe(true);
    expect(s.botSpeaks(T0 + 2_000)).toBe(1);
    // 群里继续说话 → 窗口延续
    s.observe(msg('m2', 'u2', '我也遇到了', T0 + 30_000));
    expect(s.inBotTopicWindow(T0 + 40_000)).toBe(true);
    // 长时间无人说话 → 窗口关闭，bot 发言计数归零
    const later = T0 + 30_000 + 61_000;
    expect(s.inBotTopicWindow(later)).toBe(false);
    expect(s.botSpeaks(later)).toBe(0);
  });

  it('验收5：时钟只前进不回退——延迟到达的旧消息不会把窗口拉回去', () => {
    const s = state();
    s.observe(msg('m1', 'u1', 'A', T0));
    s.observe(msg('m2', 'u2', 'B', T0 + 5_000));
    // 一条 3 分钟前的旧消息（补投/重放）：它算参与人，但**不该**把窗口起点拉回去
    s.observe(msg('m0', 'u3', 'C', T0 - 180_000));
    expect(s.topicId(T0 + 6_000)).toBe(`topic:${T0}`);
    expect(s.humanParticipants(T0 + 6_000)).toBe(3);
    // 锚点是**最近一次人类发言**（T0+5s），所以静默 60s 之后才翻篇；
    // 关键断言是"没有因为那条旧消息把锚点拉回 T0-180s"（否则这里早已过期）
    expect(s.humanParticipants(T0 + 66_000)).toBe(0);
    expect(s.topicId(T0 + 66_000)).toBeUndefined();
  });
});

describe('无人回应计数（保险）', () => {
  it('验收6：bot 每次发言 +1，任何人类消息归零', () => {
    const s = state();
    s.observe(msg('m1', 'u1', '你好', T0));
    expect(s.unansweredStreak).toBe(0);
    s.recordBotSpoke(T0 + 1_000);
    expect(s.unansweredStreak).toBe(1);
    s.recordBotSpoke(T0 + 2_000);
    expect(s.unansweredStreak).toBe(2);
    s.observe(msg('m2', 'u2', '谢谢', T0 + 3_000));
    expect(s.unansweredStreak).toBe(0);
  });

  it('验收7：被 @ 的消息（同样入缓冲）也算"有人理"', () => {
    const s = state();
    s.recordBotSpoke(T0);
    expect(s.unansweredStreak).toBe(1);
    s.observeEntry({
      msgId: 'm9',
      eventId: 'evt-m9',
      senderId: 'u1',
      text: '@bot 帮我算一下',
      ts: T0 + 1_000,
      addressed: true,
    });
    expect(s.unansweredStreak).toBe(0);
    expect(s.entries).toHaveLength(1);
  });
});

describe('未答问题台账（场景 3）', () => {
  it('验收8：疑问句登记为挂起；同一条消息不重复登记', () => {
    const s = state();
    s.observe(msg('m1', 'u1', '有没有人知道这个接口怎么调？', T0));
    s.observe(msg('m1', 'u1', '有没有人知道这个接口怎么调？', T0)); // 同 msgId 重复投递
    expect(s.pendingQuestions(T0 + 1_000)).toHaveLength(1);
  });

  it('验收9：话题翻篇（新窗口）时上一窗口的问题不再算挂起', () => {
    const s = state();
    s.observe(msg('m1', 'u1', '谁能跑一下这个脚本？', T0));
    expect(s.pendingQuestions(T0 + 1_000)).toHaveLength(1);
    // 空窗一段时间后有人开新话题 → 旧问题作废（否则场景 3 会凭空触发）
    s.observe(msg('m2', 'u2', '另一个话题开始', T0 + 120_000));
    expect(s.pendingQuestions(T0 + 121_000)).toHaveLength(0);
  });

  it('验收10：TTL 到期自动作废；markAnswered / markSilenced 各自关闭', () => {
    const s = state({ questionTtlMs: 30_000 });
    s.observe(msg('m1', 'u1', '这个问题有人知道吗？', T0));
    const [q1] = s.pendingQuestions(T0 + 1_000);
    expect(q1).toBeDefined();
    // TTL 内仍挂起
    expect(s.pendingQuestions(T0 + 20_000)).toHaveLength(1);
    // 超过 TTL 作废
    expect(s.pendingQuestions(T0 + 40_000)).toHaveLength(0);

    const s2 = state();
    s2.observe(msg('m1', 'u1', '这个问题有人知道吗？', T0));
    const [q2] = s2.pendingQuestions(T0 + 1_000);
    s2.markAnswered(q2?.id ?? '');
    expect(s2.pendingQuestions(T0 + 2_000)).toHaveLength(0);

    const s3 = state();
    s3.observe(msg('m1', 'u1', '这个问题有人知道吗？', T0));
    const [q3] = s3.pendingQuestions(T0 + 1_000);
    s3.markSilenced(q3?.id ?? '');
    expect(s3.pendingQuestions(T0 + 2_000)).toHaveLength(0);
  });

  it('验收11：探针计数可累加、可查询（上限由 watcher 与 veto 决定）', () => {
    const s = state();
    s.observe(msg('m1', 'u1', '这个问题有人知道吗？', T0));
    const [q] = s.pendingQuestions(T0 + 1_000);
    expect(s.questionProbes(q?.id ?? '')).toBe(0);
    s.recordProbe(q?.id ?? '');
    s.recordProbe(q?.id ?? '');
    expect(s.questionProbes(q?.id ?? '')).toBe(2);
  });

  it('验收12：台账有上限（长群里不会无限增长）', () => {
    const s = state({ maxQuestions: 3 });
    for (let index = 0; index < 8; index += 1) {
      s.observe(msg(`m${index}`, `u${index}`, `第 ${index} 个问题有人知道吗？`, T0 + index * 10));
    }
    expect(s.pendingQuestions(T0 + 200).length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// wait 收敛要用的两个字段（见 docs/WAIT-CONVERGENCE-REQUIREMENT.md 判定三/五）
// ---------------------------------------------------------------------------

describe('让路台账：预算、判定时刻与"问题关闭"通知', () => {
  it('验收15：yieldBudget 记在**问题那一行**上，可累加可查询', () => {
    const s = state();
    s.observe(msg('m1', 'u1', '这个问题有人知道吗？', T0));
    const [q] = s.pendingQuestions(T0 + 1_000);
    expect(q?.yieldBudgetUsed).toBe(0);
    expect(s.yieldBudget(q?.id ?? '')).toBe(0);

    s.recordYield(q?.id ?? '');
    s.recordYield(q?.id ?? '');
    expect(s.yieldBudget(q?.id ?? '')).toBe(2);
    // 记在问题上（不是会话上）：另一个问题不受影响
    s.observe(msg('m2', 'u2', '那这个呢，有人知道吗？', T0 + 2_000));
    const other = s.pendingQuestions(T0 + 3_000).find((item) => item.msgId === 'm2');
    expect(s.yieldBudget(other?.id ?? '')).toBe(0);
  });

  it('验收16：lastEvaluatedAt 只前进不回退，且"有没有新增内容"以它为基准', () => {
    const s = state();
    s.observe(msg('m1', 'u1', '这个问题有人知道吗？', T0));
    const [q] = s.pendingQuestions(T0 + 1_000);
    const id = q?.id ?? '';

    // 还没判定过 → 一律按"有新增"处理（宁可多查一次，不可漏掉一段对话）
    expect(s.hasNewContentSince(undefined)).toBe(true);

    s.markEvaluated(id, T0 + 5_000);
    expect(q?.lastEvaluatedAt).toBe(T0 + 5_000);
    // 乱序/并发调用不该把标记拉回去
    s.markEvaluated(id, T0 + 1_000);
    expect(q?.lastEvaluatedAt).toBe(T0 + 5_000);

    // 转录里没有**晚于**判定时刻的消息 → 无新增（唤醒时因此不花 LLM）。
    // 边界是严格大于：判定那一刻已经在转录里的那条消息不算"新增"，
    // 否则每次唤醒都会被自己上一轮的触发消息喂饱（等于没有这道检查）。
    expect(s.hasNewContentSince(T0 + 5_000)).toBe(false);
    expect(s.hasNewContentSince(T0)).toBe(false);
    expect(s.hasNewContentSince(T0 - 1)).toBe(true);

    s.observe(msg('m2', 'u2', '我看看', T0 + 6_000));
    expect(s.hasNewContentSince(T0 + 5_000)).toBe(true);
  });

  it('验收17：问题关闭会**通知**监听者（调度层据此立即作废票据、取消唤醒）', () => {
    const s = state({ questionTtlMs: 30_000, activityWindowMs: 60_000 });
    const closed: Array<{ id: string; cause: string }> = [];
    s.onQuestionClosed((event) => closed.push({ id: event.id, cause: event.cause }));

    s.observe(msg('m1', 'u1', '第一个问题有人知道吗？', T0));
    const [q1] = s.pendingQuestions(T0 + 1_000);
    s.markAnswered(q1?.id ?? '');
    expect(closed).toEqual([{ id: q1?.id ?? '', cause: 'answered' }]);

    // 幂等：重复关闭同一条问题不重复通知（否则同一张票据会被作废两次）
    s.markAnswered(q1?.id ?? '');
    expect(closed).toHaveLength(1);

    // TTL 到期同样要通知
    s.observe(msg('m2', 'u2', '第二个问题有人知道吗？', T0 + 2_000));
    const before = closed.length;
    s.pendingQuestions(T0 + 40_000);
    expect(closed.length).toBe(before + 1);
    expect(closed.at(-1)?.cause).toBe('expired');

    // 话题翻篇（新窗口）也是"关闭"：挂在旧问题上的票据必须当场作废
    const s2 = state({ activityWindowMs: 60_000 });
    const closed2: string[] = [];
    s2.onQuestionClosed((event) => closed2.push(event.cause));
    s2.observe(msg('m1', 'u1', '窗口里第一个问题有人知道吗？', T0));
    expect(s2.pendingQuestions(T0 + 1_000)).toHaveLength(1);
    s2.observe(msg('m2', 'u2', '静默很久之后换话题', T0 + 120_000));
    expect(closed2).toContain('window-reset');
    expect(s2.pendingQuestions(T0 + 121_000)).toHaveLength(0);
  });

  it('验收18：Store 把任意会话的问题关闭事件带 convKey 转发出来', () => {
    const store = new ConversationStateStore({ activityWindowMs: 60_000 });
    const seen: Array<{ convKey: string; id: string }> = [];
    store.onQuestionClosed((convKey, event) => seen.push({ convKey, id: event.id }));

    const a = store.for('ob11:g1');
    a.observe(msg('m1', 'u1', '这个有人知道吗？', T0));
    const [q] = a.pendingQuestions(T0 + 1_000);
    a.markAnswered(q?.id ?? '');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.convKey).toBe('ob11:g1');
    expect(seen[0]?.id).toBe(q?.id);
  });
});

describe('缓冲边界与注册表', () => {
  it('验收13：缓冲按条数上限淘汰最旧的（判定只要近期上下文）', () => {
    const s = state({ maxEntries: 5 });
    for (let index = 0; index < 20; index += 1) {
      s.observe(msg(`m${index}`, 'u1', `第 ${index} 条`, T0 + index));
    }
    expect(s.entries).toHaveLength(5);
    expect(s.entries[0]?.msgId).toBe('m15');
  });

  it('验收14：Store 按会话键隔离（一个群的旁听不会串到另一个群）', () => {
    const store = new ConversationStateStore({ activityWindowMs: 60_000 });
    store.for('ob11:g1').observe(msg('m1', 'u1', 'A', T0));
    store.for('ob11:g2').observe(msg('m2', 'u2', 'B', T0));
    expect(store.size).toBe(2);
    expect(store.for('ob11:g1').entries).toHaveLength(1);
    expect(store.for('ob11:g1')).toBe(store.for('ob11:g1')); // 同键同实例
    expect(store.for('ob11:g1').convKey).toBe('ob11:g1');
  });
});

// ---------------------------------------------------------------------------
// 话题 session（主动发言的唯一放行闸门，见 docs/TOPIC-SESSION-REQUIREMENT.md）
// ---------------------------------------------------------------------------

describe('话题 session 的状态机', () => {
  it('验收19：开 → 扣预算 → 关：三字段就是全部状态，且关闭只通知一次', () => {
    const s = state();
    const closed: Array<{ cause: string; budgetLeft: number }> = [];
    s.onSessionClosed((event) => {
      closed.push({ cause: event.cause, budgetLeft: event.session.budgetLeft });
    });

    // 没开之前一切为"没有"
    expect(s.session).toBeUndefined();
    expect(s.consumeSessionBudget(T0)).toBe(false); // 没有 session 时扣不动
    expect(s.closeSession('idle')).toBe(false);

    expect(s.openSession(T0, 2)).toBe(true);
    expect(s.session).toEqual({ openedAt: T0, budgetLeft: 2 });
    // 已有 session 时**拒绝覆盖**（正常路径不会发生；静默覆盖会把上一本的账吞掉）
    expect(s.openSession(T0 + 1, 5)).toBe(false);
    expect(s.session?.openedAt).toBe(T0);

    expect(s.consumeSessionBudget(T0 + 1_000)).toBe(true);
    expect(s.session).toEqual({ openedAt: T0, budgetLeft: 1, lastSpokeAt: T0 + 1_000 });
    expect(s.consumeSessionBudget(T0 + 2_000)).toBe(true);
    expect(s.session?.budgetLeft).toBe(0); // 减到 0 不在这里关闭（关闭要通知监听者）
    expect(s.consumeSessionBudget(T0 + 3_000)).toBe(true);
    expect(s.session?.budgetLeft ?? -1).toBe(0); // 也不会变成负数

    // 关闭原因由调用方给（预算**不在**其中：耗尽只闭嘴、不关会话）
    expect(s.closeSession('llm-closed')).toBe(true);
    expect(s.session).toBeUndefined();
    // 幂等：重复关闭不重复通知（账目等式 `closed === Σ closedBy` 靠这一条）
    expect(s.closeSession('llm-closed')).toBe(false);
    expect(closed).toEqual([{ cause: 'llm-closed', budgetLeft: 0 }]);
  });

  it('验收20：Store 把任意会话的 session 关闭事件带 convKey 转发出来；dispose 连带关闭', () => {
    const store = new ConversationStateStore();
    const seen: Array<{ convKey: string; cause: string }> = [];
    store.onSessionClosed((convKey, event) => seen.push({ convKey, cause: event.cause }));

    const a = store.for('ob11:g1');
    a.openSession(T0, 2);
    a.closeSession('llm-closed');
    expect(seen).toEqual([{ convKey: 'ob11:g1', cause: 'llm-closed' }]);

    // 会话状态被清理 → session 连带关闭（原因 conversation-gone），并摘掉监听器
    const b = store.for('ob11:g2');
    b.openSession(T0, 2);
    expect(store.dispose('ob11:g2')).toBe(true);
    expect(seen.at(-1)).toEqual({ convKey: 'ob11:g2', cause: 'conversation-gone' });
    expect(store.size).toBe(1);
    expect(store.dispose('ob11:g2')).toBe(false);
  });

  it('验收21：会话级判定时刻只前进不回退；"有没有新增"看时间戳也看转录末尾', () => {
    const s = state();
    expect(s.lastEvaluatedAt).toBeUndefined();
    // 还没判定过 → 一律按"有新增"处理（宁可多查一次）
    expect(s.hasNewContentSinceLastEvaluation()).toBe(true);

    s.observe(msg('m1', 'u1', '第一句', T0));
    s.markEvaluatedAt(T0 + 1_000);
    expect(s.lastEvaluatedAt).toBe(T0 + 1_000);
    s.markEvaluatedAt(T0 + 500); // 乱序/并发调用不该把标记拉回去
    expect(s.lastEvaluatedAt).toBe(T0 + 1_000);
    expect(s.hasNewContentSinceLastEvaluation()).toBe(false);

    // 平台事件时间可能是**秒**：同一毫秒内到达的新消息时间戳并不更大，
    // 但转录末尾换了人 → 仍然算"有新增"（否则消息面会被整体吞掉）
    s.observe(msg('m2', 'u2', '第二句', T0 + 1_000));
    expect(s.hasNewContentSinceLastEvaluation()).toBe(true);

    // 时间戳判据本身保持严格大于（wait 票据用它，语义不能变）
    expect(s.hasNewContentSince(T0 + 1_000)).toBe(false);
    expect(s.hasNewContentSince(T0)).toBe(true);
  });
});
