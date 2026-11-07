# ADR-009：会话常驻双 lane 与单轮执行绑定

状态：接受；验证分支 `verify/persistent-session-lanes`。替代 ADR-001 中按 Task 销毁 runtime 的生命周期；ADR-006 的同 Task 协作和状态写入权继续有效。

## 决策

群与单聊统一以 `(target.key, lane)` 拥有常驻 DSH 进程、根 session 与工作区。首次执行创建，正常结束或取消收敛后只释放单轮租约、监听和计时器，不空闲回收、不 LRU 驱逐。快慢 FIFO 独立推进，fastRuntimes/slowRuntimes 是执行并发，pool.maxRuntimes 是合计并发约束，驻留数量不受这些键限制。

Task 输入冻结 sessionEpoch，缺失按 1 读取。SessionActor 持久化独立 epoch 与 resetSinceTs；旧 sinceTs 是迁移后的初始回放边界。自动话题 generation 只改变当前输入提示和观察窗口，保留两条原生上下文。/new 与 /reset 先保存新 epoch，再取消全部未完成 Task，立即撤销旧双 lane，所属新执行等待旧资源关闭；其他会话不等待。

每轮独立 executionId 与租约，fd 3 先 bind 并确认，再 prompt；启动环境只含稳定 lane 身份。请求携带调用者完整绑定与独立 targetTaskId。插件每次绑定清空协作快照、水位及等待，复用已有根 agent。事件按 runtime generation/sessionId、prompt 回执 messageId、turn 与递增 seq 归属。匹配 turn 结束后，确认根及子代理静止，再 endExecution、扫描当前目录并释放占用。/stop、取消及超时请求 agent.cancel；沿用 shutdown timeout 等待收敛，失败仅销毁受影响 lane。

协作快照在当前 prompt 的 user/message 提交后才注入，绑定时不能唤醒旧根。prompt 回执的关联状态保存失败时，同样终止受影响执行并收尾，不留下未处理的异步拒绝。关闭等待调度执行和资源静止，不等待可能因保存失败而未结算的 Task.done；重启仍将未完成持久化记录中断。保存新 epoch 失败不撤销旧资源；保存成功后，即使个别取消状态保存失败，也撤销旧双 lane 并报告保存故障。

稳定工作区为 `<session>/lanes/<lane>`，当轮目录为其下 `tasks/<taskId>`，输入在 `<session>/tasks/<taskId>` 摄取一次。每轮同步规则，只扫描当轮 outbox。到期清理三处 Task 目录，保留 lane 和消息队列附件副本。有限历史仅在冷启动注入一次；故障重建使用新 generation/sessionId。服务重启中断未完成 Task，不续跑。

## 契约与验证

增加 RuntimePoolV2、执行绑定协议及受影响 Task V3 接口；V2 注入 runtimeFactory 必须提供完整执行绑定能力，不能仅返回旧 runtime 接口。保留 v1/v2 声明及 v1 兼容基线。TaskLifeCycleManager 唯一写执行状态，MessageQueue 唯一写投递状态。健康分别报告驻留、运行、排队。

离线注入 DSH、连接器、时钟覆盖复用、并发、FIFO、epoch 重置、迟到消息、取消收敛、故障、协作、冷回放、规则及文件清理，运行 npm run check。真实 DSH 与 WebSocket 是独立后续验证，不包含在离线结论中。

## 代价

进程与内存随启用会话数增长；本次明确不增加回收策略。原生上下文积累由 DSH 管理，取消不能收敛时允许丢失受影响 lane 的原生上下文，以有限历史重建。
