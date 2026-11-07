import type { DeepReadonly } from '../readonly.js';
/**
 * 把 Task 管理工具绑定到原始输入身份；模型只能传 taskId，不能指定 Session 或角色。
 * 查询限本 Session，取消还要求目标先于调用者创建；普通成员限本人旧 Task。
 * 接受取消后调用 Actor 的执行取消接缝，已入队消息保留。
 */
/**
 * 把 Task 管理工具绑定到原始输入身份；模型只能传 taskId，不能指定 Session 或角色。
 * 查询限本 Session，取消还要求目标先于调用者创建；普通成员限本人旧 Task。
 * 接受取消后调用 Actor 的执行取消接缝，已入队消息保留。
 */
import type { TaskLifeCycleManagerV2 } from './lifecycle-v2.js';
import type { TaskSnapshotV2 } from './types-v2.js';
export interface TaskControlBridgeV2 {
  /** 闭包捕获可信快照，后续输入或模型参数不能改变调用者权限。 */
  bind(caller: DeepReadonly<TaskSnapshotV2>): {
    query: (taskId?: string) => {
      taskId: string;
      status: import('./types-v2.js').TaskStatus;
      senderId: string;
      createdAt: number;
      lanes: Record<import('./types-v2.js').Lane, import('./types-v2.js').LaneSnapshotV2>;
    }[];
    cancel: (taskId: string) =>
      | {
          accepted: boolean;
          reason: string;
        }
      | {
          reason: string;
          results:
            | Record<import('./types-v2.js').Lane, import('./types-v2.js').LaneSnapshotV2>
            | undefined;
          accepted: boolean;
          task?: DeepReadonly<TaskSnapshotV2>;
        };
  };
}
export type createTaskControlBridgeFactoryV2 = (
  manager: TaskLifeCycleManagerV2,
  cancelTask: (id: string) => void
) => TaskControlBridgeV2;
