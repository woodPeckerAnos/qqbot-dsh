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

import type { MessagePart, NormalizedMessage } from '../src/core/connector.js';
import {
  ObservationWindowStore,
  collectWindowMedia,
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
  options: { senderId?: string; username?: string; key?: string; parts?: MessagePart[] } = {},
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
    // parts 缺省不给：适配器只归一化出文本的形态（编排层按 content 处理）
    ...(options.parts !== undefined ? { parts: options.parts } : {}),
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

// ---------------------------------------------------------------------------
// ⑤ 媒体（滚窗里的图 / 文件 → 被 @ 时随本轮送入）
// ---------------------------------------------------------------------------

/**
 * 这一组用例锁的是一个真机 bug：群里**先发图、再 @ bot 问"这是什么"**时，模型只
 * 拿到 `[图片: DF77A739.jpg]` 这种占位（原话："这张图没到我这儿——工作区里也没有
 * 对应的文件"）。根因是滚窗条目只留了扁平化文本，媒体引用根本没留下来——与图片
 * 尺寸、下载上限都无关：**从来没有人为旁听消息取过字节**。
 */
describe('条目里的媒体引用（旁听消息也留引用，写入时不取字节）', () => {
  const img = (name: string, url = `https://cdn.example.com/${name}`) =>
    ({ type: 'image', url, filename: name }) as const;

  it('验收21：旁听消息的图片被留成引用，无媒体的消息不写 media 字段', () => {
    const windows = store();
    windows.observe(
      msg('m1', '看这个\n[图片: a.png]', T0, {
        parts: [{ type: 'text', text: '看这个' }, img('a.png')],
      }),
    );
    windows.observe(msg('m2', '纯文本', T0 + 1));

    const [first, second] = windows.read(GROUP);
    expect(first!.media?.images).toHaveLength(1);
    expect(first!.media?.images[0]).toMatchObject({
      url: 'https://cdn.example.com/a.png',
      filename: 'a.png',
    });
    // 没有媒体的条目形状不变：不写 `media`，而不是写一个空对象
    expect(second!.media).toBeUndefined();
  });

  it('验收22：被 @ 的消息（走判定层那条写入路径）同样带引用——转换点只有一处', () => {
    const windows = store();
    windows.observeAddressed(
      msg('m1', '看看\n[图片: q.png]', T0, {
        parts: [{ type: 'text', text: '看看' }, img('q.png')],
      }),
    );
    expect(windows.read(GROUP)[0]!.media?.images[0]).toMatchObject({ filename: 'q.png' });
  });

  it('验收23：引用消息里的图与文件都在（与当前消息同一套收集规则）', () => {
    const windows = store();
    windows.observe(
      msg('m1', '[引用 小红] 看这个 [图片: in-quote.png]', T0, {
        parts: [
          {
            type: 'quote',
            author: '小红',
            parts: [
              img('in-quote.png'),
              {
                type: 'media',
                mediaKind: 'file',
                url: 'https://cdn.example.com/r.pdf',
                filename: 'r.pdf',
              },
            ],
          },
        ],
      }),
    );
    const entry = windows.read(GROUP)[0]!;
    expect(entry.media?.images.map((part) => part.filename)).toEqual(['in-quote.png']);
    expect(entry.media?.files.map((part) => part.filename)).toEqual(['r.pdf']);
  });

  it('验收24：视频等非文件媒体不进窗口清单（与当前消息同一处理面，不制造"清单里有却没读"）', () => {
    const windows = store();
    windows.observe(
      msg('m1', '[视频]', T0, {
        parts: [{ type: 'media', mediaKind: 'video', url: 'https://cdn.example.com/v.mp4' }],
      }),
    );
    expect(windows.read(GROUP)[0]!.media).toBeUndefined();
  });
});

describe('collectWindowMedia（挑哪几张送给模型）', () => {
  const imageEntry = (msgId: string, names: string[], ts: number, senderName = '小明') => ({
    msgId,
    eventId: `e-${msgId}`,
    senderId: 'u1',
    senderName,
    text: names.map((name) => `[图片: ${name}]`).join('\n'),
    ts,
    addressed: false,
    media: {
      images: names.map((name) => ({
        type: 'image' as const,
        url: `https://cdn/${name}`,
        filename: name,
      })),
      files: [],
    },
  });
  const fileEntry = (msgId: string, name: string, ts: number, senderName = '小红') => ({
    msgId,
    eventId: `e-${msgId}`,
    senderId: 'u2',
    senderName,
    text: `[文件: ${name}]`,
    ts,
    addressed: false,
    media: {
      images: [],
      files: [
        {
          type: 'media' as const,
          mediaKind: 'file' as const,
          url: `https://cdn/${name}`,
          filename: name,
        },
      ],
    },
  });

  it('验收25：默认什么都不选（配额缺省 0），给了配额才选', () => {
    const entries = [imageEntry('m1', ['a.png'], T0), fileEntry('m2', 'r.pdf', T0 + 1)];
    expect(collectWindowMedia(entries)).toMatchObject({ images: [], files: [] });
    const selected = collectWindowMedia(entries, { maxImages: 1, maxFiles: 1 });
    expect(selected.images).toHaveLength(1);
    expect(selected.files).toHaveLength(1);
  });

  it('验收26：从最近往前挑（"看看这个"指的就是刚发的那张），但输出保持时间顺序', () => {
    const entries = [
      imageEntry('m1', ['old.png'], T0),
      imageEntry('m2', ['mid.png'], T0 + 1_000),
      imageEntry('m3', ['new.png'], T0 + 2_000),
    ];
    const selected = collectWindowMedia(entries, { maxImages: 2 });
    // 选中的是最新的两张，顺序仍是 mid → new（与上下文块的行序一致）
    expect(selected.images.map((ref) => ref.part.filename)).toEqual(['mid.png', 'new.png']);
    expect(selected.imagesSkipped).toBe(1);
  });

  it('验收27：同一条消息里的多张图保持原有顺序，不被倒序挑乱', () => {
    const entries = [imageEntry('m1', ['a.png', 'b.png', 'c.png'], T0)];
    const selected = collectWindowMedia(entries, { maxImages: 3 });
    expect(selected.images.map((ref) => ref.part.filename)).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('验收28：引用里已经要送的那张不再从窗口送第二遍（按 url 排重）', () => {
    const entries = [imageEntry('m1', ['dup.png', 'other.png'], T0)];
    const selected = collectWindowMedia(entries, {
      maxImages: 2,
      exclude: { urls: new Set(['https://cdn/dup.png']), fileIds: new Set() },
    });
    expect(selected.images.map((ref) => ref.part.filename)).toEqual(['other.png']);
    // 被排除的**不占配额**：它压根不该出现在这一轮的候选里
    expect(selected.imagesSkipped).toBe(0);
  });

  it('验收29：同一个人重发同一张图只取最近那次，且只算一次"没选中"', () => {
    const entries = [
      imageEntry('m1', ['same.png'], T0),
      imageEntry('m2', ['same.png'], T0 + 1_000),
      imageEntry('m3', ['newer.png'], T0 + 2_000),
    ];
    const selected = collectWindowMedia(entries, { maxImages: 1 });
    expect(selected.images.map((ref) => ref.part.filename)).toEqual(['newer.png']);
    // same.png 的两次出现只算一条"超出配额"，不是两条
    expect(selected.imagesSkipped).toBe(1);
  });

  it('验收30：取不到字节的（既无 url 也无 fileId）不占配额，也不算"没选中"', () => {
    const entries = [
      {
        ...imageEntry('m1', ['no-url.png'], T0),
        media: { images: [{ type: 'image' as const, filename: 'no-url.png' }], files: [] },
      },
      imageEntry('m2', ['real.png'], T0 + 1),
    ];
    const selected = collectWindowMedia(entries, { maxImages: 1 });
    expect(selected.images.map((ref) => ref.part.filename)).toEqual(['real.png']);
    expect(selected.imagesSkipped).toBe(0);
  });

  it('验收31：返回的占位文本与上下文块里的那一行逐字一致（模型才能对号入座）', () => {
    const entries = [
      imageEntry('m1', ['shot.jpg'], T0, '小明'),
      fileEntry('m2', 'report.pdf', T0 + 1, '小红'),
    ];
    const selected = collectWindowMedia(entries, { maxImages: 1, maxFiles: 1 });
    const block = renderWindowBlock(entries);
    expect(selected.images[0]).toMatchObject({ sender: '小明', msgId: 'm1' });
    expect(block).toContain(selected.images[0]!.placeholder);
    expect(block).toContain(selected.files[0]!.placeholder);
    // 没有显示名时退到 senderId，说明文本仍然指认得清
    const anonymous = collectWindowMedia(
      [{ ...imageEntry('m3', ['x.png'], T0), senderName: undefined }],
      { maxImages: 1 },
    );
    expect(anonymous.images[0]!.sender).toBe('u1');
  });
});
