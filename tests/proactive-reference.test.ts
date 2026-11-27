import { describe, expect, it } from 'vitest';
import type { TaskInput } from '@qqbot/contracts';
import { proactiveCurrentInput } from '../src/task/prompt-preparer.js';

const proactive: NonNullable<TaskInput['proactive']> = {
  directive: '回答挂起问题',
  evidence: 'q:539205223@1795669718000',
  scene: 'scene-3',
  budgetScope: 'scope',
};

describe('主动 Task 的原引用', () => {
  it('当前输入带上被引用消息的发送者和正文，并禁止改答背景问题', () => {
    const input = proactiveCurrentInput(proactive, {
      senderId: '1948438218',
      username: '杰森',
      content: '@2605275029\n武侠小说为什么不火',
    });
    expect(input).toContain('原引用消息');
    expect(input).toContain('[杰森] @2605275029\n武侠小说为什么不火');
    expect(input).toContain('只回答这条原引用消息');
    expect(input).toContain('不要改答');
  });

  it('超长引用截断并显式标记，不让整段背景冒充当前问题', () => {
    const input = proactiveCurrentInput(proactive, {
      senderId: 'u1',
      username: '群友',
      content: '很长的引用'.repeat(200),
    });
    expect(input).toContain('[群友] ');
    expect(input).toContain('…');
    expect(input).not.toContain('很长的引用'.repeat(200));
  });
});
