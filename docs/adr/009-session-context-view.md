# ADR-009：只读 SessionContextView 与进度追问 guard

状态：接受；Phase 1。日期：2026-11-08。

## 决策

每个有效输入仍创建独立 Task，原子保存双 lane 初态，执行状态只由 TaskLifeCycleManager 写，投递状态只由 MessageQueue 写。新增 session 模块仅消费只读 Task、消息、对话、观察窗口和 generation 能力，不依赖这些模块的实现，不持有常驻 runtime。

默认 sessionContext 为 board-only、progressGuard=true、maxCharsPerTask=8000、maxTotalChars=12000、maxTasks=8、maxRecentMessages=0、recentTaskWindowMs=300000。mode=off 完全关闭新增行为；progressGuard=false 保留 View 和关联但恢复普通双 lane。配置和 Task 字段只增可选项，不升级持久化 schema。

Actor 在话题判定之后、创建 Task 之前同步识别。候选必须先准入、同会话、同 generation、同发送者且来源 user；排除失败、取消、接受取消、主动及 progressOnly Task。未完成任务或窗口内 completed 且有非空 reply 的任务可成为目标。使用准入顺序与注入时钟；判定期间 generation 改变则丢弃旧关联。引用正文必须完整且唯一匹配原问题或 reply，无法验证时保守正常执行。无引用纯进度必须只有一个候选；普通追问还须明确指代。40 字内整句白名单识别纯进度，媒体、链接、混合、重做和补充请求正常执行。

话题判定返回后先在仍有效的 generation 内验证目标，再决定话题边界。已验证的唯一追问归属原 generation，即使模型判为 unrelated；否则容易把“上个任务进度怎样”误切到新话题而使 guard 失效。此规则不绕过判定期间的 `/new`，mode=off 保留原话题判定语义。2026-11-08 首次 live L13 记录了该误判并触发此修正。

命中后设置 followUpOf/progressOnly，慢 lane 以 scheduler precomputed 直接 settle silent/no-increment，不入执行队列、不调用 runner 或产物整理；保存失败只重试结算。快 lane 提示必须实际调用 query_tasks(target)，纯进度仅汇报状态，普通关联用于理解当前请求；query_tasks 未提供 delivery，禁止声称送达。

普通慢 lane 在 runtime ready 后、prompt 派发前同步读取 View 并追加独立文本块，快 lane 保持冻结快照。自动选取先准入、同会话/generation、在 [当前 Task.createdAt, now] 终结的旧 Task；显式目标可更早或仍执行。主动 Task 结果进入 View 并标来源，取消且无 reply 排除。显式目标、同发送者、其他 Task 依次优先，组内终结时间倒序。

两 lane 保留各自状态及正文，慢正文优先分配每 Task 预算。delivery 只聚合原始正文记录，pending/sending 优先，结果未知为 unknown，任何失败阻止 sent，缺少可核对记录为 unknown；快答不是统一承接语，慢答也不保证完整。原问题至多 500 字，每 Task 正文及整个渲染块分别受预算约束。先裁正文再舍弃低优先级条目，保留完整状态、边界和准确省略统计。full 模式合并近期纯文本 Conversation/Window 并去重，仅在当前 generation 相同才读取；排除当前输入和 View 已覆盖回复，消息仅作背景。

所有背景复用不可信文本处理。当前输入是唯一执行项，旧任务继续交付 pending 结果，已覆盖的追问引用已有结果，截断内容不得推断覆盖完整。读取异常降级为空，仅记录身份、范围、数量、长度和截断元数据，不改变业务状态。

## 验证与后续

离线通过真实 Actor、scheduler、runner，注入 DSH、连接器和时钟验证进度查询、排队增量、初始化期间完成、取消/reset、失败与只补保存。独立 session 单元、消费者及 normal/edge/failure 冒烟进入契约门禁。L13 记录真实查询桥证据，联跑 L14/L18；离线、live 与 WebSocket 结果分开记录，并发前提不足标 inconclusive。发布前 live 三次严格回归。

query_tasks delivery、事件日志、常驻 runtime、DSH 压缩插件及 pinned/compressible 属后续阶段，Phase 1 不实现。原冻结上下文是历史方案的基线，当前仅快 lane 保持冻结，慢 lane 添加增量只读 View。
