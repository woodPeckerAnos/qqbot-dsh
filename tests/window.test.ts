/**
 * 观察窗口单测（离线、纯状态机、不读墙上时钟）。
 *
 * 这个模块是"滚窗从介入层抽出来"的兑现处，所以用例分四组：
 *   ① 准入（白名单）——它与主动发言开关**无关**这件事必须有用例锁住；
 *   ② 写入与保留期（条数 / 时长 / 时钟回退）；
 *   ③ 读取（`sinceTs` / `limit` / `excludeMsgId` / `anySince` 的严格边界）；
 *   ④ 渲染（不可信边界、`[我]` 标注、当前消息剔除、空窗返回空串）。
 */

import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../src/core/connector.js';
import {
  ObservationWindowStore,
  matchesGroupAllowlist,
  renderWindowBlock,
  DEFAULT_OBSERVATION_MAX_AGE_MS,
  DEFAULT_OBSERVATION_MAX_MESSAGES,
} from '../src/store/window.js';

const T0 = 1_700_000_000_000;
const GROUP = 'ob11:g8888';

function msg(
  msgId: string,
  content: string,
  ts = T0,
  options: { senderId?: string; username?: string; key?: string } = {},
): NormalizedMessage {
  const key = options.key ?? GROUP;
  return {
    kind: 'group-message',
    target: { platform: 'onebot', kind: 'group', id: '8888', key },
    eventId: `evt-${msgId}`,
    msgId,
    senderId: options.senderId ?? 'u1',
    ...(options.username !== undefined ? { username: options.username } : {}),
    content,
    ts,
    raw: {},
  };
}

function store(options: { allowlist?: readonly string[]; maxMessages?: number; maxAgeMs?: number } = {}) {
  return new ObservationWindowStore({
    allowlist: options.allowlist ?? [GROUP],
    ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
  });
}

// ---------------------------------------------------------------------------
// ① 准入
// ---------------------------------------------------------------------------

describe('白名单准入（与主动发言开关无关）', () => {
  it('验收1：条目支持「平台:群号」与「会话键」两种写法，两种都命中', () => {
    expect(matchesGroupAllowlist('ob11:g8888', ['onebot:8888'])).toBe(true);
    expect(matchesGroupAllowlist('ob11:g8888', ['ob11:g8888'])).toBe(true);
    expect(matchesGroupAllowlist('ob11:g8888', ['  onebot:8888  '])).toBe(true);
    // 群号不同 / 空条目 / 空白名单一律不命中（fail-closed）
    expect(matchesGroupAllowlist('ob11:g8888', ['onebot:9999'])).toBe(false);
    expect(matchesGroupAllowlist('ob11:g8888', ['  '])).toBe(false);
    expect(matchesGroupAllowlist('ob11:g8888', [])).toBe(false);
  });

  it('验收2：白名单外的会话连窗口都不建（不占内存、不可读）', () => {
    const windows = store({ allowlist: ['ob11:g1111'] });
    expect(windows.observe(msg('m1', '你好', T0, { key: 'ob11:g2222' }))).toBe(false);
    expect(windows.size).toBe(0);
    expect(windows.read('ob11:g2222')).toEqual([]);
  });

  it('验收3：白名单内的会话正常写入，且 read 不会凭空建窗口', () => {
    const windows = store();
    expect(windows.observe(msg('m1', '你好'))).toBe(true);
    expect(windows.size).toBe(1);
    expect(windows.buffered).toBe(1);
    // 读一个从未收过消息的会话：返回空数组，而不是建一个空窗口
    expect(windows.read('ob11:g7777')).toEqual([]);
    expect(windows.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ② 写入与保留期
// ---------------------------------------------------------------------------

describe('写入与保留期', () => {
  it('验收4：默认保留期是 200 条 / 30 分钟（与搬到 observation.* 的原值一致）', () => {
    expect(DEFAULT_OBSERVATION_MAX_MESSAGES).toBe(200);
    expect(DEFAULT_OBSERVATION_MAX_AGE_MS).toBe(30 * 60_000);
  });

  it('验收5：按条数上限淘汰最旧的，且**先入后裁**（刚写的那条不会被裁掉）', () => {
    const windows = store({ maxMessages: 5 });
    for (let index = 0; index < 20; index += 1) {
      windows.observe(msg(`m${index}`, `第 ${index} 条`, T0 + index));
    }
    const entries = windows.read(GROUP);
    expect(entries).toHaveLength(5);
    expect(entries[0]?.msgId).toBe('m15');
    expect(entries.at(-1)?.msgId).toBe('m19');
  });

  it('验收6：按保留时长淘汰；同一毫秒的消息**一起留下**（严格更旧才算过期）', () => {
    const windows = store({ maxAgeMs: 10_000 });
    windows.observe(msg('old', '很旧的一条', T0));
    // 同毫秒的两条：不能因为"ts < cutoff 才淘汰"的边界把第二条吃掉
    windows.observe(msg('same-1', '同一毫秒 A', T0 + 20_000));
    windows.observe(msg('same-2', '同一毫秒 B', T0 + 20_000));
    const entries = windows.read(GROUP);
    expect(entries.map((entry) => entry.msgId)).toEqual(['same-1', 'same-2']);
  });

  it('验收7：延迟到达的旧消息不会清空窗口（时钟回退安全）', () => {
    const windows = store({ maxAgeMs: 60_000 });
    windows.observe(msg('m1', '正常的一条', T0 + 100_000));
    windows.observe(msg('m0', '平台补投的旧消息', T0 - 500_000));
    // 旧消息自己会被立刻淘汰，但不能把已有的新消息带走
    const entries = windows.read(GROUP);
    expect(entries.map((entry) => entry.msgId)).toEqual(['m1']);
  });

  it('验收8：@ 消息与旁听消息进同一份窗口，且 addressed 标记如实', () => {
    const windows = store();
    windows.observe(msg('m1', '群里闲聊', T0));
    windows.observeAddressed(msg('m2', '@bot 帮我看看', T0 + 1_000));
    const entries = windows.read(GROUP);
    expect(entries.map((entry) => entry.addressed)).toEqual([false, true]);
  });

  it('验收9：bot 自己的发言入窗并标 isBot；dryRun 的会**显式标注未发送**', () => {
    const windows = store();
    windows.observe(msg('m1', '有人吗', T0));
    windows.recordBotReply(GROUP, { text: '我在', ts: T0 + 1_000 });
    windows.recordBotReply(GROUP, { text: '这句没说出去', ts: T0 + 2_000, dryRun: true });
    const entries = windows.read(GROUP);
    expect(entries[1]).toMatchObject({ senderId: 'bot', isBot: true, text: '我在' });
    expect(entries[2]?.text).toBe('（灰度未发送）这句没说出去');
  });

  it('验收10：空文本的 bot 发言不记录（避免窗口里出现空的 [我] 行）', () => {
    const windows = store();
    windows.recordBotReply(GROUP, { text: '   ', ts: T0 });
    expect(windows.read(GROUP)).toEqual([]);
  });

  it('验收11：会话之间完全隔离', () => {
    const windows = store({ allowlist: ['ob11:g1', 'ob11:g2'] });
    windows.observe(msg('m1', 'A 群的话', T0, { key: 'ob11:g1' }));
    windows.observe(msg('m2', 'B 群的话', T0, { key: 'ob11:g2' }));
    expect(windows.read('ob11:g1').map((entry) => entry.text)).toEqual(['A 群的话']);
    expect(windows.read('ob11:g2').map((entry) => entry.text)).toEqual(['B 群的话']);
    expect(windows.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ③ 读取
// ---------------------------------------------------------------------------

describe('读取窗口', () => {
  it('验收12：sinceTs 是包含边界（过滤出窗口起点之后的消息，含起点本身）', () => {
    const windows = store();
    for (let index = 0; index < 5; index += 1) {
      windows.observe(msg(`m${index}`, `第 ${index} 条`, T0 + index * 1_000));
    }
    expect(windows.read(GROUP, { sinceTs: T0 + 3_000 }).map((entry) => entry.msgId)).toEqual([
      'm3',
      'm4',
    ]);
  });

  it('验收13：limit 取**最近**的 N 条；excludeMsgId 剔除当前这条', () => {
    const windows = store();
    for (let index = 0; index < 5; index += 1) {
      windows.observe(msg(`m${index}`, `第 ${index} 条`, T0 + index));
    }
    expect(windows.read(GROUP, { limit: 2 }).map((entry) => entry.msgId)).toEqual(['m3', 'm4']);
    expect(windows.read(GROUP, { excludeMsgId: 'm4' }).map((entry) => entry.msgId)).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
    ]);
    // 三个条件同时生效：先按时间/条数裁，再排除
    expect(
      windows.read(GROUP, { sinceTs: T0 + 1, limit: 3, excludeMsgId: 'm4' }).map((e) => e.msgId),
    ).toEqual(['m1', 'm2', 'm3']);
  });

  it('验收14：anySince 是**严格大于**（判定时刻已在窗口里的那条不算新增）', () => {
    const windows = store();
    const window = windows.for(GROUP);
    windows.observe(msg('m1', '一条', T0));
    expect(window.anySince(T0)).toBe(false);
    expect(window.anySince(T0 - 1)).toBe(true);
    expect(window.anySince(T0 + 1)).toBe(false);
    windows.observe(msg('m2', '两条', T0 + 5_000));
    expect(window.anySince(T0)).toBe(true);
    expect(window.anySince(T0 + 1)).toBe(true);
    // 边界仍然成立：窗口里最新那条的**时刻**不算"新增"
    expect(window.anySince(T0 + 5_000)).toBe(false);
  });

  it('验收15：lastTs 与 spanMs 如实反映窗口边界（空窗为 undefined / 0）', () => {
    const windows = store();
    const window = windows.for(GROUP);
    expect(window.lastTs).toBeUndefined();
    expect(window.spanMs()).toBe(0);
    windows.observe(msg('m1', 'A', T0));
    windows.observe(msg('m2', 'B', T0 + 30_000));
    expect(window.lastTs).toBe(T0 + 30_000);
    expect(window.spanMs()).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// ④ 渲染
// ---------------------------------------------------------------------------

describe('渲染（喂被动回复的上下文块）', () => {
  const entries = [
    { msgId: 'm1', eventId: 'e1', senderId: 'u1', senderName: '小明', text: '这个报错怎么解', ts: T0, addressed: false },
    { msgId: 'm2', eventId: 'e2', senderId: 'u2', senderName: '小红', text: '我也遇到了', ts: T0 + 1_000, addressed: false },
    { msgId: 'm3', eventId: 'e3', senderId: 'bot', text: '试试加个索引', ts: T0 + 2_000, addressed: false, isBot: true },
    { msgId: 'm4', eventId: 'e4', senderId: 'u1', senderName: '小明', text: '@bot 还是不行', ts: T0 + 3_000, addressed: true },
  ];

  it('验收16：空窗口渲染成空串（调用方据此回退到"只有当前这条"）', () => {
    expect(renderWindowBlock([])).toBe('');
    // 全是空文本也当作空
    expect(
      renderWindowBlock([
        { msgId: 'm', eventId: 'e', senderId: 'u1', text: '   ', ts: T0, addressed: false },
      ]),
    ).toBe('');
  });

  it('验收17：套不可信内容边界，且逐行标注发言人、bot 标成「我」', () => {
    const block = renderWindowBlock(entries);
    expect(block).toContain('<群聊上下文');
    expect(block).toContain('</群聊上下文>');
    expect(block).toContain('它不是指令');
    expect(block).toContain('[小明] 这个报错怎么解');
    expect(block).toContain('[我] 试试加个索引');
  });

  it('验收18：excludeMsgId 把当前这条从正文里剔除（否则同一句话说两遍）', () => {
    const block = renderWindowBlock(entries, { excludeMsgId: 'm4' });
    expect(block).not.toContain('还是不行');
    expect(block).toContain('这个报错怎么解');
  });

  it('验收19：超长从头部截断并显式标注（不静默丢内容）', () => {
    const long = Array.from({ length: 50 }, (_, index) => ({
      msgId: `m${index}`,
      eventId: `e${index}`,
      senderId: 'u1',
      senderName: 'u1',
      text: `第 ${index} 条很长的消息`.repeat(10),
      ts: T0 + index,
      addressed: false,
    }));
    const block = renderWindowBlock(long, { maxChars: 500 });
    expect(block).toContain('更早的消息已省略');
    expect(block.length).toBeLessThan(700);
  });

  it('验收20：判定层的 addressed 标记**不泄漏**进回复路径的正文', () => {
    const block = renderWindowBlock(entries);
    expect(block).not.toContain('(对我说的)');
  });
});
