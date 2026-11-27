import { describe, expect, it, vi } from 'vitest';
import type { MessageContext } from '@qqbot/contracts';
import { createNullLogger, createPipelineStats } from '../src/observability/index.js';
import { SessionCommandRouter } from '../src/pipeline/ingress/session-command.js';

function context(options: {
  content: string;
  senderId?: string;
  isAdmin?: boolean;
}): MessageContext & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    isAdmin: options.isAdmin ?? false,
    message: {
      kind: 'group-at-message',
      target: { platform: 'onebot', kind: 'group', id: '1', key: 'onebot:group:1' },
      senderId: options.senderId ?? 'member',
      content: options.content,
      msgId: 'm1',
      eventId: 'm1',
      ts: 1,
      raw: {},
    },
    trace: undefined,
    logger: createNullLogger(),
    responder: {
      error: async (text: string) => {
        sent.push(text);
      },
    },
  } as unknown as MessageContext & { sent: string[] };
}

describe('会话控制命令范围', () => {
  it('普通成员 /stop 只带自己的 sender 过滤，管理员 /stop 取消整个会话', async () => {
    const actor = { stop: vi.fn(() => 1), reset: vi.fn(() => 0) };
    const stage = new SessionCommandRouter({ actor, stats: createPipelineStats() }).stage();

    const member = context({ content: '/stop', senderId: 'member' });
    await stage(member, async () => {
      throw new Error('不应进入下一 stage');
    });
    expect(actor.stop).toHaveBeenLastCalledWith('onebot:group:1', undefined, 'member');

    const admin = context({ content: '/stop', senderId: 'admin', isAdmin: true });
    await stage(admin, async () => {
      throw new Error('不应进入下一 stage');
    });
    expect(actor.stop).toHaveBeenLastCalledWith('onebot:group:1', undefined);
    expect(member.sent[0]).toContain('你发起的任务和本会话的主动任务');
  });

  it('/new 仍只允许管理员', async () => {
    const actor = { stop: vi.fn(() => 0), reset: vi.fn(() => 0) };
    const stage = new SessionCommandRouter({ actor, stats: createPipelineStats() }).stage();
    const member = context({ content: '/new' });
    await stage(member, async () => {
      throw new Error('不应进入下一 stage');
    });
    expect(actor.reset).not.toHaveBeenCalled();
    expect(member.sent[0]).toContain('无权限');

    const admin = context({ content: '/new', senderId: 'admin', isAdmin: true });
    await stage(admin, async () => {
      throw new Error('不应进入下一 stage');
    });
    expect(actor.reset).toHaveBeenCalledWith('onebot:group:1', undefined);
  });
});
