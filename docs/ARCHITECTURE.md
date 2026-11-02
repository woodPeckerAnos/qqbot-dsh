# SessionActor 与双 lane

当前运行架构：接入、归一化、去重、命令、输入判定 → SessionActor → TaskLifeCycleManager → 两个独立 LaneScheduler → SessionOutputCoordinator → MessageQueue → 连接器。唯一入口 `src/main.ts` 已完成装配，验收记录见 [任务状态](TASK-STATUS.md)。

每个有效输入和主动请求恰好创建一个 Task，原子准入两个 lane。同 Session 每个 lane 串行，lane 之间独立推进。Actor 只协调短事务；长执行、媒体整理和上传不占 Actor 锁。上下文在输入时固定，话题切换只影响后续 generation。

快 lane 独立 runtime / session，thinking=false、reasoningEffort=off，仅可查询和取消 Task。慢 lane 自行判定长技能（包括深度推理）；普通问答正常返回 NO_REPLY；实际执行失败、超时和空结果必须产生失败产物。子代理前台等待，执行及子代理均终结后结算。

两个 lane 终结才结算 Task。取消优先，否则任一失败为 failed，其余 completed。执行完成不等待投递；投递失败不改写执行状态。已入队产物取消后仍发送。/stop 取消命令到达时有 lane 正执行的 Task；/new 取消全部未完成 Task 并重置上下文。

慢、延迟、主动和存活提醒引用输入时保存的原消息。引用目标与平台出口锚点独立。相同 Task 完全相同正文去重，附件单独保留。后来的话题或回答不撤销已授权的主动请求。

主动预算按 Task 预留一个单位，首次任意消息成功送达提交一次，静默或所有投递失败释放。范围绑定触发时的话题。队列先持久化再尝试发送；失败或超时不重试，只生成一次不递归失败通知。重启不恢复执行、不重发已尝试但结果未知的消息。

默认快 30 秒、慢 30 分钟（排队不计时），runtime 总上限 8、各 lane 4；Session 未完成 Task 32、全局 128，终态保留 7 天。待发消息及文件独立保存。快送达且慢开始后等 5 分钟，慢仍执行才发最多一次存活提醒；无即时合法出口放弃。

历史实现：`docs/DESIGN.md` 记录此前单轮执行、后台推送和周期进度，涉及这些路径的内容由本文件和 ADR-001 取代。
