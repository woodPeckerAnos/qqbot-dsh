/**
 * 转发消息块（合并转发 / 聊天记录）单测。
 *
 * 分两层，与实现的分层一致：
 *   - 纯函数：`forward` 段 → 占位片段 + 待回查下标；`get_forward_msg` 多形状响应解析；
 *   - 反向 WS 全回路（真实 socket，全离线）：回查、就地替换、失败降级、
 *     LRU 缓存、上限截断、开关关闭时零请求。
 *
 * 这里刻意把 `forward` 段的 @ 惰性单独测一条：群里转发的聊天记录里可能有人
 * @机器人，但那在 QQ 语义上**不构成提及**——一旦把它算成 atSelf，机器人会被
 * 一段转发的历史记录凭空叫醒。
 */

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  OnebotConnector,
  type OnebotConnectorOptions,
} from '../src/adapters/onebot/connector.js';
import { buildMessageParts } from '../src/adapters/qq-official/content.js';
import {
  extractMessageContent,
  normalizeOneBotEvent,
  parseForwardNodes,
} from '../src/adapters/onebot/normalize.js';
import { flattenParts, FORWARD_UNTRUSTED_CLOSE, FORWARD_UNTRUSTED_OPEN } from '../src/core/content.js';
import type { ForwardConfig } from '../src/config.js';
import type { NormalizedEvent, NormalizedMessage } from '../src/core/connector.js';
import { createNullLogger } from '../src/logger.js';

const FORWARD_CONFIG: ForwardConfig = {
  enabled: true,
  maxNodes: 20,
  maxNodeChars: 500,
  maxChars: 4_000,
  maxDepth: 2,
  timeoutMs: 5_000,
};

// ---------------------------------------------------------------------------
// 归一化（纯函数）
// ---------------------------------------------------------------------------

describe('转发段归一化', () => {
  it('forward 段产出占位片段并记下待回查的下标', () => {
    const extracted = extractMessageContent(
      [
        { type: 'text', data: { text: '看看这个' } },
        { type: 'forward', data: { id: 'fwd-1' } },
      ],
      10000,
    );
    // 占位片段带上 `refId`：旁听消息里的聊天记录不进 content，被 @ 且这次的问题
    // 明确提到它时才凭这个 id 去回查（见 store/window.ts 与 BotConnector.fetchForward）
    expect(extracted.parts).toEqual([
      { type: 'text', text: '看看这个' },
      { type: 'forward', parts: [], refId: 'fwd-1' },
    ]);
    expect(extracted.forwardRefs).toEqual([{ index: 1, id: 'fwd-1' }]);
    // 未展开时正文是"读不到内容"的显式占位，不是空白
    expect(extracted.content).toBe('看看这个\n[转发消息]（内容未读入）');
  });

  it('没有 id 的 forward 段直接退化成 [聊天记录]（无从回查）', () => {
    const extracted = extractMessageContent([{ type: 'forward', data: {} }], 10000);
    expect(extracted.parts).toEqual([{ type: 'text', text: '[聊天记录]' }]);
    expect(extracted.forwardRefs).toBeUndefined();
  });

  it('只兜 message_id 命名的实现', () => {
    const extracted = extractMessageContent(
      [{ type: 'forward', data: { message_id: 'fwd-2' } }],
      10000,
    );
    expect(extracted.forwardRefs).toEqual([{ index: 0, id: 'fwd-2' }]);
  });

  it('forward 段带内联 content 时，直接解析成待渲染的逐条发言（不必回查）', () => {
    const extracted = extractMessageContent(
      [
        {
          type: 'forward',
          data: {
            id: 'fwd-inline',
            content: [
              { type: 'node', data: { nickname: '张三', content: [{ type: 'text', data: { text: '在吗' } }] } },
              { type: 'node', data: { nickname: '李四', content: [{ type: 'text', data: { text: '在' } }] } },
            ],
          },
        },
      ],
      10000,
    );
    expect(extracted.forwardRefs).toEqual([
      {
        index: 0,
        id: 'fwd-inline',
        nodes: [
          { author: '张三', parts: [{ type: 'text', text: '在吗' }] },
          { author: '李四', parts: [{ type: 'text', text: '在' }] },
        ],
      },
    ]);
    expect(extracted.parts).toEqual([{ type: 'forward', parts: [], refId: 'fwd-inline' }]);
  });

  it('只有内联 content、没有 id 时不再退化成 [聊天记录]', () => {
    const extracted = extractMessageContent(
      [
        {
          type: 'forward',
          data: {
            content: [
              { type: 'node', data: { nickname: '张三', content: [{ type: 'text', data: { text: '没有 id' } }] } },
            ],
          },
        },
      ],
      10000,
    );
    expect(extracted.forwardRefs).toEqual([
      { index: 0, nodes: [{ author: '张三', parts: [{ type: 'text', text: '没有 id' }] }] },
    ]);
  });

  it('内联 content 解析不出东西时仍退回按 id 回查', () => {
    const extracted = extractMessageContent(
      [{ type: 'forward', data: { id: 'fwd-x', content: [null, 42, {}] } }],
      10000,
    );
    expect(extracted.forwardRefs).toEqual([{ index: 0, id: 'fwd-x' }]);
  });

  it('顶层 node 段（单条消息转发）按一个条目的转发块处理', () => {
    const extracted = extractMessageContent(
      [{ type: 'node', data: { nickname: '张三', content: [{ type: 'text', data: { text: '单条转发' } }] } }],
      10000,
    );
    expect(extracted.forwardRefs?.[0]?.nodes).toEqual([
      { author: '张三', parts: [{ type: 'text', text: '单条转发' }] },
    ]);
  });

  it('@ 惰性：转发块本身不构成"被 @ "，只有顶层 at 段才算', () => {
    const onlyForward = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: 10000,
      message_id: 1,
      group_id: 8888,
      user_id: 12345,
      message: [{ type: 'forward', data: { id: 'fwd-1' } }],
    });
    // 转发块本身不构成"被 @"：于是它是一条**旁听消息**（介入层会看到，
    // 但没有 atSelf 语义）。注意它带 forwardRefs → 介入层只按 content 用
    // （旁听不进 TurnRunner，不回查转发内容）。
    expect(onlyForward.type).toBe('event');
    if (onlyForward.type !== 'event') return;
    expect(onlyForward.event.kind).toBe('group-message');

    const withAt = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: 10000,
      message_id: 2,
      group_id: 8888,
      user_id: 12345,
      message: [
        { type: 'at', data: { qq: '10000' } },
        { type: 'forward', data: { id: 'fwd-1' } },
      ],
    });
    expect(withAt.type).toBe('event');
    if (withAt.type !== 'event') return;
    expect(withAt.forwardRefs).toEqual([{ index: 0, id: 'fwd-1' }]);
  });
});

describe('get_forward_msg 响应解析（多形状容忍）', () => {
  const SELF = 10000;

  it('NapCat：node 段数组，内容在 data.content 里', () => {
    const nodes = parseForwardNodes(
      {
        messages: [
          { type: 'node', data: { user_id: 111, nickname: '张三', content: [{ type: 'text', data: { text: '你好' } }] } },
          { type: 'node', data: { user_id: 222, nickname: '李四', content: [{ type: 'image', data: { url: 'https://x/1.png' } }] } },
        ],
      },
      SELF,
    );
    expect(nodes).toEqual([
      { author: '张三', parts: [{ type: 'text', text: '你好' }] },
      { author: '李四', parts: [{ type: 'image', url: 'https://x/1.png' }] },
    ]);
  });

  it('go-cqhttp：messages 是 CQ 码字符串数组', () => {
    const nodes = parseForwardNodes({ data: { messages: ['[CQ:face,id=178] 早', '纯文本'] } }, SELF);
    expect(nodes).toEqual([
      { parts: [{ type: 'text', text: '[表情]' }, { type: 'text', text: ' 早' }] },
      { parts: [{ type: 'text', text: '纯文本' }] },
    ]);
  });

  it('已解包的数组、以及 message/sender 形态也能吃下', () => {
    expect(parseForwardNodes([{ message: 'hi' }], SELF)).toEqual([
      { parts: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(
      parseForwardNodes([{ message: 'hi', sender: { card: '小明' } }], SELF),
    ).toEqual([{ author: '小明', parts: [{ type: 'text', text: 'hi' }] }]);
  });

  it('认不出的条目跳过而不是抛错；整体为空时返回空数组', () => {
    expect(parseForwardNodes({ messages: [null, 42, {}, []] }, SELF)).toEqual([]);
    expect(parseForwardNodes(undefined, SELF)).toEqual([]);
    expect(parseForwardNodes({ retcode: 1404 }, SELF)).toEqual([]);
  });

  it('发言里嵌套的转发会带出自己的待回查下标', () => {
    const nodes = parseForwardNodes(
      [
        {
          type: 'node',
          data: {
            nickname: '张三',
            content: [{ type: 'forward', data: { id: 'inner' } }],
          },
        },
      ],
      SELF,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.forwardRefs).toEqual([{ index: 0, id: 'inner' }]);
  });
});

// ---------------------------------------------------------------------------
// 反向 WS 全回路
// ---------------------------------------------------------------------------

function makeConnector(port: number, overrides: Partial<OnebotConnectorOptions> = {}) {
  const events: NormalizedEvent[] = [];
  const connector = new OnebotConnector({
    host: '127.0.0.1',
    port,
    accessToken: 'test-token',
    acceptsC2C: true,
    autoAcceptFriend: true,
    autoAcceptGroupInvite: false,
    forward: FORWARD_CONFIG,
    replyPolicy: {
      maxChars: 1500,
      maxRepliesPerMsg: 10,
      progressMax: 3,
      progressAfterMs: 90_000,
      progressIntervalMs: 90_000,
      turnTimeoutMs: 600_000,
      passiveWindowMs: Number.POSITIVE_INFINITY,
    },
    logger: createNullLogger(),
    ...overrides,
  });
  connector.on((event) => events.push(event));
  return { connector, events };
}

async function connectClient(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
      self_id: 10000,
      time: 0,
    }),
  );
  return ws;
}

function portOf(connector: OnebotConnector): number {
  return (
    connector as unknown as { server: { address: () => { port: number } } }
  ).server.address().port;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 收集所有出站帧，便于断言"发了几个动作" */
function collectFrames(ws: WebSocket): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
  return frames;
}

/** 构造一条 @机器人 + 转发块 的群消息 */
function groupForwardMessage(
  messageId: number,
  forwardId: string,
  extra: unknown[] = [],
  options: { groupId?: number; selfId?: number } = {},
) {
  return JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: options.selfId ?? 10000,
    message_id: messageId,
    group_id: options.groupId ?? 8888,
    user_id: 12345,
    time: 1_700_000_000,
    message: [
      // @ 的 qq 必须等于本账号 self_id，否则 atSelf 判定不通过
      { type: 'at', data: { qq: String(options.selfId ?? 10000) } },
      ...extra,
      { type: 'forward', data: { id: forwardId } },
    ],
    sender: { user_id: 12345, nickname: '小明' },
  });
}

function contentOf(events: NormalizedEvent[]): string {
  const message = events.find((e): e is NormalizedMessage => e.kind === 'group-at-message');
  return message?.content ?? '';
}

describe('转发块回查全回路', () => {
  let connector: OnebotConnector | undefined;
  const clients: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of clients.splice(0)) ws.close();
    await connector?.stop();
    connector = undefined;
  });

  it('回查成功后原地替换占位片段，正文保留位置与条号', async () => {
    const { connector: c, events } = makeConnector(0);
    connector = c;
    await connector.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    ws.send(
      groupForwardMessage(42, 'fwd-1', [{ type: 'text', data: { text: '帮我总结' } }]),
    );

    const action = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    expect(action['action']).toBe('get_forward_msg');
    // 参数名在实现之间不一致，一次请求同时带上两个
    expect(action['params']).toMatchObject({ id: 'fwd-1', message_id: 'fwd-1' });

    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: action['echo'],
        data: {
          messages: [
            { type: 'node', data: { nickname: '张三', content: [{ type: 'text', data: { text: '报错了' } }] } },
            { type: 'node', data: { nickname: '李四', content: [{ type: 'text', data: { text: '升级依赖' } }] } },
          ],
        },
      }),
    );
    await sleep(120);

    // 位置保持："帮我总结" → 转发块（顺序不变）
    expect(contentOf(events)).toBe(
      [
        '帮我总结',
        '[转发消息 共 2 条]',
        FORWARD_UNTRUSTED_OPEN,
        '1. 张三: 报错了',
        '2. 李四: 升级依赖',
        FORWARD_UNTRUSTED_CLOSE,
      ].join('\n'),
    );
  });

  it('回查失败时降级为 [聊天记录]，这条消息照样送进编排层', async () => {
    const { connector: c, events } = makeConnector(0);
    connector = c;
    await connector.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    ws.send(groupForwardMessage(43, 'fwd-missing'));
    const action = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    ws.send(
      JSON.stringify({ status: 'failed', retcode: 1404, echo: action['echo'], data: null }),
    );
    await sleep(120);

    expect(events.filter((e) => e.kind === 'group-at-message')).toHaveLength(1);
    expect(contentOf(events)).toBe('[聊天记录]');
  });

  it('同一条转发第二次出现不再回查（LRU 缓存）', async () => {
    const { connector: c, events } = makeConnector(0);
    connector = c;
    await connector.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);
    const frames = collectFrames(ws);

    ws.send(groupForwardMessage(44, 'fwd-cache', [{ type: 'text', data: { text: '第一次' } }]));
    await sleep(80);
    const first = frames.find((f) => f['action'] === 'get_forward_msg');
    expect(first).toBeDefined();
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: first!['echo'],
        data: { messages: ['[CQ:face,id=178] 早'] },
      }),
    );
    await sleep(120);
    expect(events.filter((e) => e.kind === 'group-at-message')).toHaveLength(1);

    ws.send(groupForwardMessage(45, 'fwd-cache', [{ type: 'text', data: { text: '第二次' } }]));
    await sleep(150);

    expect(frames.filter((f) => f['action'] === 'get_forward_msg')).toHaveLength(1);
    // 第二次用的是缓存，但内容照样展开
    const second = events.filter((e): e is NormalizedMessage => e.kind === 'group-at-message')[1];
    expect(second?.content).toContain('[转发消息 共 1 条]');
  });

  it('超出 maxNodes 时截断并留尾注', async () => {
    const { connector: c, events } = makeConnector(0, {
      forward: { ...FORWARD_CONFIG, maxNodes: 2 },
    });
    connector = c;
    await connector.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    ws.send(groupForwardMessage(46, 'fwd-big'));
    const action = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: action['echo'],
        data: { messages: ['一', '二', '三', '四'] },
      }),
    );
    await sleep(120);

    const content = contentOf(events);
    expect(content).toContain('1. 一');
    expect(content).toContain('2. 二');
    expect(content).not.toContain('3. 三');
    expect(content).toContain('（仅展开以上条目，其余未读入）');
  });

  it('单条发言超长时截断，不吃掉整个预算', async () => {
    const { connector: c, events } = makeConnector(0, {
      forward: { ...FORWARD_CONFIG, maxNodeChars: 10 },
    });
    connector = c;
    await connector.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    ws.send(groupForwardMessage(47, 'fwd-long'));
    const action = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: action['echo'],
        data: { messages: ['一二三四五六七八九十十一十二十三'] },
      }),
    );
    await sleep(120);

    expect(contentOf(events)).toContain('1. 一二三四五六七八九十…');
  });

  it('forward.enabled=false 时完全不发请求，保持 [聊天记录]', async () => {
    const { connector: c, events } = makeConnector(0, {
      forward: { ...FORWARD_CONFIG, enabled: false },
    });
    connector = c;
    await connector.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);
    const frames = collectFrames(ws);

    ws.send(groupForwardMessage(48, 'fwd-off'));
    await sleep(150);

    expect(frames).toEqual([]);
    expect(contentOf(events)).toBe('[聊天记录]');
  });

  it('回查结果通过 onForward 上报（ok + 展开条数 / 失败）', async () => {
    const reports: Array<{ ok: boolean; nodes: number }> = [];
    const { connector: c, events } = makeConnector(0, {
      onForward: (info) => reports.push(info),
    });
    connector = c;
    await connector.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    ws.send(groupForwardMessage(49, 'fwd-ok'));
    const first = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    ws.send(
      JSON.stringify({ status: 'ok', retcode: 0, echo: first['echo'], data: { messages: ['一', '二'] } }),
    );
    await sleep(120);

    ws.send(groupForwardMessage(50, 'fwd-bad'));
    const second = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    ws.send(JSON.stringify({ status: 'failed', retcode: 1400, echo: second['echo'], data: null }));
    await sleep(120);

    expect(reports).toEqual([
      { ok: true, nodes: 2 },
      { ok: false, nodes: 0 },
    ]);
    expect(events.filter((e) => e.kind === 'group-at-message')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 官方侧：聊天记录形态的 msg_elements → forward 片段（不需要回查）
// ---------------------------------------------------------------------------

describe('官方聊天记录（尽力而为）', () => {
  const elements = [
    { author: { username: '张三' }, content: '这个报错怎么解决' },
    { author: { id: 'member-2' }, content: '试试升级依赖' },
  ];

  it('非引用语义的 msg_elements 渲染成带条号与发言人的转发块', () => {
    const parts = buildMessageParts({ message_type: 102, msg_elements: elements });
    expect(parts).toEqual([
      {
        type: 'forward',
        nodeCount: 2,
        parts: [
          { type: 'text', text: '张三: 这个报错怎么解决' },
          { type: 'text', text: 'member-2: 试试升级依赖' },
        ],
      },
    ]);
    expect(flattenParts(parts)).toBe(
      [
        '[转发消息 共 2 条]',
        FORWARD_UNTRUSTED_OPEN,
        '1. 张三: 这个报错怎么解决',
        '2. member-2: 试试升级依赖',
        FORWARD_UNTRUSTED_CLOSE,
      ].join('\n'),
    );
  });

  it('message_type=103 仍是引用，不会被当成转发块', () => {
    const parts = buildMessageParts({ message_type: 103, msg_elements: elements });
    expect(parts[0]!.type).toBe('quote');
    expect(parts.some((part) => part.type === 'forward')).toBe(false);
  });

  it('按配额截断并留尾注', () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ content: `第${index + 1}条` }));
    const parts = buildMessageParts(
      { message_type: 102, msg_elements: many },
      {
        forward: {
          enabled: true,
          maxNodes: 2,
          maxNodeChars: 500,
          maxChars: 4_000,
          maxDepth: 2,
          timeoutMs: 10_000,
        },
      },
    );
    expect(parts[0]).toMatchObject({ type: 'forward', nodeCount: 5, truncated: true });
    const content = flattenParts(parts);
    expect(content).toContain('1. 第1条');
    expect(content).toContain('2. 第2条');
    expect(content).not.toContain('第3条');
    expect(content).toContain('（仅展开以上条目，其余未读入）');
  });

  it('关闭转发展开后退化成平铺文本，绝不把已有内容丢掉', () => {
    const disabled = {
      forward: {
        enabled: false,
        maxNodes: 20,
        maxNodeChars: 500,
        maxChars: 4_000,
        maxDepth: 2,
        timeoutMs: 10_000,
      },
    };
    const parts = buildMessageParts(
      { message_type: 102, content: '看看这个', msg_elements: elements },
      disabled,
    );
    expect(parts).toEqual([
      { type: 'text', text: '看看这个' },
      { type: 'text', text: '这个报错怎么解决' },
      { type: 'text', text: '试试升级依赖' },
    ]);

    // 关键回归：只有 msg_elements、没有 content 的消息，关掉转发展开也必须留下内容。
    // 否则 parts 为空 → content 为空 → 记录一条空文本用户轮、topic judge 拿空串判定
    // （很可能判成"无关"而顺手重置上下文）。
    const onlyRecord = buildMessageParts({ message_type: 102, msg_elements: elements }, disabled);
    expect(flattenParts(onlyRecord)).toBe('这个报错怎么解决\n试试升级依赖');
  });

  it('文件附件产出 media 片段（后续由摄取层下载解析）', () => {
    const parts = buildMessageParts({
      message_type: 0,
      content: '看下这个',
      attachments: [{ content_type: 'file', url: 'https://cdn.example.com/a.pdf', filename: 'a.pdf', size: 2048 }],
    });
    expect(parts).toContainEqual({
      type: 'media',
      mediaKind: 'file',
      url: 'https://cdn.example.com/a.pdf',
      filename: 'a.pdf',
      sizeBytes: 2048,
    });
  });
});

describe('转发块嵌套深度', () => {
  let connector: OnebotConnector | undefined;
  const clients: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of clients.splice(0)) ws.close();
    await connector?.stop();
    connector = undefined;
  });

  it('maxDepth=0 只展开最外层，嵌套层退化成占位（而不是整个不展开）', async () => {
    const { connector: c, events } = makeConnector(0, {
      forward: { ...FORWARD_CONFIG, maxDepth: 0 },
    });
    connector = c;
    await connector.start();
    const address = (c as unknown as { server: { address: () => { port: number } } })
      .server.address();
    const ws = await connectClient(address.port);
    clients.push(ws);

    // 外层转发：一条发言里再嵌一个转发
    ws.send(groupForwardMessage(60, 'outer'));
    const outer = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    expect(outer['action']).toBe('get_forward_msg');
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: outer['echo'],
        data: {
          messages: [
            {
              type: 'node',
              data: {
                nickname: '张三',
                content: [
                  { type: 'text', data: { text: '你看这个' } },
                  { type: 'forward', data: { id: 'inner' } },
                ],
              },
            },
          ],
        },
      }),
    );
    await sleep(150);
    const content = contentOf(events);
    // 外层照常展开
    expect(content).toContain('1. 张三: 你看这个');
    // 嵌套层没有回查（只应有一次 get_forward_msg），退化成占位
    expect(content).toContain('嵌套层级过深');
  });
});

// ---------------------------------------------------------------------------
// 资源上限（对抗性审查 S2/S3）
// ---------------------------------------------------------------------------

describe('转发读取的资源上限', () => {
  let connector: OnebotConnector | undefined;
  const clients: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of clients.splice(0)) ws.close();
    await connector?.stop();
    connector = undefined;
  });

  it('嵌套扇出有上限：一条 node 里塞多个 forward 段不会放大出无限次回查', async () => {
    const { connector: c, events } = makeConnector(0, {
      // timeoutMs 调小，让超时的嵌套回查快速走完；预算随之变小
      forward: { ...FORWARD_CONFIG, maxNodes: 2, timeoutMs: 150 },
    });
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);
    const frames = collectFrames(ws);

    ws.send(groupForwardMessage(70, 'outer'));
    await sleep(60);
    const outer = frames.find((frame) => frame['action'] === 'get_forward_msg');
    expect(outer).toBeDefined();

    // 外层只返回一条 node，但这条 node 里塞了 6 个转发段
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: outer!['echo'],
        data: {
          messages: [
            {
              type: 'node',
              data: {
                nickname: '张三',
                content: [
                  { type: 'text', data: { text: '看这些' } },
                  ...Array.from({ length: 6 }, (_, index) => ({
                    type: 'forward',
                    data: { id: `inner-${index}` },
                  })),
                ],
              },
            },
          ],
        },
      }),
    );
    // 等嵌套回查全部超时收尾
    await sleep(1_200);

    const lookups = frames.filter((frame) => frame['action'] === 'get_forward_msg');
    // 上限 = maxNodes + 2；没有这道闸时这里会有 1 + 6 次串行回查、每次最长 timeoutMs
    expect(lookups.length).toBeLessThanOrEqual(2 + 2);
    expect(lookups.length).toBeGreaterThan(1);
    // 扇出被截断，但这条用户消息照样投递
    expect(events.filter((e) => e.kind === 'group-at-message')).toHaveLength(1);
  });

  it('转发缓存按账号隔离：两个账号的同名 forward id 不会串内容', async () => {
    const { connector: c, events } = makeConnector(0);
    connector = c;
    await c.start();

    const wsA = await connectClient(portOf(c));
    clients.push(wsA);
    const wsB = new WebSocket(`ws://127.0.0.1:${portOf(c)}/onebot/v11/ws`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    await new Promise<void>((resolve, reject) => {
      wsB.once('open', () => resolve());
      wsB.once('error', reject);
    });
    clients.push(wsB);
    wsB.send(
      JSON.stringify({
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        sub_type: 'connect',
        self_id: 20000,
        time: 0,
      }),
    );
    const framesA = collectFrames(wsA);
    const framesB = collectFrames(wsB);

    // 两个账号收到**同一个** forward id（多账号下消息 id 撞号是常态）
    wsA.send(groupForwardMessage(71, 'same-id', [], { groupId: 8888, selfId: 10000 }));
    wsB.send(groupForwardMessage(72, 'same-id', [], { groupId: 9999, selfId: 20000 }));
    await sleep(120);

    const actionA = framesA.find((frame) => frame['action'] === 'get_forward_msg');
    const actionB = framesB.find((frame) => frame['action'] === 'get_forward_msg');
    // 两边都必须各自回查——缓存命中就意味着把 A 号的内容显示给了 B 号
    expect(actionA).toBeDefined();
    expect(actionB).toBeDefined();

    wsA.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: actionA!['echo'],
        data: { messages: ['A 号的聊天记录'] },
      }),
    );
    wsB.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: actionB!['echo'],
        data: { messages: ['B 号的聊天记录'] },
      }),
    );
    await sleep(150);

    const contents = events
      .filter((e): e is NormalizedMessage => e.kind === 'group-at-message')
      .map((e) => e.content);
    expect(contents).toHaveLength(2);
    expect(contents.some((content) => content.includes('A 号的聊天记录'))).toBe(true);
    expect(contents.some((content) => content.includes('B 号的聊天记录'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 顺序性：同一条消息既有引用又有转发（方案 §4 承诺的不变量）
// ---------------------------------------------------------------------------

describe('引用与转发的合并顺序', () => {
  let connector: OnebotConnector | undefined;
  const clients: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of clients.splice(0)) ws.close();
    await connector?.stop();
    connector = undefined;
  });

  function quotePlusForwardMessage(messageId: number, quotedId: string, forwardId: string) {
    return JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: 10000,
      message_id: messageId,
      group_id: 8888,
      user_id: 12345,
      time: 1_700_000_000,
      message: [
        { type: 'at', data: { qq: '10000' } },
        { type: 'reply', data: { id: quotedId } },
        { type: 'text', data: { text: '看看这个' } },
        { type: 'forward', data: { id: forwardId } },
      ],
      sender: { user_id: 12345, nickname: '小明' },
    });
  }

  it('引用在前、转发就地展开：下标不会被前插的引用挤歪', async () => {
    const { connector: c, events } = makeConnector(0);
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);
    const frames = collectFrames(ws);

    ws.send(quotePlusForwardMessage(80, '9001', 'fwd-mix'));
    await sleep(80);

    // 补全顺序：先就地展开转发（它的下标基于原始 parts），再回查引用
    const forwardAction = frames.find((frame) => frame['action'] === 'get_forward_msg');
    expect(forwardAction).toBeDefined();
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: forwardAction!['echo'],
        data: { messages: ['[CQ:face,id=178] 转发的发言'] },
      }),
    );
    await sleep(80);

    const quoteAction = frames.find((frame) => frame['action'] === 'get_msg');
    expect(quoteAction).toBeDefined();
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: quoteAction!['echo'],
        data: { message: [{ type: 'text', data: { text: '被引用的原话' } }], sender: { nickname: '张三' } },
      }),
    );
    await sleep(120);

    expect(contentOf(events)).toBe(
      [
        '[引用 张三] 被引用的原话',
        '看看这个',
        '[转发消息 共 1 条]',
        FORWARD_UNTRUSTED_OPEN,
        '1. [表情] 转发的发言',
        FORWARD_UNTRUSTED_CLOSE,
      ].join('\n'),
    );
  });

  it('被引用的消息本身是合并转发时，也会被展开（而不是"内容未读入"）', async () => {
    const { connector: c, events } = makeConnector(0);
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);
    const frames = collectFrames(ws);

    // 只带 reply，没有顶层转发
    ws.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        self_id: 10000,
        message_id: 81,
        group_id: 8888,
        user_id: 12345,
        time: 1_700_000_000,
        message: [
          { type: 'at', data: { qq: '10000' } },
          { type: 'reply', data: { id: '9002' } },
          { type: 'text', data: { text: '这段聊天记录怎么说' } },
        ],
        sender: { user_id: 12345, nickname: '小明' },
      }),
    );
    await sleep(80);

    const quoteAction = frames.find((frame) => frame['action'] === 'get_msg');
    expect(quoteAction).toBeDefined();
    // 被引用的消息是一条合并转发
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: quoteAction!['echo'],
        data: {
          message: [{ type: 'forward', data: { id: 'quoted-fwd' } }],
          sender: { nickname: '张三' },
        },
      }),
    );
    await sleep(80);

    const forwardAction = frames.find((frame) => frame['action'] === 'get_forward_msg');
    expect(forwardAction).toBeDefined();
    expect((forwardAction!['params'] as { id: string }).id).toBe('quoted-fwd');
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: forwardAction!['echo'],
        data: { messages: ['被引用的转发内容'] },
      }),
    );
    await sleep(120);

    const content = contentOf(events);
    expect(content).toContain('[引用 张三]');
    expect(content).toContain('1. 被引用的转发内容');
    expect(content).not.toContain('内容未读入');
  });
});

// ---------------------------------------------------------------------------
// 真机回归：id 精度与内联内容
//
// 这两条都来自同一个真机现象——群里发"聊天记录"，bot 回"我只看到一个
// [聊天记录] 占位"。原因是回查必然失败：19 位 msgId 被 Number() 截断后，
// NapCat 的 `payload.message_id || payload.id` 恰好优先取被截断的那个。
// ---------------------------------------------------------------------------

/** 19 位十进制消息 id：超过 2^53，Number() 一定改写末位 */
const BIG_MSG_ID = '7477882741027621893';

describe('转发块的 id 精度与内联内容', () => {
  let connector: OnebotConnector | undefined;
  const clients: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of clients.splice(0)) ws.close();
    await connector?.stop();
    connector = undefined;
  });

  it('夹具本身成立：这个 id 过一遍 Number() 会被改写', () => {
    expect(String(Number(BIG_MSG_ID))).not.toBe(BIG_MSG_ID);
    expect(Number.isSafeInteger(Number(BIG_MSG_ID))).toBe(false);
  });

  it('19 位 id：get_forward_msg 的 message_id 必须是原样字符串（真机 bug 的根因）', async () => {
    const { connector: c, events } = makeConnector(0);
    connector = c;
    await connector.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    ws.send(groupForwardMessage(201, BIG_MSG_ID));
    const action = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    expect(action['action']).toBe('get_forward_msg');
    // 关键断言：不是 number，也不是被截断的数字
    expect(action['params']).toMatchObject({ id: BIG_MSG_ID, message_id: BIG_MSG_ID });
    expect(typeof (action['params'] as { message_id: unknown }).message_id).toBe('string');

    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: action['echo'],
        data: { messages: [{ type: 'node', data: { nickname: '张三', content: [{ type: 'text', data: { text: '这是聊天记录里的内容' } }] } }] },
      }),
    );
    await sleep(120);

    expect(contentOf(events)).toContain('1. 张三: 这是聊天记录里的内容');
    expect(contentOf(events)).not.toContain('[聊天记录]');
  });

  it('短数字 id 仍按数字下发（go-cqhttp 系的入参类型是整数）', async () => {
    const { connector: c } = makeConnector(0);
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    ws.send(groupForwardMessage(202, '123456789'));
    const action = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    expect(action['params']).toMatchObject({ id: '123456789', message_id: 123456789 });
    expect(typeof (action['params'] as { message_id: unknown }).message_id).toBe('number');
  });

  it('上报已内联 content 时零回查，直接展开（NapCat 的 forward.data.content）', async () => {
    const { connector: c, events } = makeConnector(0);
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);
    const frames = collectFrames(ws);

    ws.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        self_id: 10000,
        message_id: 203,
        group_id: 8888,
        user_id: 12345,
        time: 1_700_000_000,
        message: [
          { type: 'at', data: { qq: '10000' } },
          {
            type: 'forward',
            data: {
              id: BIG_MSG_ID,
              content: [
                { type: 'node', data: { user_id: 111, nickname: '张三', content: [{ type: 'text', data: { text: '今晚吃什么' } }] } },
                { type: 'node', data: { user_id: 222, nickname: '李四', content: [{ type: 'text', data: { text: '随便' } }] } },
              ],
            },
          },
        ],
        sender: { user_id: 12345, nickname: '小明' },
      }),
    );
    await sleep(150);

    expect(frames.filter((frame) => frame['action'] === 'get_forward_msg')).toHaveLength(0);
    expect(contentOf(events)).toBe(
      [
        '[转发消息 共 2 条]',
        FORWARD_UNTRUSTED_OPEN,
        '1. 张三: 今晚吃什么',
        '2. 李四: 随便',
        FORWARD_UNTRUSTED_CLOSE,
      ].join('\n'),
    );
  });

  it('只有内联内容、没有 id 时也能展开（不再退化成 [聊天记录]）', async () => {
    const { connector: c, events } = makeConnector(0);
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);
    const frames = collectFrames(ws);

    ws.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        self_id: 10000,
        message_id: 204,
        user_id: 12345,
        time: 1_700_000_000,
        message: [
          {
            type: 'forward',
            data: {
              content: [
                { type: 'node', data: { nickname: '张三', content: [{ type: 'text', data: { text: '没有 id 的聊天记录' } }] } },
              ],
            },
          },
        ],
        sender: { user_id: 12345, nickname: '小明' },
      }),
    );
    await sleep(150);

    expect(frames.filter((frame) => frame['action'] === 'get_forward_msg')).toHaveLength(0);
    const message = events.find((e): e is NormalizedMessage => e.kind === 'c2c-message');
    expect(message?.content).toContain('1. 张三: 没有 id 的聊天记录');
  });

  it('引用回查的 message_id 同样不能被截断', async () => {
    const { connector: c } = makeConnector(0);
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    ws.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        self_id: 10000,
        message_id: 205,
        group_id: 8888,
        user_id: 12345,
        time: 1_700_000_000,
        message: [
          { type: 'at', data: { qq: '10000' } },
          { type: 'reply', data: { id: BIG_MSG_ID } },
          { type: 'text', data: { text: '这条怎么说' } },
        ],
        sender: { user_id: 12345, nickname: '小明' },
      }),
    );

    const action = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    expect(action['action']).toBe('get_msg');
    expect((action['params'] as { message_id: unknown }).message_id).toBe(BIG_MSG_ID);
  });
});

// ---------------------------------------------------------------------------
// 按需展开（旁听消息里的聊天记录 → 被 @ 且明确提及时才回查）
// ---------------------------------------------------------------------------

/**
 * 旁听消息里的聊天记录**不进 content**（一条转发动辄几十条发言，当普通群聊上下文
 * 灌进去既烧 token 又把真正在聊的事淹掉），只把 id 留在观察窗口里。被 @ 且这次的
 * 问题明确提到它时，编排层才回调 `fetchForward`——这一组锁的就是这个回调。
 */
describe('按需展开聊天记录（BotConnector.fetchForward）', () => {
  let connector: OnebotConnector | undefined;
  const clients: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of clients.splice(0)) ws.close();
    await connector?.stop();
    connector = undefined;
  });

  it('给 id 就回查，返回可渲染的转发片段（复用同一套上限与队列）', async () => {
    const { connector: c } = makeConnector(0);
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    const pending = c.fetchForward(
      { platform: 'onebot', kind: 'group', id: '8888', key: 'ob11:g8888' },
      'fwd-late',
    );
    const action = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    expect(action['action']).toBe('get_forward_msg');
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        echo: action['echo'],
        data: {
          messages: [
            { type: 'node', data: { nickname: '张三', content: [{ type: 'text', data: { text: '在吗' } }] } },
            { type: 'node', data: { nickname: '李四', content: [{ type: 'text', data: { text: '在' } }] } },
          ],
        },
      }),
    );

    const part = await pending;
    expect(part?.type).toBe('forward');
    expect(part?.nodeCount).toBe(2);
    // 渲染形态与 @ 路径完全一致（带条号 + 不可信边界），模型看到的语义不变
    expect(flattenParts([part!])).toBe(
      [
        '[转发消息 共 2 条]',
        FORWARD_UNTRUSTED_OPEN,
        '1. 张三: 在吗',
        '2. 李四: 在',
        FORWARD_UNTRUSTED_CLOSE,
      ].join('\n'),
    );
  });

  it('回查失败返回 undefined（调用方据此降级成"这条记录没读出来"）', async () => {
    const { connector: c } = makeConnector(0);
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);

    const pending = c.fetchForward(
      { platform: 'onebot', kind: 'group', id: '8888', key: 'ob11:g8888' },
      'fwd-missing',
    );
    const action = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    ws.send(
      JSON.stringify({
        status: 'failed',
        retcode: 1200,
        echo: action['echo'],
        message: '消息已过期或者为内层消息',
      }),
    );
    await expect(pending).resolves.toBeUndefined();
  });

  it('关掉转发展开时一个请求都不发（与 @ 路径同一个开关）', async () => {
    const { connector: c } = makeConnector(0, { forward: { ...FORWARD_CONFIG, enabled: false } });
    connector = c;
    await c.start();
    const ws = await connectClient(portOf(c));
    clients.push(ws);
    const frames = collectFrames(ws);

    await expect(
      c.fetchForward({ platform: 'onebot', kind: 'group', id: '8888', key: 'ob11:g8888' }, 'fwd-1'),
    ).resolves.toBeUndefined();
    await sleep(80);
    expect(frames).toEqual([]);
  });
});
