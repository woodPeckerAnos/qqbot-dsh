export declare const modules: readonly [{
    readonly id: "config";
    readonly title: "配置";
    readonly version: "1.0.0";
    readonly owner: "项目维护者";
    readonly entry: "src/config/index.ts";
    readonly files: readonly ["src/config-error.ts", "src/config-file.ts", "src/config-includes.ts", "src/config.ts", "src/config/index.ts", "src/dsh/model-config.ts"];
    readonly dependencies: readonly ["offpeak", "observability", "connectors", "content", "proactive", "store"];
    readonly capabilities: readonly ["node:fs", "node:path", "yaml"];
    readonly responsibility: "解析合并、校验、模型路由与 patch；不决定执行或发送";
    readonly invariants: readonly ["有效配置在启动期固定，密钥只来自 env"];
    readonly preconditions: "输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力";
    readonly postconditions: "成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果";
    readonly errors: "格式或语义错误显式 ConfigError，禁止用默认值隐藏非法配置";
    readonly concurrency: "同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算";
    readonly freshness: "启动期版本，reload 仅已有日志配置";
    readonly compatibility: "v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容";
    readonly examples: readonly [{
        readonly id: "config.normal";
        readonly kind: "normal";
    }, {
        readonly id: "config.edge";
        readonly kind: "edge";
    }, {
        readonly id: "config.failure";
        readonly kind: "failure";
    }];
}, {
    readonly id: "content";
    readonly title: "内容";
    readonly version: "1.0.0";
    readonly owner: "项目维护者";
    readonly entry: "src/content/index.ts";
    readonly files: readonly ["src/content/index.ts", "src/core/content.ts", "src/pipeline/egress/chunk.ts", "src/pipeline/markdown.ts"];
    readonly dependencies: readonly [];
    readonly capabilities: readonly [];
    readonly responsibility: "片段扁平化、文本、Markdown、分段等纯计算；不做 I/O";
    readonly invariants: readonly ["同一片段始终产生同一规范文本，分段不超上限"];
    readonly preconditions: "输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力";
    readonly postconditions: "成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果";
    readonly errors: "非法边界参数拒绝，空输入是合法边界";
    readonly concurrency: "同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算";
    readonly freshness: "纯值不适用 TTL：结果只依赖输入";
    readonly compatibility: "v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容";
    readonly examples: readonly [{
        readonly id: "content.normal";
        readonly kind: "normal";
    }, {
        readonly id: "content.edge";
        readonly kind: "edge";
    }, {
        readonly id: "content.failure";
        readonly kind: "failure";
    }];
}, {
    readonly id: "connectors";
    readonly title: "连接器";
    readonly version: "1.0.0";
    readonly owner: "项目维护者";
    readonly entry: "src/connectors/index.ts";
    readonly files: readonly ["src/adapters/onebot/connector.ts", "src/adapters/onebot/normalize.ts", "src/adapters/onebot/types.ts", "src/adapters/qq-official/api.ts", "src/adapters/qq-official/connector.ts", "src/adapters/qq-official/content.ts", "src/adapters/qq-official/gateway.ts", "src/adapters/qq-official/render.ts", "src/adapters/qq-official/token.ts", "src/adapters/qq-official/types.ts", "src/connectors/index.ts", "src/core/connector.ts"];
    readonly dependencies: readonly ["content", "observability"];
    readonly capabilities: readonly ["node:crypto", "node:fs/promises", "node:http", "node:stream", "node:events", "ws", "fetch", "WebSocket"];
    readonly responsibility: "平台归一化、鉴权、收发、出口与生命周期；不编排 Task";
    readonly invariants: readonly ["消息与会话命名空间隔离，平台发送单次且引用保留原类型"];
    readonly preconditions: "输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力";
    readonly postconditions: "成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果";
    readonly errors: "媒体获取失败降级；发送已尝试不重试，超时结果不确定";
    readonly concurrency: "同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算";
    readonly freshness: "ts 为平台来源时间，QQ 被动窗口和 token TTL 保留";
    readonly compatibility: "v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容";
    readonly examples: readonly [{
        readonly id: "connectors.normal";
        readonly kind: "normal";
    }, {
        readonly id: "connectors.edge";
        readonly kind: "edge";
    }, {
        readonly id: "connectors.failure";
        readonly kind: "failure";
    }];
}, {
    readonly id: "store";
    readonly title: "存储";
    readonly version: "1.0.0";
    readonly owner: "项目维护者";
    readonly entry: "src/store/index.ts";
    readonly files: readonly ["src/store/conversations.ts", "src/store/index.ts", "src/store/paths.ts", "src/store/personas.ts", "src/store/seen.ts", "src/store/sessions.ts", "src/store/tasks.ts", "src/store/window.ts"];
    readonly dependencies: readonly ["content", "observability"];
    readonly capabilities: readonly ["node:fs", "node:path", "node:crypto"];
    readonly responsibility: "对话、去重、人设、观察窗口及 JSON 持久化；不决定任务恢复";
    readonly invariants: readonly ["读取快照隔离，来源时间高水位不回退，状态所有者唯一"];
    readonly preconditions: "输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力";
    readonly postconditions: "成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果";
    readonly errors: "读取失败与缺失分离，候选保存失败不提交 generation/选择";
    readonly concurrency: "同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算";
    readonly freshness: "窗口依来源 ts 高水位裁剪，read 的 now 再检查 TTL";
    readonly compatibility: "v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容";
    readonly examples: readonly [{
        readonly id: "store.normal";
        readonly kind: "normal";
    }, {
        readonly id: "store.edge";
        readonly kind: "edge";
    }, {
        readonly id: "store.failure";
        readonly kind: "failure";
    }];
}, {
    readonly id: "media";
    readonly title: "媒体";
    readonly version: "1.0.0";
    readonly owner: "项目维护者";
    readonly entry: "src/media/index.ts";
    readonly files: readonly ["src/dsh/document.ts", "src/dsh/files.ts", "src/dsh/image.ts", "src/dsh/media.ts", "src/media/index.ts", "src/media/fetch-result.ts", "src/pipeline/egress/outbox.ts", "src/pipeline/egress/zip.ts", "src/store/inbox.ts"];
    readonly dependencies: readonly ["content", "connectors", "store", "observability"];
    readonly capabilities: readonly ["node:fs/promises", "node:child_process", "node:path", "node:zlib", "sharp", "fetch"];
    readonly responsibility: "下载、图片、文件抽取、输入保存、附件保存与回收；不写执行状态";
    readonly invariants: readonly ["媒体按 Task 隔离，realpath 限定目录，队列副本独立保留"];
    readonly preconditions: "输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力";
    readonly postconditions: "成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果";
    readonly errors: "各媒体可独立降级，返回 notes/typed failure；禁止使整条输入丢失";
    readonly concurrency: "同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算";
    readonly freshness: "媒体来源是触发输入，下载预算和截止时间沿用既有参数";
    readonly compatibility: "v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容";
    readonly examples: readonly [{
        readonly id: "media.normal";
        readonly kind: "normal";
    }, {
        readonly id: "media.edge";
        readonly kind: "edge";
    }, {
        readonly id: "media.failure";
        readonly kind: "failure";
    }];
}, {
    readonly id: "runtime";
    readonly title: "Runtime";
    readonly version: "1.0.0";
    readonly owner: "项目维护者";
    readonly entry: "src/runtime/index.ts";
    readonly files: readonly ["src/dsh/agent-trace.ts", "src/dsh/pool.ts", "src/dsh/process.ts", "src/dsh/protocol.ts", "src/dsh/turns.ts", "src/runtime/index.ts"];
    readonly dependencies: readonly ["observability"];
    readonly capabilities: readonly ["node:child_process", "node:events", "node:stream", "node:crypto", "@deepseek-ai/dsh-llm-retry", "@deepseek-ai/dsh-session"];
    readonly responsibility: "DSH 协议、进程、只读租约池、累积与事件观察；不投递平台消息";
    readonly invariants: readonly ["具体租约身份独占，busy/子代理只有池写，旧通知隔离"];
    readonly preconditions: "输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力";
    readonly postconditions: "成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果";
    readonly errors: "协议/进程失败保留根因，初始化失败回收，租约取消不能命中新身份";
    readonly concurrency: "同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算";
    readonly freshness: "generation/sessionId/dshSeq 身份水位，idle/timeout 使用注入时钟";
    readonly compatibility: "v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容";
    readonly examples: readonly [{
        readonly id: "runtime.normal";
        readonly kind: "normal";
    }, {
        readonly id: "runtime.edge";
        readonly kind: "edge";
    }, {
        readonly id: "runtime.failure";
        readonly kind: "failure";
    }];
}, {
    readonly id: "task";
    readonly title: "Task";
    readonly version: "1.0.0";
    readonly owner: "项目维护者";
    readonly entry: "src/task/index.ts";
    readonly files: readonly ["src/task/budget.ts", "src/task/clock.ts", "src/task/control-bridge.ts", "src/task/dsh-lane-runner.ts", "src/task/index.ts", "src/task/lane-scheduler.ts", "src/task/lifecycle.ts", "src/task/proactive-adapter.ts", "src/task/prompt-preparer.ts", "src/task/session-actor.ts", "src/task/system.ts", "src/task/types.ts"];
    readonly dependencies: readonly ["runtime", "media", "store", "delivery", "observability", "content"];
    readonly capabilities: readonly ["node:crypto", "node:fs", "node:fs/promises", "node:path", "node:url"];
    readonly responsibility: "Actor、执行状态、lane、预算、控制、输入准备及装配；不写投递状态";
    readonly invariants: readonly ["每输入一个 Task，双 lane 终结，短事务无整轮锁，预算守恒"];
    readonly preconditions: "输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力";
    readonly postconditions: "成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果";
    readonly errors: "准入/持久化失败不留下可调度半成品；失败与正常 silent 分开；预算保存失败由维护循环只补结算，未创建 Task 的预留释放";
    readonly concurrency: "同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算";
    readonly freshness: "输入时固定 generation/窗口，排队不计执行时限，终态保留 7 天";
    readonly compatibility: "v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容";
    readonly examples: readonly [{
        readonly id: "task.normal";
        readonly kind: "normal";
    }, {
        readonly id: "task.edge";
        readonly kind: "edge";
    }, {
        readonly id: "task.failure";
        readonly kind: "failure";
    }];
}, {
    readonly id: "delivery";
    readonly title: "投递";
    readonly version: "1.0.0";
    readonly owner: "项目维护者";
    readonly entry: "src/delivery/index.ts";
    readonly files: readonly ["src/delivery/index.ts", "src/pipeline/egress/responder.ts", "src/task/message-queue.ts", "src/task/output-coordinator.ts"];
    readonly dependencies: readonly ["content", "media", "observability"];
    readonly capabilities: readonly ["node:crypto", "node:fs/promises", "node:path"];
    readonly responsibility: "队列、产物、正文去重、原引用与提醒；不写执行状态";
    readonly invariants: readonly ["MessageQueue 唯一写者，发送前持久化，失败通知一次，附件独立"];
    readonly preconditions: "输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力";
    readonly postconditions: "成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果";
    readonly errors: "保存 sending 失败不发；平台后保存失败保持 unknown；发送失败为 UPSTREAM_FAILED、超时为 TIMEOUT、重启未知为 UNKNOWN_OUTCOME，均禁止重发";
    readonly concurrency: "同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算";
    readonly freshness: "原引用与当前合法出口分离，提醒沿用 5 分钟固定上限";
    readonly compatibility: "v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容";
    readonly examples: readonly [{
        readonly id: "delivery.normal";
        readonly kind: "normal";
    }, {
        readonly id: "delivery.edge";
        readonly kind: "edge";
    }, {
        readonly id: "delivery.failure";
        readonly kind: "failure";
    }];
}, {
    readonly id: "ingress";
    readonly title: "Ingress";
    readonly version: "1.0.0";
    readonly owner: "项目维护者";
    readonly entry: "src/ingress/index.ts";
    readonly files: readonly ["src/ingress/index.ts", "src/pipeline/hints.ts", "src/pipeline/ingress/dedupe.ts", "src/pipeline/ingress/offpeak-command.ts", "src/pipeline/ingress/offpeak-gate.ts", "src/pipeline/ingress/persona-command.ts", "src/pipeline/ingress/record.ts", "src/pipeline/ingress/session-command.ts", "src/pipeline/ingress/types.ts", "src/pipeline/ingress/welcome.ts", "src/pipeline/orchestrator.ts", "src/pipeline/topic-judge.ts"];
    readonly dependencies: readonly ["task", "delivery", "store", "offpeak", "observability", "content"];
    readonly capabilities: readonly ["fetch"];
    readonly responsibility: "输入管线、命令路由、话题判定；末端只提交 Actor";
    readonly invariants: readonly ["去重→命令→闸→记录→准入，旁听不入完整管线"];
    readonly preconditions: "输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力";
    readonly postconditions: "成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果";
    readonly errors: "话题失败显式错误并保守回退 related=true，不吞用户输入";
    readonly concurrency: "同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算";
    readonly freshness: "来源 ts 保留，话题判断有既有 timeout，配置禁用与失败分离";
    readonly compatibility: "v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容";
    readonly examples: readonly [{
        readonly id: "ingress.normal";
        readonly kind: "normal";
    }, {
        readonly id: "ingress.edge";
        readonly kind: "edge";
    }, {
        readonly id: "ingress.failure";
        readonly kind: "failure";
    }];
}, {
    readonly id: "proactive";
    readonly title: "主动介入";
    readonly version: "1.0.0";
    readonly owner: "项目维护者";
    readonly entry: "src/proactive/index.ts";
    readonly files: readonly ["src/pipeline/proactive/contract.ts", "src/pipeline/proactive/deliver/speaker.ts", "src/pipeline/proactive/interests/pool.ts", "src/pipeline/proactive/judge/chat-client.ts", "src/pipeline/proactive/judge/client.ts", "src/pipeline/proactive/judge/judge.ts", "src/pipeline/proactive/scene/collect.ts", "src/pipeline/proactive/scene/state.ts", "src/pipeline/proactive/scene/transcript.ts", "src/pipeline/proactive/scene/watcher.ts", "src/pipeline/proactive/veto/veto.ts", "src/proactive/index.ts"];
    readonly dependencies: readonly ["task", "store", "observability", "content"];
    readonly capabilities: readonly ["node:crypto", "node:fs", "yaml", "fetch"];
    readonly responsibility: "搜集、判定、否决、话题、问题、wait 票据；发送交给 Task";
    readonly invariants: readonly ["触发范围固定，旧话题预算回调绑定身份，问题集合只读"];
    readonly preconditions: "输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力";
    readonly postconditions: "成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果";
    readonly errors: "judge 失败不伪造命中，否决保守；已准入授权不因话题变化撤回";
    readonly concurrency: "同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算";
    readonly freshness: "票据绑定来源/触发 span/对象，idle、yield 与 TTL 沿用时间戳";
    readonly compatibility: "v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容";
    readonly examples: readonly [{
        readonly id: "proactive.normal";
        readonly kind: "normal";
    }, {
        readonly id: "proactive.edge";
        readonly kind: "edge";
    }, {
        readonly id: "proactive.failure";
        readonly kind: "failure";
    }];
}, {
    readonly id: "offpeak";
    readonly title: "谷时段";
    readonly version: "1.0.0";
    readonly owner: "项目维护者";
    readonly entry: "src/offpeak/index.ts";
    readonly files: readonly ["src/offpeak/calendar.ts", "src/offpeak/command.ts", "src/offpeak/gate.ts", "src/offpeak/index.ts", "src/offpeak/windows.ts"];
    readonly dependencies: readonly ["observability"];
    readonly capabilities: readonly ["node:fs", "node:path"];
    readonly responsibility: "时间计算、运行期覆盖和持久化；不调用模型";
    readonly invariants: readonly ["管理员可调整，候选保存成功才提交覆盖，时区和窗口校验"];
    readonly preconditions: "输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力";
    readonly postconditions: "成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果";
    readonly errors: "非法时间与持久化失败显式拒绝，失败保留旧生效状态";
    readonly concurrency: "同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算";
    readonly freshness: "以注入 now 和 timeZone 计算，节假日覆盖日期显式展示";
    readonly compatibility: "v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容";
    readonly examples: readonly [{
        readonly id: "offpeak.normal";
        readonly kind: "normal";
    }, {
        readonly id: "offpeak.edge";
        readonly kind: "edge";
    }, {
        readonly id: "offpeak.failure";
        readonly kind: "failure";
    }];
}, {
    readonly id: "observability";
    readonly title: "可观测性";
    readonly version: "1.0.0";
    readonly owner: "项目维护者";
    readonly entry: "src/observability/index.ts";
    readonly files: readonly ["src/health-probe.js", "src/health.ts", "src/logger.ts", "src/logging/events.ts", "src/logging/reload.ts", "src/logging/serialize.ts", "src/logging/settings.ts", "src/logging/trace.ts", "src/logging/transport.ts", "src/observability/index.ts", "src/pipeline/stats.ts"];
    readonly dependencies: readonly [];
    readonly capabilities: readonly ["node:crypto", "node:http", "fetch"];
    readonly responsibility: "Logger、追踪、统计与只读健康聚合；不参与业务状态结算";
    readonly invariants: readonly ["日志只含脱敏元数据，统计只有记录接口，观察者不阻断业务"];
    readonly preconditions: "输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力";
    readonly postconditions: "成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果";
    readonly errors: "sink 故障只计数，根因 errorId 可关联，不暴露输入或原始帧";
    readonly concurrency: "同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算";
    readonly freshness: "instanceId/traceId/spanId 和 snapshot now，事件来源 lastEventAt 保留";
    readonly compatibility: "v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容";
    readonly examples: readonly [{
        readonly id: "observability.normal";
        readonly kind: "normal";
    }, {
        readonly id: "observability.edge";
        readonly kind: "edge";
    }, {
        readonly id: "observability.failure";
        readonly kind: "failure";
    }];
}];
export declare const compositionRoots: readonly ["src/main.ts"];
export declare const stateProvisioners: readonly ["src/task/system.ts"];
export declare const stateWrites: readonly [{
    readonly type: "TaskStateWriter";
    readonly domain: "tasks";
    readonly methods: readonly ["save"];
    readonly owners: readonly ["src/task/lifecycle.ts"];
}, {
    readonly type: "MessageStateWriter";
    readonly domain: "messages";
    readonly methods: readonly ["save"];
    readonly owners: readonly ["src/task/message-queue.ts"];
}, {
    readonly type: "BudgetStateWriter";
    readonly domain: "task-budgets";
    readonly methods: readonly ["save"];
    readonly owners: readonly ["src/task/budget.ts"];
}, {
    readonly type: "SessionStateWriter";
    readonly domain: "task-sessions";
    readonly methods: readonly ["save"];
    readonly owners: readonly ["src/task/session-actor.ts"];
}];
