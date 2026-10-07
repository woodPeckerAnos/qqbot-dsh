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
