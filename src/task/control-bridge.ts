/**
 * 把 Task 管理工具绑定到原始输入身份；模型只能传 taskId，不能指定 Session 或角色。
 * 查询限本 Session，取消还要求目标先于调用者创建；普通成员限本人旧 Task。
 * 接受取消后调用 Actor 的执行取消接缝，已入队消息保留。
 */
import type { TaskLifeCycleManager } from './lifecycle.js';
import type { TaskSnapshot } from './types.js';
export class TaskControlBridge {
  constructor(private readonly manager: TaskLifeCycleManager, private readonly cancelTask: (id: string) => void) {}
  /** 闭包捕获可信快照，后续输入或模型参数不能改变调用者权限。 */
  bind(caller: Readonly<TaskSnapshot>) {
    const key = caller.input.message.target.key;
    return {
      query: (taskId?: string) => {
        const tasks = taskId ? [this.manager.get(taskId)].filter((t): t is Readonly<TaskSnapshot> => !!t) : this.manager.list(key);
        return tasks.filter(t => t.input.message.target.key === key).map(t => ({ taskId: t.taskId, status: t.status, senderId: t.input.message.senderId, createdAt: t.createdAt, lanes: t.lanes }));
      },
      cancel: (taskId: string) => {
        const task = this.manager.get(taskId);
        if (!task || task.input.message.target.key !== key || task.creationSequence >= caller.creationSequence || (!caller.input.isAdmin && task.input.message.senderId !== caller.input.message.senderId)) {
          return { accepted: false, reason: '无权限或任务不存在' };
        }
        const result = this.manager.cancel(taskId);
        if (result.accepted) this.cancelTask(taskId);
        return { ...result, reason: result.accepted ? '已取消未完成执行；已入队结果继续投递' : '做都做完了', results: result.task?.lanes };
      },
    };
  }
}
