/**
 * 网关状态机单测（用假 WebSocket，全离线）。
 *
 * 这一层的问题表现为"机器人看着在线但永远不回消息"，所以重点测：
 *   - Hello → Identify 的帧形态（token 前缀、intents、shard）；
 *   - 心跳携带最后收到的 seq；
 *   - 4009 走 Resume、4006 走重新 Identify；
 *   - 事件归一化（尤其是 @前缀已被平台剥离、时间戳解析）。
 */

import { describe, expect, it, vi } from 'vitest';

import { createNullLogger } from '../src/logger.js';
import { QqGateway, parseTimestamp, type WebSocketLike } from '../src/qq/gateway.js';
import { OpCode } from '../src/qq/types.js';

const logger = createNullLogger();

/** 假 WebSocket：记录发出的帧，允许测试注入服务端消息。 */
class FakeWebSocket implements WebSocketLike {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | undefined;
  private readonly listeners: Record<string, Array<(event: unknown) => void>> = {};

  addEventListener(type: string, listener: (event: never) => void): void {
    (this.listeners[type] ??= []).push(listener as (event: unknown) => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
  }

  /** 测试侧触发事件 */
  fire(type: 'open' | 'error', event: unknown = {}): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }

  fireMessage(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const listener of this.listeners['message'] ?? []) listener({ data });
  }

  fireClose(code: number, reason = ''): void {
    for (const listener of this.listeners['close'] ?? []) listener({ code, reason });
  }

  get frames(): Array<Record<string, unknown>> {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  framesOfOp(op: number): Array<Record<string, unknown>> {
    return this.frames.filter((frame) => frame['op'] === op);
  }
}

function makeGateway(options: { intents?: number; token?: string; backoffMs?: { baseMs: number; maxMs: number } } = {}) {
  let socketIndex = 0;
  const sockets: FakeWebSocket[] = [];
  const getGateway = vi.fn(async () => ({ url: 'wss://api.bot.qq.com/websocket/' }));
  const tokenManager = {
    get: vi.fn(async () => options.token ?? 'TOKEN-1'),
    forceRefresh: vi.fn(async () => 'TOKEN-2'),
  };

  const gateway = new QqGateway({
    api: { getGateway },
    tokenManager: tokenManager as never,
    intents: options.intents ?? 50331648,
    logger,
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      socketIndex += 1;
      return socket;
    },
    // 默认给一个较长的退避，这样"已安排重连"的状态在测试里可观测；
    // 想验证快速重连的用例自己传更小的值。
    backoff: options.backoffMs ?? { baseMs: 60_000, maxMs: 60_000 },
    heartbeatJitterRatio: 0,
    random: () => 0.5,
  });

  return { gateway, sockets, tokenManager, getGateway, get current() { return sockets[socketIndex - 1]; } };
}

/** 让 start() 里注册的 await 有机会推进，并推进 uv 上的定时器。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 推进异步链。
 *
 * 刻意用真实定时器而不是 vi.useFakeTimers()：DSH/网关里的定时器都调用了
 * unref()，而 unref 过的定时器在 vitest 假定时器下不会正常触发，
 * 用它会让测试变成假绿或假红。真实小延时虽然慢几十毫秒，但结论可信。
 */
async function flush(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await Promise.resolve();
}

describe('QqGateway 握手', () => {
  it('收到 Hello 后用 QQBot <token> 前缀 Identify，并带 intents 与 shard', async () => {
    const { gateway, sockets } = makeGateway({ intents: 100663296 });
    const started = gateway.start();
    await tick();

    const socket = sockets[0]!;
    socket.fire('open');
    socket.fireMessage({ op: OpCode.HELLO, d: { heartbeat_interval: 45_000 } });
    await tick();

    const identify = socket.framesOfOp(OpCode.IDENTIFY);
    expect(identify).toHaveLength(1);
    const d = identify[0]!['d'] as Record<string, unknown>;
    expect(d['token']).toBe('QQBot TOKEN-1');
    expect(d['intents']).toBe(100663296);
    expect(d['shard']).toEqual([0, 1]);
    expect(d['properties']).toMatchObject({ $browser: 'qqbot-dsh' });

    // READY 后 start() 才 resolve
    socket.fireMessage({
      op: OpCode.DISPATCH,
      s: 1,
      t: 'READY',
      d: { session_id: 'sess-1', user: { username: 'bot' }, shard: [0, 0] },
    });
    await started;

    expect(gateway.health()).toMatchObject({ connected: true, state: 'ready', sessionId: 'sess-1' });
    await gateway.stop();
  });

  it('Identify 使用 QQBot 前缀（回归防护：旧文档写的是 Bot <appid>.<token>）', async () => {
    const { gateway, sockets } = makeGateway();
    const started = gateway.start();
    await flush(0);
    sockets[0]!.fireMessage({ op: OpCode.HELLO, d: { heartbeat_interval: 45_000 } });
    await flush(0);
    const identify = sockets[0]!.framesOfOp(OpCode.IDENTIFY)[0]!;
    const token = (identify['d'] as Record<string, unknown>)['token'];
    expect(String(token).startsWith('QQBot ')).toBe(true);
    expect(String(token).startsWith('Bot ')).toBe(false);
    expect(String(token)).toBe('QQBot TOKEN-1');
    // 让 start() 的 promise 收敛，避免留下悬挂的回调
    sockets[0]!.fireMessage({ op: OpCode.DISPATCH, s: 1, t: 'READY', d: { session_id: 's' } });
    await started;
    await gateway.stop();
  });

  it('Hello 缺少 heartbeat_interval 时不崩，转为重连', async () => {
    const { gateway, sockets } = makeGateway();
    void gateway.start();
    await flush(0);
    sockets[0]!.fireMessage({ op: OpCode.HELLO, d: {} });
    // 不应发出 Identify（没有心跳周期就谈不上维持连接），且应进入重连流程
    expect(sockets[0]!.framesOfOp(OpCode.IDENTIFY)).toHaveLength(0);
    expect(sockets[0]!.closed).toBeDefined();
    expect(gateway.health().state).not.toBe('stopped');
    await gateway.stop();
  });
});

describe('QqGateway 心跳', () => {
  it('心跳携带最后收到的 seq', async () => {
    // 注意：startHeartbeat 里有 Math.max(1_000, interval) 的下限保护，
    // 所以即使 Hello 给的周期更短，首个心跳也在 1 秒后发出。测试按真实量级来。
    const { gateway, sockets } = makeGateway();
    void gateway.start();
    await flush(0);

    const socket = sockets[0]!;
    socket.fireMessage({ op: OpCode.HELLO, d: { heartbeat_interval: 1_000 } });
    await flush(0);
    socket.fireMessage({
      op: OpCode.DISPATCH,
      s: 7,
      t: 'READY',
      d: { session_id: 's', shard: [0, 0] },
    });
    await flush(0);

    // 抖动比例 0 → 首个心跳约 1s 后发出
    await flush(1_300);
    const heartbeats = socket.framesOfOp(OpCode.HEARTBEAT);
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(heartbeats[0]!['d']).toBe(7);

    await gateway.stop();
  });

  it('心跳未收到 ACK 会判定连接僵死并重连', async () => {
    // 周期 1s（受下限保护）→ ack 超时 2s。总等待约 3.5s。
    const { gateway, sockets, getGateway } = makeGateway({ backoffMs: { baseMs: 1, maxMs: 4 } });
    void gateway.start();
    await flush(0);
    const socket = sockets[0]!;
    socket.fireMessage({ op: OpCode.HELLO, d: { heartbeat_interval: 1_000 } });
    await flush(0);
    socket.fireMessage({ op: OpCode.DISPATCH, s: 1, t: 'READY', d: { session_id: 's' } });
    await flush(0);

    const callsBefore = getGateway.mock.calls.length;
    // 等够一个心跳(1s) + 一个 ack 超时(2s) + 重连余量
    await flush(3_600);

    // 可观测证据：老连接被主动关闭，且重新去取了网关地址
    expect(socket.closed).toBeDefined();
    expect(getGateway.mock.calls.length).toBeGreaterThan(callsBefore);
    await gateway.stop();
  });
});

describe('QqGateway 断线与恢复', () => {
  it('4009（session 过期）走 Resume 且带 session_id 与 seq', async () => {
    {
      // 极小退避，让重连在测试的几十毫秒内完成
      const { gateway, sockets } = makeGateway({ backoffMs: { baseMs: 1, maxMs: 4 } });
      void gateway.start();
      await flush(0);
      sockets[0]!.fireMessage({ op: OpCode.HELLO, d: { heartbeat_interval: 60_000 } });
      await flush(0);
      sockets[0]!.fireMessage({ op: OpCode.DISPATCH, s: 42, t: 'READY', d: { session_id: 'sess-X' } });
      await flush(0);

      // 4009：可以 Resume
      sockets[0]!.fireClose(4009, 'session expired');
      await flush(2_000);

      const second = sockets[1];
      expect(second).toBeDefined();
      second!.fireMessage({ op: OpCode.HELLO, d: { heartbeat_interval: 60_000 } });
      await flush(0);

      const resume = second!.framesOfOp(OpCode.RESUME);
      expect(resume).toHaveLength(1);
      expect(resume[0]!['d']).toMatchObject({ session_id: 'sess-X', seq: 42 });
      // Resume 时不应再发 Identify
      expect(second!.framesOfOp(OpCode.IDENTIFY)).toHaveLength(0);
      await gateway.stop();
    }
  });

  it('4006（session 无效）走重新 Identify，不带 Resume', async () => {
    {
      const { gateway, sockets } = makeGateway({ backoffMs: { baseMs: 1, maxMs: 4 } });
      void gateway.start();
      await flush(0);
      sockets[0]!.fireMessage({ op: OpCode.HELLO, d: { heartbeat_interval: 60_000 } });
      await flush(0);
      sockets[0]!.fireMessage({ op: OpCode.DISPATCH, s: 9, t: 'READY', d: { session_id: 'sess-Y' } });
      await flush(0);

      sockets[0]!.fireClose(4006, 'invalid session');
      await flush(2_000);

      const second = sockets[1]!;
      second.fireMessage({ op: OpCode.HELLO, d: { heartbeat_interval: 60_000 } });
      await flush(0);

      expect(second.framesOfOp(OpCode.RESUME)).toHaveLength(0);
      expect(second.framesOfOp(OpCode.IDENTIFY)).toHaveLength(1);
      await gateway.stop();
    }
  });

  it('op9 Invalid Session 清空 session 并重新 Identify', async () => {
    {
      const { gateway, sockets } = makeGateway({ backoffMs: { baseMs: 1, maxMs: 4 } });
      void gateway.start();
      await flush(0);
      sockets[0]!.fireMessage({ op: OpCode.HELLO, d: { heartbeat_interval: 60_000 } });
      await flush(0);
      sockets[0]!.fireMessage({ op: OpCode.DISPATCH, s: 3, t: 'READY', d: { session_id: 'sess-Z' } });
      await flush(0);

      sockets[0]!.fireMessage({ op: OpCode.INVALID_SESSION, d: true });
      await flush(2_000);

      const second = sockets[1]!;
      second.fireMessage({ op: OpCode.HELLO, d: { heartbeat_interval: 60_000 } });
      await flush(0);
      expect(second.framesOfOp(OpCode.RESUME)).toHaveLength(0);
      expect(second.framesOfOp(OpCode.IDENTIFY)).toHaveLength(1);
      await gateway.stop();
    }
  });
});

describe('QqGateway 事件归一化', () => {
  async function readyGateway() {
    const harness = makeGateway();
    const events: unknown[] = [];
    harness.gateway.on((event) => events.push(event));
    const started = harness.gateway.start();
    await tick();
    const socket = harness.sockets[0]!;
    socket.fireMessage({ op: OpCode.HELLO, d: { heartbeat_interval: 60_000 } });
    await tick();
    socket.fireMessage({ op: OpCode.DISPATCH, s: 1, t: 'READY', d: { session_id: 's' } });
    await started;
    return { ...harness, events, socket };
  }

  it('GROUP_AT_MESSAGE_CREATE 归一化出 msgId / groupOpenid / memberOpenid', async () => {
    const { gateway, events, socket } = await readyGateway();
    socket.fireMessage({
      id: 'EVENT-1',
      op: OpCode.DISPATCH,
      s: 2,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'MSG-1',
        content: '帮我算个数',
        group_openid: 'GROUP-A',
        timestamp: '2026-07-21T10:00:00+08:00',
        author: { member_openid: 'MEMBER-1', username: '小明' },
      },
    });

    const message = events.find((e) => (e as { kind: string }).kind === 'group-at-message') as {
      eventId: string;
      msgId: string;
      groupOpenid: string;
      memberOpenid: string;
      username?: string;
      content: string;
    };
    expect(message).toBeDefined();
    expect(message.eventId).toBe('EVENT-1');
    expect(message.msgId).toBe('MSG-1');
    expect(message.groupOpenid).toBe('GROUP-A');
    expect(message.memberOpenid).toBe('MEMBER-1');
    expect(message.username).toBe('小明');
    expect(message.content).toBe('帮我算个数');
    await gateway.stop();
  });

  it('缺少 group_openid 的消息事件被忽略而不崩', async () => {
    const { gateway, events, socket } = await readyGateway();
    const before = events.length;
    socket.fireMessage({
      op: OpCode.DISPATCH,
      s: 3,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: { id: 'MSG-X', content: 'x' },
    });
    expect(events.length).toBe(before);
    await gateway.stop();
  });

  it('GROUP_ADD_ROBOT 归一化并带 eventId（用于 event_id 回复）', async () => {
    const { gateway, events, socket } = await readyGateway();
    socket.fireMessage({
      id: 'EVENT-ADD',
      op: OpCode.DISPATCH,
      s: 4,
      t: 'GROUP_ADD_ROBOT',
      d: { group_openid: 'GROUP-B', op_member_openid: 'M-1', timestamp: 1699240248 },
    });
    const event = events.find((e) => (e as { kind: string }).kind === 'group-add-robot') as {
      groupOpenid: string;
      eventId: string;
    };
    expect(event.groupOpenid).toBe('GROUP-B');
    expect(event.eventId).toBe('EVENT-ADD');
    await gateway.stop();
  });

  it('未订阅的事件类型被安静忽略', async () => {
    const { gateway, events, socket } = await readyGateway();
    const before = events.length;
    socket.fireMessage({ op: OpCode.DISPATCH, s: 5, t: 'C2C_MESSAGE_CREATE', d: { id: 'x' } });
    expect(events.length).toBe(before);
    await gateway.stop();
  });

  it('RESUMED 把状态置回 ready', async () => {
    const { gateway, socket } = await readyGateway();
    socket.fireMessage({ op: OpCode.DISPATCH, s: 6, t: 'RESUMED', d: '' });
    expect(gateway.health()).toMatchObject({ connected: true, state: 'ready' });
    await gateway.stop();
  });

  it('非法 JSON 被忽略而不崩', async () => {
    const { gateway, socket } = await readyGateway();
    socket.fireMessage('这不是 JSON');
    expect(gateway.health().state).toBe('ready');
    await gateway.stop();
  });

  it('health 记录 lastEventAt 与 lastSeq', async () => {
    const { gateway, socket } = await readyGateway();
    socket.fireMessage({
      op: OpCode.DISPATCH,
      s: 99,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: { id: 'm', content: 'c', group_openid: 'g', author: {} },
    });
    const health = gateway.health();
    expect(health.lastSeq).toBe(99);
    expect(health.lastEventAt).toBeTypeOf('number');
    await gateway.stop();
  });
});

describe('parseTimestamp', () => {
  it('解析 RFC3339 字符串', () => {
    const parsed = parseTimestamp('2026-07-21T10:00:00+08:00');
    expect(parsed).toBe(Date.parse('2026-07-21T10:00:00+08:00'));
  });

  it('unix 秒被转成毫秒', () => {
    expect(parseTimestamp(1699240248)).toBe(1699240248000);
  });

  it('unix 毫秒原样返回', () => {
    expect(parseTimestamp(1699240248000)).toBe(1699240248000);
  });

  it('无法解析时返回 undefined 而不是 NaN', () => {
    expect(parseTimestamp('不是时间')).toBeUndefined();
    expect(parseTimestamp(undefined)).toBeUndefined();
    expect(parseTimestamp(null)).toBeUndefined();
  });
});
