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
import {
  extractMessageContent,
  normalizeOneBotEvent,
  parseForwardNodes,
} from '../src/adapters/onebot/normalize.js';
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
    expect(extracted.parts).toEqual([
      { type: 'text', text: '看看这个' },
      { type: 'forward', parts: [] },
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
    expect(onlyForward.type).toBe('ignored');

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
function groupForwardMessage(messageId: number, forwardId: string, extra: unknown[] = []) {
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
        '1. 张三: 报错了',
        '2. 李四: 升级依赖',
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
