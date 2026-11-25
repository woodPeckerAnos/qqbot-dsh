import { describe, expect, it } from 'vitest';
import { parseSessionCommand } from '../src/ingress/index.js';

describe('顶层会话命令边界', () => {
  it('引用中的stop和转发正文均不会成为控制命令', () => {
    expect(
      parseSessionCommand('/stop', [
        { type: 'quote', author: '用户', parts: [{ type: 'text', text: '/stop' }] },
      ])
    ).toBeUndefined();
    expect(
      parseSessionCommand('/stop', [{ type: 'forward', parts: [{ type: 'text', text: '/stop' }] }])
    ).toBeUndefined();
    expect(
      parseSessionCommand('/stop', [
        { type: 'image', url: 'https://offline.invalid/a' },
        { type: 'text', text: '/stop' },
      ])
    ).toBeUndefined();
  });
  it('排除引用后仅完整顶层文本stop new reset可控制会话', () => {
    const quote = {
      type: 'quote' as const,
      author: '用户',
      parts: [{ type: 'text' as const, text: '/new' }],
    };
    expect(
      parseSessionCommand('被引用消息\n/stop', [quote, { type: 'text', text: ' /stop ' }])
    ).toBe('stop');
    expect(
      parseSessionCommand('/stop', [quote, { type: 'text', text: '请解释 /stop' }])
    ).toBeUndefined();
    expect(parseSessionCommand('/stop now')).toBeUndefined();
    expect(parseSessionCommand('<@!123> /reset')).toBe('new');
    expect(parseSessionCommand('/new')).toBe('new');
  });
});
