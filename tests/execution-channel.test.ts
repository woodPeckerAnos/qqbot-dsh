import { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionChannel } from '../src/dsh/execution-channel.js';
import { createNullLogger } from '../src/observability/index.js';
import type { ExecutionBinding } from '@qqbot/contracts';

function fixture() {
  const frames: Record<string, unknown>[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      const packet = JSON.parse(String(chunk)) as Record<string, unknown>;
      frames.push(packet);
      if (packet.type === 'execution')
        queueMicrotask(() =>
          stream.push(
            JSON.stringify({
              type: 'execution-response',
              id: packet.id,
              value: { binding: packet.binding, idle: true },
            }) + '\n'
          )
        );
      done();
    },
  });
  const close = vi.fn();
  const channel = new ExecutionChannel(
    stream,
    {
      bin: 'mock',
      profilePatch: 'mock',
      cwd: '/tmp',
      dshHome: '/tmp',
      provider: 'mock',
      model: 'mock',
      startTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      env: { QQBOT_TASK_CHANNEL: '1' },
      logger: createNullLogger(),
    },
    close
  );
  const send = (packet: unknown) => {
    stream.push(JSON.stringify(packet) + '\n');
  };
  return { channel, stream, frames, send, close };
}
const a: ExecutionBinding = {
  taskId: 'a',
  executionId: '1',
  runtimeGeneration: 'g',
  sessionId: 'root',
  sessionEpoch: 1,
};
describe('fd 3 单轮绑定传输', () => {
  it('先绑定确认，控制 caller/target 分开；每个旧身份字段均被拒绝', async () => {
    const f = fixture(),
      control = vi.fn(() => ({ accepted: true }));
    try {
      await f.channel.bind(a, { control });
      f.send({ ...a, id: 'valid', action: 'cancel', targetTaskId: 'older' });
      await vi.waitFor(() => {
        expect(control).toHaveBeenCalledTimes(1);
      });
      expect(control).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'a', targetTaskId: 'older' })
      );
      await f.channel.quiesce(a);
      await f.channel.unbind(a);
      const b = { ...a, taskId: 'b', executionId: '2', sessionEpoch: 2 };
      await f.channel.bind(b, { control });
      await expect(f.channel.cancel(a)).rejects.toThrow('失效');
      for (const key of Object.keys(b))
        f.send({ ...b, [key]: 'stale', id: `old-${key}`, action: 'query' });
      await vi.waitFor(() => {
        expect(
          f.frames.filter((packet) => typeof packet.id === 'string' && packet.id.startsWith('old-'))
        ).toHaveLength(5);
      });
      expect(control).toHaveBeenCalledTimes(1);
      expect(
        f.frames
          .filter((packet) => typeof packet.id === 'string' && packet.id.startsWith('old-'))
          .every((packet) => !!packet.error)
      ).toBe(true);
      await f.channel.unbind(b);
    } finally {
      f.channel.dispose();
    }
  });
  it('取消和通道关闭释放协作等待，新轮不复用旧等待', async () => {
    const f = fixture();
    let aborted = false;
    try {
      await f.channel.bind(a, {
        control: () => undefined,
        cooperation: (_request, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(new Error('cancelled'));
              },
              { once: true }
            );
          }),
      });
      f.send({ ...a, id: 'wait', action: 'cooperation-wait' });
      await new Promise((resolve) => setImmediate(resolve));
      await f.channel.cancel(a);
      expect(aborted).toBe(true);
      await f.channel.unbind(a);
      await f.channel.bind({ ...a, taskId: 'b', executionId: '2' }, { control: () => undefined });
      f.channel.dispose();
      await vi.waitFor(() => {
        expect(f.close).toHaveBeenCalledTimes(1);
      });
    } finally {
      f.channel.dispose();
    }
  });
});
