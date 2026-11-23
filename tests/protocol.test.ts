/**
 * DSH 协议客户端与 turn 归并单测（全离线，不启动任何子进程）。
 *
 * 这一层最容易出的 bug 是"帧错位导致请求永久挂起"，所以重点测：
 *   - 粘包/拆包（一次 data 里多个帧、一个帧跨多次 data）；
 *   - stdout 污染必须被显式报错，而不是静默丢弃；
 *   - 并发请求按 id 正确配对。
 */

/**
 * DSH 协议客户端与 turn 归并单测（全离线，不启动任何子进程）。
 *
 * 这一层最容易出的 bug 是"帧错位导致请求永久挂起"，所以重点测：
 *   - 粘包/拆包（一次 data 里多个帧、一个帧跨多次 data）；
 *   - stdout 污染必须被显式报错，而不是静默丢弃；
 *   - 并发请求按 id 正确配对。
 */
import { getEventListeners } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HarnessSdkClient,
  JsonRpcRequestTimeoutError,
  JsonRpcResponseError,
  ProtocolViolationError,
} from '../src/dsh/protocol.js';
import { extractAssistantText, TurnAccumulator } from '../src/dsh/turns.js';

/** 建一个客户端 + 可写的"服务端"流。 */
function makeClient(fromClient: Writable = new PassThrough()) {
  const toClient = new PassThrough();
  const written: string[] = [];
  fromClient.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));

  const violations: ProtocolViolationError[] = [];
  const client = new HarnessSdkClient({
    input: toClient,
    output: fromClient,
    requestTimeoutMs: 1_000,
  });
  client.on('violation', (error) => violations.push(error));

  const reply = (frame: unknown) => toClient.write(`${JSON.stringify(frame)}\n`);
  const replyRaw = (raw: string) => toClient.write(raw);

  return { client, reply, replyRaw, written, violations, toClient, fromClient };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
afterEach(() => vi.useRealTimers());

describe('HarnessSdkClient', () => {
  it('按 id 配对响应到对应请求', async () => {
    const { client, reply, written } = makeClient();

    const first = client.initialize({ cwd: '/w', provider: 'p', model: 'm' });
    const second = client.prompt({ sessionId: 's', contentBlocks: [{ type: 'text', text: 'x' }] });

    await settle();
    // 两个请求帧都应已写出，id 分别为 1 与 2
    const frames = written.map((line) => JSON.parse(line) as { id: number; method: string });
    expect(frames.map((f) => f.method)).toEqual(['initialize', 'session/prompt']);
    expect(frames.map((f) => f.id)).toEqual([1, 2]);

    // 故意乱序回复
    reply({ jsonrpc: '2.0', id: 2, result: { messageId: 'msg-2' } });
    reply({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'n', version: 'v' } } });

    await expect(second).resolves.toEqual({ messageId: 'msg-2' });
    await expect(first).resolves.toEqual({ serverInfo: { name: 'n', version: 'v' } });
    client.close();
  });

  it('错误响应 reject 出 JsonRpcResponseError 并保留 code', async () => {
    const { client, reply } = makeClient();
    const pending = client.prompt({ sessionId: 's', contentBlocks: [{ type: 'text', text: 'x' }] });
    await settle();
    reply({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } });

    await expect(pending).rejects.toBeInstanceOf(JsonRpcResponseError);
    await expect(pending).rejects.toMatchObject({ code: -32603 });
    client.close();
  });

  it('处理粘包：一次写入多个帧', async () => {
    const { client, toClient } = makeClient();
    const pending = client.initialize({ cwd: '/w', provider: 'p', model: 'm' });
    await settle();

    toClient.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 's', status: 'running' } })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'n', version: 'v' } } })}\n`
    );

    await expect(pending).resolves.toEqual({ serverInfo: { name: 'n', version: 'v' } });
    client.close();
  });

  it('处理拆包：一个帧跨多次写入', async () => {
    const { client, toClient } = makeClient();
    const pending = client.initialize({ cwd: '/w', provider: 'p', model: 'm' });
    await settle();

    const frame = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'n', version: 'v' } },
    });
    toClient.write(frame.slice(0, 10));
    toClient.write(frame.slice(10));
    toClient.write('\n');

    await expect(pending).resolves.toEqual({ serverInfo: { name: 'n', version: 'v' } });
    client.close();
  });

  it('通知被分发到对应事件', async () => {
    const { client, toClient } = makeClient();
    const statusHandler = vi.fn();
    const eventHandler = vi.fn();
    client.on('session.status', statusHandler);
    client.on('session.event', eventHandler);

    toClient.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 's', status: 'idle' } })}\n`
    );
    toClient.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session.event',
        params: { sessionId: 's', event: { type: 'turn/start', seq: 1, data: { turn: 1 } } },
      })}\n`
    );

    expect(statusHandler).toHaveBeenCalledWith({ sessionId: 's', status: 'idle' });
    expect(eventHandler).toHaveBeenCalledWith({
      sessionId: 's',
      event: { type: 'turn/start', seq: 1, data: { turn: 1 } },
    });
    client.close();
  });

  it('subagent.started/finished 通知被解析成类型化载荷', async () => {
    const { client, toClient } = makeClient();
    const started = vi.fn();
    const finished = vi.fn();
    client.on('subagent.started', started);
    client.on('subagent.finished', finished);

    toClient.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'subagent.started',
        params: { parentSessionId: 'p1', childSessionId: 'c1' },
      })}\n`
    );
    toClient.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'subagent.finished',
        params: {
          provider: 'spawn',
          agentId: 'c1',
          parentSessionId: 'p1',
          childSessionId: 'c1',
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: '结果' }, null, 'garbage'],
        },
      })}\n`
    );
    await settle();

    expect(started).toHaveBeenCalledWith({ parentSessionId: 'p1', childSessionId: 'c1' });
    expect(finished).toHaveBeenCalledTimes(1);
    const payload = finished.mock.calls[0]![0] as {
      status: string;
      stopReason: string;
      lastAssistantMessage: unknown[];
    };
    expect(payload.status).toBe('ok');
    expect(payload.stopReason).toBe('completed');
    // 非对象的块被防御性剔除，合法块原样保留
    expect(payload.lastAssistantMessage).toEqual([{ type: 'text', text: '结果' }]);
    client.close();
  });

  it('形状不对的 subagent 通知走 invalid 诊断，不抛错', async () => {
    const { client, toClient } = makeClient();
    const started = vi.fn();
    const invalid = vi.fn();
    client.on('subagent.started', started);
    client.on('invalid', invalid);

    toClient.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'subagent.started', params: { parentSessionId: 'p1' } })}\n`
    );
    toClient.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'subagent.finished', params: null })}\n`
    );
    await settle();

    expect(started).not.toHaveBeenCalled();
    expect(invalid).toHaveBeenCalledTimes(2);
    client.close();
  });

  it('stdout 出现非 JSON 内容时报 violation（而不是静默丢弃）', async () => {
    const { client, replyRaw, violations } = makeClient();
    replyRaw('这是一行被插件写进 stdout 的日志\n');
    await settle();

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/协议通道被污染/);
    expect(violations[0]?.rawLine).toContain('插件写进 stdout');
    client.close();
  });

  it('请求超时会 reject 并清理在途请求', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client } = makeClient();
    const controller = new AbortController();
    const pending = client.initialize(
      { cwd: '/w', provider: 'p', model: 'm' },
      { timeoutMs: 30, signal: controller.signal }
    );
    const rejection = expect(pending).rejects.toBeInstanceOf(JsonRpcRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(30);
    await rejection;
    await expect(pending).rejects.toMatchObject({ method: 'initialize', timeoutMs: 30 });
    expect(client.pendingCount).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it('已取消的信号保留取消原因，且不会写出请求或留下计时器', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, written } = makeClient();
    const controller = new AbortController();
    const reason = new Error('取消启动');
    controller.abort(reason);
    await expect(
      client.initialize({ cwd: '/w', provider: 'p', model: 'm' }, { signal: controller.signal })
    ).rejects.toBe(reason);
    expect(written).toEqual([]);
    expect(client.pendingCount).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it('取消只清理所属请求，迟到响应不影响其他请求', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, reply } = makeClient();
    const controller = new AbortController();
    const unknown = vi.fn();
    client.on('unknown', unknown);
    const first = client.initialize(
      { cwd: '/w', provider: 'p', model: 'm' },
      { signal: controller.signal }
    );
    const second = client.prompt({ sessionId: 's', contentBlocks: [] });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    controller.abort();
    await expect(first).rejects.toBe(controller.signal.reason);
    expect(controller.signal.reason).toMatchObject({ name: 'AbortError' });
    expect(client.pendingCount).toBe(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    const lateResponse = { jsonrpc: '2.0', id: 1, result: { serverInfo: {} } };
    reply(lateResponse);
    expect(unknown).toHaveBeenCalledWith(lateResponse);
    reply({ jsonrpc: '2.0', id: 2, result: { messageId: 'm-2' } });
    await expect(second).resolves.toEqual({ messageId: 'm-2' });
    expect(client.pendingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it.each(['success', 'error'])('响应 %s 后移除取消监听和计时器', async (outcome) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, reply } = makeClient();
    const controller = new AbortController();
    const pending = client.initialize(
      { cwd: '/w', provider: 'p', model: 'm' },
      { signal: controller.signal }
    );
    const result = { serverInfo: { name: 'n', version: 'v' } };
    reply({
      jsonrpc: '2.0',
      id: 1,
      ...(outcome === 'success' ? { result } : { error: { code: -32603, message: 'boom' } }),
    });
    if (outcome === 'success') await expect(pending).resolves.toEqual(result);
    else await expect(pending).rejects.toBeInstanceOf(JsonRpcResponseError);
    expect(client.pendingCount).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    client.close();
  });

  it.each(['close', 'stdout end'])('%s 后清理所有请求和流监听', async (outcome) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, toClient, fromClient } = makeClient();
    const controllers = [new AbortController(), new AbortController()];
    const pending = controllers.map((controller) =>
      client.initialize({ cwd: '/w', provider: 'p', model: 'm' }, { signal: controller.signal })
    );
    const failures = pending.map((request) => expect(request).rejects.toThrow(/未完成/));
    if (outcome === 'close') client.close();
    else {
      toClient.end();
      await settle();
    }
    await Promise.all(failures);
    await settle();
    expect(client.isClosed).toBe(true);
    expect(client.pendingCount).toBe(0);
    for (const controller of controllers)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    for (const event of ['data', 'end', 'error']) expect(toClient.listenerCount(event)).toBe(0);
    expect(fromClient.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it('同步 write 抛错也清理所属请求、取消监听和计时器', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, fromClient } = makeClient();
    const controller = new AbortController();
    const error = new Error('write failed');
    vi.spyOn(fromClient, 'write').mockImplementation(() => {
      throw error;
    });
    await expect(
      client.initialize({ cwd: '/w', provider: 'p', model: 'm' }, { signal: controller.signal })
    ).rejects.toBe(error);
    expect(client.pendingCount).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it('异步 write 失败会关闭传输并清理全部请求', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const error = new Error('write failed');
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate(() => {
          callback(error);
        });
      },
    });
    const { client, toClient } = makeClient(output);
    const controller = new AbortController();
    const first = client.initialize(
      { cwd: '/w', provider: 'p', model: 'm' },
      { signal: controller.signal }
    );
    const second = client.prompt({ sessionId: 's', contentBlocks: [] });
    const failures = [expect(first).rejects.toBe(error), expect(second).rejects.toBe(error)];
    await settle();
    await Promise.all(failures);
    expect(client.isClosed).toBe(true);
    expect(client.pendingCount).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(toClient.listenerCount('data')).toBe(0);
    expect(output.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('取消并关闭后迟到的 write 错误仍被接收，写入结束后释放监听', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const error = new Error('late write failed');
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate(() => {
          callback(error);
        });
      },
    });
    const { client } = makeClient(output);
    const controller = new AbortController();
    const pending = client.initialize(
      { cwd: '/w', provider: 'p', model: 'm' },
      { signal: controller.signal }
    );
    controller.abort();
    client.close();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(client.pendingCount).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await settle();
    expect(output.listenerCount('error')).toBe(0);
  });

  it('服务端若发来请求，回 -32601 而不是挂等', async () => {
    const { client, toClient, written } = makeClient();
    toClient.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'some/request', params: {} })}\n`
    );
    await settle();

    const reply = written
      .map((line) => JSON.parse(line) as { id?: number; error?: { code?: number } })
      .find((f) => f.id === 99);
    expect(reply?.error?.code).toBe(-32601);
    client.close();
  });

  it('输入结束后在途请求全部 reject（避免永久挂起）', async () => {
    const { client, toClient } = makeClient();
    const pending = client.initialize({ cwd: '/w', provider: 'p', model: 'm' });
    await settle();
    toClient.end();
    await expect(pending).rejects.toThrow(/stdout 已结束/);
  });

  it('close 后拒绝新请求', async () => {
    const { client } = makeClient();
    client.close();
    await expect(client.prompt({ sessionId: 's', contentBlocks: [] })).rejects.toThrow(
      /传输已关闭/
    );
  });
});

describe('extractAssistantText', () => {
  it('只拼接 text 块，忽略工具调用块', () => {
    const event = {
      type: 'assistant/message',
      seq: 1,
      data: {
        message: {
          content: [
            { type: 'text', text: '第一段' },
            { type: 'tool-call', name: 'bash' },
            { type: 'text', text: '第二段' },
          ],
        },
      },
    };
    expect(extractAssistantText(event)).toBe('第一段第二段');
  });

  it('结构不认识时返回空串而不抛错', () => {
    expect(extractAssistantText({ type: 'assistant/message', seq: 1, data: {} })).toBe('');
    expect(
      extractAssistantText({
        type: 'assistant/message',
        seq: 1,
        data: { message: { content: 'x' } },
      })
    ).toBe('');
    expect(extractAssistantText({ type: 'turn/start', seq: 1, data: {} })).toBe('');
  });
});

describe('TurnAccumulator', () => {
  const assistantEvent = (text: string) => ({
    type: 'assistant/message',
    seq: 1,
    data: { message: { content: [{ type: 'text', text }] } },
  });
  const turnEnd = (kind: string) => ({
    type: 'turn/end',
    seq: 2,
    data: { turn: 1, reason: { kind } },
  });

  it('中间空 assistant 消息不影响最终答案', () => {
    const acc = new TurnAccumulator('s');
    acc.observeStatus('running');
    acc.observe(assistantEvent('')); // 只有工具调用那一步
    acc.observe({ type: 'tool/call', seq: 3, data: { name: 'bash' } });
    acc.observe(assistantEvent('最终答案'));
    acc.observe(turnEnd('completed'));
    acc.observeStatus('idle');

    expect(acc.isSettled).toBe(true);
    expect(acc.result()).toMatchObject({ kind: 'completed', text: '最终答案' });
    expect(acc.toolsInvoked).toBe(1);
  });

  it('取最后一条非空 assistant 文本', () => {
    const acc = new TurnAccumulator('s');
    acc.observe(assistantEvent('先看看'));
    acc.observe(assistantEvent(''));
    acc.observe(assistantEvent('结论是这样'));
    acc.observe(turnEnd('completed'));
    expect(acc.finalText).toBe('结论是这样');
  });

  it('只有 status idle 没有 turn/end 时不算结束', () => {
    const acc = new TurnAccumulator('s');
    acc.observeStatus('running');
    acc.observe(assistantEvent('部分内容'));
    acc.observeStatus('idle');
    expect(acc.isSettled).toBe(false);
  });

  it('只有 turn/end 没有回到 idle 时不算结束', () => {
    const acc = new TurnAccumulator('s');
    acc.observeStatus('running');
    acc.observe(turnEnd('completed'));
    expect(acc.isSettled).toBe(false);
  });

  it('error 结果带上错误信息', () => {
    const acc = new TurnAccumulator('s');
    acc.observeStatus('running');
    acc.observe({
      type: 'turn/end',
      seq: 2,
      data: { turn: 1, reason: { kind: 'error', error: { message: '模型超时' } } },
    });
    acc.observeStatus('idle');
    expect(acc.result()).toMatchObject({ kind: 'error', errorMessage: '模型超时' });
  });

  it('max-tokens / aborted / blocked 被正确分类', () => {
    for (const kind of ['max-tokens', 'aborted', 'blocked'] as const) {
      const acc = new TurnAccumulator('s');
      acc.observeStatus('running');
      acc.observe(turnEnd(kind));
      acc.observeStatus('idle');
      expect(acc.result().kind).toBe(kind);
    }
  });

  it('未知 reason 归类为 error', () => {
    const acc = new TurnAccumulator('s');
    acc.observeStatus('running');
    acc.observe(turnEnd('something-new'));
    acc.observeStatus('idle');
    expect(acc.result().kind).toBe('error');
  });

  it('timeoutResult 使用已产出的部分内容', () => {
    const acc = new TurnAccumulator('s');
    acc.observe(assistantEvent('已完成一半'));
    const outcome = acc.timeoutResult();
    expect(outcome.kind).toBe('timeout');
    expect(outcome.text).toBe('已完成一半');
  });
});
