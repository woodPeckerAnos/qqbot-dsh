# 模块契约

所有快照只读；错误不允许静默吞掉已执行失败；取消和回收均绑定具体执行或租约。以下接口与当前导出同步。

| 模块 | 职责、公共接口与所有权 | 顺序、错误、取消与释放 | 验收 |
| --- | --- | --- | --- |
| Task | TaskInput、TaskSnapshot、TaskHandle `{taskId,done}`、LaneEvent、LaneResult、ReplyCandidate、DeliveryResult；定义值类型 | done 仅在双 lane 终结时完成；NO_REPLY 是成功 | 恰好一个 Task、双终结 |
| TaskLifeCycleManager | create/get/list/handle/start/bindExecution/matches/endExecution/finish/cancel/recover/prune/destroy/onChange；唯一任务状态写入者 | 原子准入；取消优先、失败次之；已终结不取消；7 天清理 | 状态、权限、限额、恢复 |
| SessionActor | submit/cancel/cancelExecution/stop/reset/snapshot/close；持有上下文 generation 和输入绑定 | 短事务提交两队列；新输入不取消旧任务；不等待执行或发送 | 慢任务期间快可回复 |
| LaneScheduler | enqueue/cancel/close/snapshot；拥有独立 Session FIFO 和 lane 额度 | 排队不计超时；取消排队及执行；finally 释放额度 | 同 lane 串行、跨 lane 独立 |
| PromptPreparer | capture/judge/workspace/prepare/release/removeWorkspace；固定窗口与回放，复用媒体与文件解析 | 每 Task 摄取一次；文件限定 Task 工作区；解析失败显式降级 | 固定上下文、摄取复用 |
| DshLaneRunner | run；租约、执行注册、累积器、超时与子代理等待 | 先注册后 prompt；唯一 sessionId 隔离旧事件；终止具体租约，finally 回收 | thinking、工具、迟到事件、超时 |
| TaskControlBridge | bind → query/cancel；工具身份绑定发起输入 | 不接受模型提供 Session/角色；普通成员本人旧任务、管理员本 Session；终态返回结果 | 跨 Session、跨身份拒绝 |
| TaskBudget | reserve/settle/finish/get/list；拥有按 Task 的预留和提交记录 | 首次成功提交一次；静默及全部失败释放；绑定旧范围 | 多消息只扣一次、旧范围 |
| SessionOutputCoordinator | accept/reconcile/forget/close；拥有正文精确去重和一次提醒 | 规范正文后静默验证；附件独立；快送达且慢开始 5 分钟提醒；失败不重试 | 引用、去重、提醒、快出口 |
| MessageQueue / Egress | enqueue/observe/canSend/messages/taskDelivery/onDelivery/wake/snapshot/close；唯一投递状态写入者 | 先持久化，合法出口才尝试；失败和超时终态，不重发；通知一次且不递归；附件上传不阻塞正文 | 失败一次、恢复、不串附件 |
| TaskStore | load/save；持久化快照和预算、队列 | 不决定状态；原子写；恢复由管理器决定中断失败 | 未完成执行不重跑 |
| ProactiveTaskAdapter | submit/delivered/settled；冻结触发依据、引用、预算范围和实际发言回调 | 触发时授权；不在发送前检查过时；队列首次成功记录发言一次 | 翻篇仍送、预算一次 |
| RuntimePool | acquireLease/release/drop/disposeAll；持有具体租约 | 创建串行化，硬上限；无闲置时等待；按租约释放回收 | 总上限、并发创建、旧租约 |
| Connector | reply/proactive；平台请求、原生引用和发送约束 | 单次发送；鉴权/长度失败不重试，刷新只服务后续消息 | OneBot reply / QQ message_reference |

Task 终态独立于消息。队列及必要附件不受 Task 终态清理影响。重启发送中消息终态失败并生成一次失败通知，所有未完成 lane 中断失败。对话记录和观察窗口保存回复连同归属引用。

边界补充：Task 保存单调创建序号，取消权限按序号判定“旧任务”，不依赖毫秒时间戳。执行已结束、正在整理产物时不触发存活提醒，也不属于 `/stop` 的正在执行集合。终态到期后清理 Task 工作区和协调器缓存；消息队列拥有的附件副本独立保留。自定义基础 profile 仍叠加仓库内置 lane patch；运行时初始化失败必须释放子进程。观察者报错记录日志，不阻断状态提交与 done 结算。

SessionActor 持久化上下文 generation 与回放边界，`/new` 和自动换话题在重启后仍生效。主动提交在进入 Actor 等待之前固定触发窗口及 generation，不能因另一输入正在判定而改用后来话题的上下文。

旧进度配置只保留数值解析，不参与平台配额与执行时限约束。恢复时释放“已预留但 Task 未持久化”的孤立预算；已持久化消息继续独立结算。Task 控制通道在成功、超时、取消和关闭时移除请求监听器。

配置的两 lane 路由与基础模型路由遵守相同启动校验；启用 models 配置后路由必须已声明、凭证必须存在。OneBot 附件编码后再次检查投递取消，避免超时后才派发上传。
