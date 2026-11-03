# ADR-002：核心日志与全链路追踪

状态：已实施并通过离线验收（2026-11-03）。此前简单 logger 为历史实现；以下为当前实施契约，验收以离线测试套件与 CI 为准。真实 WebSocket 为独立集成检查，本次未重跑。

Logger 升为核心模块，统一事件目录、身份保护、脱敏、去重、日志预算与 stderr JSONL 背压。沿用 Docker `20m × 5` 轮转，容器日志只保存身份、阶段、计数、长度、耗时与错误分类；正文、工具参数/结果及 stderr 内容通过 DSH 会话日志定位。

每个归一化输入和主动评估创建独立 trace。只读 TraceContext 显式贯通输入、Task、双 lane、执行、子代理、产物、队列与投递；阶段有独立 span 和 parentSpanId。队列独立持久化上下文，执行终态和投递终态分别记录。wait 票据保存触发上下文，取消关联命令与目标 Task。旧记录按 taskId 派生稳定 trace 并标记历史缺失，每次启动生成 instanceId。

唯一记录者：输入/主动评估记录准入、判定及短路；TaskLifeCycleManager 在持久化后记录状态转移；DshLaneRunner 记录执行、agent 汇总与产物；MessageQueue 记录入队、尝试、投递终态与通知关联；DshRuntime 记录进程/协议根因，RuntimePool 记录资源事件。根因生成 errorId，上层只引用。观察回调、指标与池转发不重复告警。

保留 debug/info/warn/error/child，增加类型化 event 和 withTrace；根 logger 提供 configure/snapshot/flush，子 logger 共享配置、预算和输出缓冲，时钟、ID 和传输可注入。记录保留 level/time/msg，新增 schemaVersion/event/component 与追踪字段，调用字段不可覆盖身份。

默认预算：单条 8 KiB、缓冲 1 MiB、每 execution 父子共享 100 条定向明细、重复诊断 60 秒聚合、目标 traceId/sessionKey 合计 8 个、诊断默认 10 分钟/最大 30 分钟、退出 flush 最多 2 秒。全局 debug 仍有预算，agent 明细必须命中目标。优先丢诊断，关键终态与首次根因不采样；持续输出故障以固定分类计数及健康告警暴露。每分钟与执行结束输出抑制统计。

独立 agent 观察器仅消费实时 session.event，不扫描继承历史。先核对执行身份，再按每 DSH 会话独立水位过滤重复/旧序号，子会话首序号可大于零。父结果累积不受子事件影响，父子关系和通知状态去重。最多 128 子会话、256 未配对工具、32 工具分类、8 错误示例，超额计数并标记不完整；执行结束释放缓存。非法/未知/迟到事件汇总。

观察器与业务结果、子代理等待分别维护状态；缓存超限不能取消执行或提前结算。输入短路事件由具体 stage 提供原因，媒体准备使用 Task/lane 的关联。兼容日志沿用 child 配置的组件，事件目录拥有类型化事件的组件；同一传输错误只计一次。

config/logging.yml 配置预算与诊断，兼容 logLevel/QQ_LOG_LEVEL，默认 info。SIGHUP 只应用日志配置，非法更新保留旧值，诊断按成功启用时间自动到期，重载不重置执行额度。/metrics 暴露固定分类的 emitted/deduplicated/aggregated/truncated/dropped/sinkFailures/queuedBytes 与诊断状态。序列化和传输失败不得向业务抛错或递归记录。

验收：注入 DSH、连接器、时钟和传输，验证并发双 lane/嵌套子代理、延迟投递、取消/wait/恢复、旧 runtime 与重复通知、十万事件与 stderr 洪峰、缓存/字节上限、背压/断流/异常序列化、无内容/密钥泄漏及 SIGHUP 无业务扰动。完整类型、lint、格式、离线测试、构建检查；真实 WebSocket 独立验收。
