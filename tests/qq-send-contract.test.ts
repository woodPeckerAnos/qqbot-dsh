import { describe, expect, it, vi } from 'vitest';
import { QqApi } from '../src/adapters/qq-official/api.js';
import type { TokenManager } from '../src/adapters/qq-official/token.js';
import { renderMessage } from '../src/adapters/qq-official/render.js';
import { createNullLogger } from '../src/logger.js';

describe('QQ 单次发送契约', () => {
  it.each([401, 400])('HTTP %s 不重发；鉴权刷新只服务后续消息', async (status) => {
    const refresh = vi.fn(async () => 'new-token');
    const tokens = { get: async () => 'token', forceRefresh: refresh } as unknown as TokenManager;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: status === 400 ? 40054007 : 401, message: 'failed' }), {
          status,
        })
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const api = new QqApi({
      apiBase: 'https://example.invalid',
      tokenManager: tokens,
      fetchImpl,
      logger: createNullLogger(),
    });
    await expect(
      api.sendGroupMessage('group', {
        content: '旧消息',
        msg_type: 0,
        msg_seq: 1,
        msg_id: 'anchor',
      })
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    await api.sendGroupMessage('group', {
      content: '新消息',
      msg_type: 0,
      msg_seq: 2,
      msg_id: 'anchor',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('被动发送锚点和原消息引用分别渲染', () => {
    const body = renderMessage('延迟结果', {
      msgType: 0,
      msgId: 'new-anchor',
      msgSeq: 3,
      quoteMessageId: 'original-message',
    });
    expect(body.msg_id).toBe('new-anchor');
    expect(body.message_reference?.message_id).toBe('original-message');
  });
});
