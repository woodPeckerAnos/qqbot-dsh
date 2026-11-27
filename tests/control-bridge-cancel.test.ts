import { describe, expect, it } from 'vitest';
import type { DeepReadonly, TaskSnapshotV3 } from '@qqbot/contracts';
import { canCancel } from '../src/task/control-bridge-v3.js';

function task(options: {
  id?: string;
  sequence: number;
  source?: 'user' | 'proactive';
  senderId?: string;
  isAdmin?: boolean;
  cancelAccepted?: boolean;
  targetKey?: string;
}): DeepReadonly<TaskSnapshotV3> {
  return {
    taskId: options.id ?? `task-${options.sequence}`,
    creationSequence: options.sequence,
    cancelAccepted: options.cancelAccepted ?? false,
    input: {
      source: options.source ?? 'user',
      isAdmin: options.isAdmin ?? false,
      generation: 1,
      message: {
        target: { key: options.targetKey ?? 'group:1' },
        senderId: options.senderId ?? 'caller',
      },
    },
  } as unknown as DeepReadonly<TaskSnapshotV3>;
}

describe('取消权限', () => {
  it('普通成员可以停止本会话中尚未回复的主动任务', () => {
    const caller = task({ sequence: 10, senderId: 'member' });
    const proactive = task({
      sequence: 3,
      source: 'proactive',
      senderId: 'context',
    });
    expect(canCancel(caller, proactive)).toBe(true);
  });

  it('普通成员不能取消别人发起的用户任务', () => {
    const caller = task({ sequence: 10, senderId: 'member' });
    expect(canCancel(caller, task({ sequence: 3, senderId: 'other' }))).toBe(false);
  });

  it('普通成员可以取消自己之前发起的任务，管理员可以取消全部', () => {
    const caller = task({ sequence: 10, senderId: 'member' });
    expect(canCancel(caller, task({ sequence: 3, senderId: 'member' }))).toBe(true);
    const admin = task({ sequence: 10, senderId: 'admin', isAdmin: true });
    expect(canCancel(admin, task({ sequence: 3, senderId: 'other' }))).toBe(true);
  });

  it('不能取消未来任务、其他会话或已取消任务', () => {
    const caller = task({ sequence: 10, senderId: 'member' });
    expect(canCancel(caller, task({ sequence: 11, source: 'proactive' }))).toBe(false);
    expect(canCancel(caller, task({ sequence: 3, targetKey: 'group:2' }))).toBe(false);
    expect(canCancel(caller, task({ sequence: 3, cancelAccepted: true }))).toBe(false);
  });
});
