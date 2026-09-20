/**
 * DSH 协议客户端与 turn 归并单测（全离线，不启动任何子进程）。
 *
 * 这一层最容易出的 bug 是"帧错位导致请求永久挂起"，所以重点测：
 *   - 粘包/拆包（一次 data 里多个帧、一个帧跨多次 data）；
 *   - stdout 污染必须被显式报错，而不是静默丢弃；
 *   - 并发请求按 id 正确配对。
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  HarnessSdkClient,
  JsonRpcResponseError,
  ProtocolViolationError,
} from '../src/dsh/protocol.js';
import { extractAssistantText, TurnAccumulator } from '../src/dsh/turns.js';

/** 建一个客户端 + 可写的"服务端"流。 */
function makeClient() {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  const written: string[] = [];
  fromClient.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));

  const violations: ProtocolViolationError[] = [];
  const client = new HarnessSdkClient({ input: toClient, output: fromClient, requestTimeoutMs: 1_000 });
  client.on('violation', (error) => violations.push(error));

  const reply = (frame: unknown) => toClient.write(`${JSON.stringify(frame)}\n`);
  const replyRaw = (raw: string) => toClient.write(raw);

  return { client, reply, replyRaw, written, violations, toClient, fromClient };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

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
    const { client, replyRaw, toClient } = makeClient();
    const pending = client.initialize({ cwd: '/w', provider: 'p', model: 'm' });
    await settle();

    toClient.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 's', status: 'running' } })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'n', version: 'v' } } })}\n`,
    );

    await expect(pending).resolves.toEqual({ serverInfo: { name: 'n', version: 'v' } });
    client.close();
  });

  it('处理拆包：一个帧跨多次写入', async () => {
    const { client, toClient } = makeClient();
    const pending = client.initialize({ cwd: '/w', provider: 'p', model: 'm' });
    await settle();

    const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'n', version: 'v' } } });
    toClient.write(frame.slice(0, 10));
    toClient.write(frame.slice(10));
    toClient.write('\n');

    await expect(pending).resolves.toEqual({ serverInfo: { name: 'n', version: 'v' } });
    client.close();
  });

  it('通知被分发到对应事件', async () => {
    const { client, replyRaw, toClient } = makeClient();
    const statusHandler = vi.fn();
    const eventHandler = vi.fn();
    client.on('session.status', statusHandler);
    client.on('session.event', eventHandler);

    toClient.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 's', status: 'idle' } })}\n`,
    );
    toClient.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session.event',
        params: { sessionId: 's', event: { type: 'turn/start', seq: 1, data: { turn: 1 } } },
      })}\n`,
    );

    expect(statusHandler).toHaveBeenCalledWith({ sessionId: 's', status: 'idle' });
    expect(eventHandler).toHaveBeenCalledWith({
      sessionId: 's',
      event: { type: 'turn/start', seq: 1, data: { turn: 1 } },
    });
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
    const { client } = makeClient();
    await expect(
      client.initialize({ cwd: '/w', provider: 'p', model: 'm' }, { timeoutMs: 30 }),
    ).rejects.toThrow(/超时/);
    expect(client.pendingCount).toBe(0);
    client.close();
  });

  it('服务端若发来请求，回 -32601 而不是挂等', async () => {
    const { client, toClient, written } = makeClient();
    toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'some/request', params: {} })}\n`);
    await settle();

    const reply = written.map((line) => JSON.parse(line)).find((f) => f.id === 99);
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
    await expect(client.prompt({ sessionId: 's', contentBlocks: [] })).rejects.toThrow(/传输已关闭/);
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
    expect(extractAssistantText({ type: 'assistant/message', seq: 1, data: { message: { content: 'x' } } })).toBe('');
    expect(extractAssistantText({ type: 'turn/start', seq: 1, data: {} })).toBe('');
  });
});

describe('TurnAccumulator', () => {
  const assistantEvent = (text: string) => ({
    type: 'assistant/message',
    seq: 1,
    data: { message: { content: [{ type: 'text', text }] } },
  });
  const turnEnd = (kind: string) => ({ type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind } } });

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
    acc.observe({ type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'error', error: { message: '模型超时' } } } });
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
