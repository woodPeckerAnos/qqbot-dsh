import { immutableConstant } from './readonly.js';
export const modules = immutableConstant([
  {
    id: 'config',
    title: '配置',
    version: '1.0.0',
    owner: '项目维护者',
    entry: 'src/config/index.ts',
    files: [
      'src/config-error.ts',
      'src/config-file.ts',
      'src/config-includes.ts',
      'src/config.ts',
      'src/config/index.ts',
      'src/dsh/model-config.ts',
    ],
    dependencies: ['offpeak', 'observability', 'connectors', 'content', 'proactive', 'store'],
    capabilities: ['node:fs', 'node:path', 'yaml'],
    responsibility: '解析合并、校验、模型路由与 patch；不决定执行或发送',
    invariants: [
      '有效配置在启动期固定，密钥只来自 env',
      '显式快 lane 模型目录必须声明 off 与至少一个非 off 档位；未覆写的 DSH 目录能力留给 DSH 校验',
    ],
    preconditions: '输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力',
    postconditions: '成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果',
    errors: '格式或语义错误显式 ConfigError，禁止用默认值隐藏非法配置',
    concurrency:
      '同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算',
    freshness: '启动期版本，reload 仅已有日志配置',
    compatibility:
      'v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容',
    examples: [
      {
        id: 'config.normal',
        kind: 'normal',
      },
      {
        id: 'config.edge',
        kind: 'edge',
      },
      {
        id: 'config.failure',
        kind: 'failure',
      },
    ],
  },
  {
    id: 'content',
    title: '内容',
    version: '1.0.0',
    owner: '项目维护者',
    entry: 'src/content/index.ts',
    files: [
      'src/content/index.ts',
      'src/core/content.ts',
      'src/pipeline/egress/chunk.ts',
      'src/pipeline/markdown.ts',
    ],
    dependencies: [],
    capabilities: [],
    responsibility: '片段扁平化、文本、Markdown、分段等纯计算；不做 I/O',
    invariants: ['同一片段始终产生同一规范文本，分段不超上限'],
    preconditions: '输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力',
    postconditions: '成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果',
    errors: '非法边界参数拒绝，空输入是合法边界',
    concurrency:
      '同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算',
    freshness: '纯值不适用 TTL：结果只依赖输入',
    compatibility:
      'v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容',
    examples: [
      {
        id: 'content.normal',
        kind: 'normal',
      },
      {
        id: 'content.edge',
        kind: 'edge',
      },
      {
        id: 'content.failure',
        kind: 'failure',
      },
    ],
  },
  {
    id: 'connectors',
    title: '连接器',
    version: '1.0.0',
    owner: '项目维护者',
    entry: 'src/connectors/index.ts',
    files: [
      'src/adapters/onebot/connector.ts',
      'src/adapters/onebot/normalize.ts',
      'src/adapters/onebot/types.ts',
      'src/adapters/qq-official/api.ts',
      'src/adapters/qq-official/connector.ts',
      'src/adapters/qq-official/content.ts',
      'src/adapters/qq-official/gateway.ts',
      'src/adapters/qq-official/render.ts',
      'src/adapters/qq-official/token.ts',
      'src/adapters/qq-official/types.ts',
      'src/connectors/index.ts',
      'src/core/connector.ts',
    ],
    dependencies: ['content', 'observability'],
    capabilities: [
      'node:crypto',
      'node:fs/promises',
      'node:http',
      'node:stream',
      'node:events',
      'ws',
      'fetch',
      'WebSocket',
    ],
    responsibility: '平台归一化、鉴权、收发、出口与生命周期；不编排 Task',
    invariants: ['消息与会话命名空间隔离，平台发送单次且引用保留原类型'],
    preconditions: '输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力',
    postconditions: '成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果',
    errors: '媒体获取失败降级；发送已尝试不重试，超时结果不确定',
    concurrency:
      '同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算',
    freshness: 'ts 为平台来源时间，QQ 被动窗口和 token TTL 保留',
    compatibility:
      'v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容',
    examples: [
      {
        id: 'connectors.normal',
        kind: 'normal',
      },
      {
        id: 'connectors.edge',
        kind: 'edge',
      },
      {
        id: 'connectors.failure',
        kind: 'failure',
      },
    ],
  },
  {
    id: 'store',
    title: '存储',
    version: '1.0.0',
    owner: '项目维护者',
    entry: 'src/store/index.ts',
    files: [
      'src/store/conversations.ts',
      'src/store/index.ts',
      'src/store/paths.ts',
      'src/store/personas.ts',
      'src/store/seen.ts',
      'src/store/sessions.ts',
      'src/store/tasks.ts',
      'src/store/window.ts',
    ],
    dependencies: ['content', 'observability'],
    capabilities: ['node:fs', 'node:path', 'node:crypto'],
    responsibility: '对话、去重、人设、观察窗口及 JSON 持久化；不决定任务恢复',
    invariants: ['读取快照隔离，来源时间高水位不回退，状态所有者唯一'],
    preconditions: '输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力',
    postconditions: '成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果',
    errors:
      '读取失败与缺失分离，候选保存失败不提交 generation/选择；JSONL 追加失败可有部分写入，retry=after-change，核查后才可补写',
    concurrency:
      '同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算',
    freshness: '窗口依来源 ts 高水位裁剪，read 的 now 再检查 TTL',
    compatibility:
      'v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容',
    examples: [
      {
        id: 'store.normal',
        kind: 'normal',
      },
      {
        id: 'store.edge',
        kind: 'edge',
      },
      {
        id: 'store.failure',
        kind: 'failure',
      },
    ],
  },
  {
    id: 'media',
    title: '媒体',
    version: '1.0.0',
    owner: '项目维护者',
    entry: 'src/media/index.ts',
    files: [
      'src/dsh/document.ts',
      'src/dsh/files.ts',
      'src/dsh/image.ts',
      'src/dsh/media.ts',
      'src/media/index.ts',
      'src/media/fetch-result.ts',
      'src/pipeline/egress/outbox.ts',
      'src/pipeline/egress/zip.ts',
      'src/store/inbox.ts',
    ],
    dependencies: ['content', 'connectors', 'store', 'observability'],
    capabilities: [
      'node:fs/promises',
      'node:child_process',
      'node:path',
      'node:zlib',
      'sharp',
      'fetch',
    ],
    responsibility: '下载、图片、文件抽取、输入保存、附件保存与回收；不写执行状态',
    invariants: ['媒体按 Task 隔离，realpath 限定目录，队列副本独立保留'],
    preconditions: '输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力',
    postconditions: '成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果',
    errors: '各媒体可独立降级，返回 notes/typed failure；禁止使整条输入丢失',
    concurrency:
      '同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算',
    freshness: '媒体来源是触发输入，下载预算和截止时间沿用既有参数',
    compatibility:
      'v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容',
    examples: [
      {
        id: 'media.normal',
        kind: 'normal',
      },
      {
        id: 'media.edge',
        kind: 'edge',
      },
      {
        id: 'media.failure',
        kind: 'failure',
      },
    ],
  },
  {
    id: 'runtime',
    title: 'Runtime',
    version: '1.0.0',
    owner: '项目维护者',
    entry: 'src/runtime/index.ts',
    files: [
      'src/dsh/agent-trace.ts',
      'src/dsh/pool.ts',
      'src/dsh/process.ts',
      'src/dsh/protocol.ts',
      'src/dsh/turns.ts',
      'src/runtime/index.ts',
    ],
    dependencies: ['observability'],
    capabilities: [
      'node:child_process',
      'node:events',
      'node:stream',
      'node:crypto',
      '@deepseek-ai/dsh-llm-retry',
      '@deepseek-ai/dsh-session',
    ],
    responsibility: 'DSH 协议、进程、只读租约池、累积与事件观察；不投递平台消息',
    invariants: ['具体租约身份独占，busy/子代理只有池写，旧通知隔离'],
    preconditions: '输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力',
    postconditions: '成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果',
    errors:
      '协议/进程失败保留根因，初始化错误先记录再回收；未就绪进程直接 SIGTERM，租约取消不能命中新身份',
    concurrency:
      '同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算',
    freshness: 'generation/sessionId/dshSeq 身份水位，idle/timeout 使用注入时钟',
    compatibility:
      'v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容',
    examples: [
      {
        id: 'runtime.normal',
        kind: 'normal',
      },
      {
        id: 'runtime.edge',
        kind: 'edge',
      },
      {
        id: 'runtime.failure',
        kind: 'failure',
      },
    ],
  },
  {
    id: 'task',
    title: 'Task',
    version: '1.0.0',
    owner: '项目维护者',
    entry: 'src/task/index.ts',
    files: [
      'src/task/budget.ts',
      'src/task/clock.ts',
      'src/task/control-bridge.ts',
      'src/task/dsh-lane-runner.ts',
      'src/task/index.ts',
      'src/task/lane-scheduler.ts',
      'src/task/lifecycle.ts',
      'src/task/proactive-adapter.ts',
      'src/task/prompt-preparer.ts',
      'src/task/session-actor.ts',
      'src/task/system.ts',
      'src/task/types.ts',
    ],
    dependencies: ['runtime', 'media', 'store', 'delivery', 'observability', 'content'],
    capabilities: ['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'node:url'],
    responsibility: 'Actor、执行状态、lane、预算、控制、输入准备及装配；不写投递状态',
    invariants: ['每输入一个 Task，双 lane 终结，短事务无整轮锁，预算守恒'],
    preconditions: '输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力',
    postconditions: '成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果',
    errors:
      '准入/持久化失败不留下可调度半成品；失败与正常 silent 分开；预算保存失败由维护循环只补结算，未创建 Task 的预留释放',
    concurrency:
      '同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算',
    freshness: '输入时固定 generation/窗口，排队不计执行时限，终态保留 7 天',
    compatibility:
      'v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容',
    examples: [
      {
        id: 'task.normal',
        kind: 'normal',
      },
      {
        id: 'task.edge',
        kind: 'edge',
      },
      {
        id: 'task.failure',
        kind: 'failure',
      },
    ],
  },
  {
    id: 'delivery',
    title: '投递',
    version: '1.0.0',
    owner: '项目维护者',
    entry: 'src/delivery/index.ts',
    files: [
      'src/delivery/index.ts',
      'src/pipeline/egress/responder.ts',
      'src/task/message-queue.ts',
      'src/task/output-coordinator.ts',
    ],
    dependencies: ['content', 'media', 'observability'],
    capabilities: ['node:crypto', 'node:fs/promises', 'node:path'],
    responsibility: '队列、产物、正文去重、原引用与提醒；不写执行状态',
    invariants: ['MessageQueue 唯一写者，发送前持久化，失败通知一次，附件独立'],
    preconditions: '输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力',
    postconditions: '成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果',
    errors:
      '保存 sending 失败不发；平台后保存失败保持 unknown；发送失败为 UPSTREAM_FAILED、超时为 TIMEOUT、重启未知为 UNKNOWN_OUTCOME，均禁止重发',
    concurrency:
      '同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算',
    freshness: '原引用与当前合法出口分离，提醒沿用 5 分钟固定上限',
    compatibility:
      'v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容',
    examples: [
      {
        id: 'delivery.normal',
        kind: 'normal',
      },
      {
        id: 'delivery.edge',
        kind: 'edge',
      },
      {
        id: 'delivery.failure',
        kind: 'failure',
      },
    ],
  },
  {
    id: 'ingress',
    title: 'Ingress',
    version: '1.0.0',
    owner: '项目维护者',
    entry: 'src/ingress/index.ts',
    files: [
      'src/ingress/index.ts',
      'src/pipeline/hints.ts',
      'src/pipeline/ingress/dedupe.ts',
      'src/pipeline/ingress/offpeak-command.ts',
      'src/pipeline/ingress/offpeak-gate.ts',
      'src/pipeline/ingress/persona-command.ts',
      'src/pipeline/ingress/record.ts',
      'src/pipeline/ingress/session-command.ts',
      'src/pipeline/ingress/types.ts',
      'src/pipeline/ingress/welcome.ts',
      'src/pipeline/orchestrator.ts',
      'src/pipeline/topic-judge.ts',
    ],
    dependencies: ['task', 'delivery', 'store', 'offpeak', 'observability', 'content'],
    capabilities: ['fetch'],
    responsibility: '输入管线、命令路由、话题判定；末端只提交 Actor',
    invariants: ['去重→命令→闸→记录→准入，旁听不入完整管线'],
    preconditions: '输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力',
    postconditions: '成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果',
    errors: '话题失败显式错误并保守回退 related=true，不吞用户输入',
    concurrency:
      '同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算',
    freshness: '来源 ts 保留，话题判断有既有 timeout，配置禁用与失败分离',
    compatibility:
      'v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容',
    examples: [
      {
        id: 'ingress.normal',
        kind: 'normal',
      },
      {
        id: 'ingress.edge',
        kind: 'edge',
      },
      {
        id: 'ingress.failure',
        kind: 'failure',
      },
    ],
  },
  {
    id: 'proactive',
    title: '主动介入',
    version: '1.0.0',
    owner: '项目维护者',
    entry: 'src/proactive/index.ts',
    files: [
      'src/pipeline/proactive/contract.ts',
      'src/pipeline/proactive/deliver/speaker.ts',
      'src/pipeline/proactive/interests/pool.ts',
      'src/pipeline/proactive/judge/chat-client.ts',
      'src/pipeline/proactive/judge/client.ts',
      'src/pipeline/proactive/judge/judge.ts',
      'src/pipeline/proactive/scene/collect.ts',
      'src/pipeline/proactive/scene/state.ts',
      'src/pipeline/proactive/scene/transcript.ts',
      'src/pipeline/proactive/scene/watcher.ts',
      'src/pipeline/proactive/veto/veto.ts',
      'src/proactive/index.ts',
    ],
    dependencies: ['task', 'store', 'observability', 'content'],
    capabilities: ['node:crypto', 'node:fs', 'yaml', 'fetch'],
    responsibility: '搜集、判定、否决、话题、问题、wait 票据；发送交给 Task',
    invariants: ['触发范围固定，旧话题预算回调绑定身份，问题集合只读'],
    preconditions: '输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力',
    postconditions: '成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果',
    errors: 'judge 失败不伪造命中，否决保守；已准入授权不因话题变化撤回',
    concurrency:
      '同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算',
    freshness: '票据绑定来源/触发 span/对象，idle、yield 与 TTL 沿用时间戳',
    compatibility:
      'v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容',
    examples: [
      {
        id: 'proactive.normal',
        kind: 'normal',
      },
      {
        id: 'proactive.edge',
        kind: 'edge',
      },
      {
        id: 'proactive.failure',
        kind: 'failure',
      },
    ],
  },
  {
    id: 'offpeak',
    title: '谷时段',
    version: '1.0.0',
    owner: '项目维护者',
    entry: 'src/offpeak/index.ts',
    files: [
      'src/offpeak/calendar.ts',
      'src/offpeak/command.ts',
      'src/offpeak/gate.ts',
      'src/offpeak/index.ts',
      'src/offpeak/windows.ts',
    ],
    dependencies: ['observability'],
    capabilities: ['node:fs', 'node:path'],
    responsibility: '时间计算、运行期覆盖和持久化；不调用模型',
    invariants: ['管理员可调整，候选保存成功才提交覆盖，时区和窗口校验'],
    preconditions: '输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力',
    postconditions: '成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果',
    errors: '非法时间与持久化失败显式拒绝，失败保留旧生效状态',
    concurrency:
      '同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算',
    freshness: '以注入 now 和 timeZone 计算，节假日覆盖日期显式展示',
    compatibility:
      'v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容',
    examples: [
      {
        id: 'offpeak.normal',
        kind: 'normal',
      },
      {
        id: 'offpeak.edge',
        kind: 'edge',
      },
      {
        id: 'offpeak.failure',
        kind: 'failure',
      },
    ],
  },
  {
    id: 'observability',
    title: '可观测性',
    version: '1.0.0',
    owner: '项目维护者',
    entry: 'src/observability/index.ts',
    files: [
      'src/health-probe.js',
      'src/health.ts',
      'src/logger.ts',
      'src/logging/events.ts',
      'src/logging/reload.ts',
      'src/logging/serialize.ts',
      'src/logging/settings.ts',
      'src/logging/trace.ts',
      'src/logging/transport.ts',
      'src/observability/index.ts',
      'src/pipeline/stats.ts',
    ],
    dependencies: [],
    capabilities: ['node:crypto', 'node:http', 'fetch'],
    responsibility: 'Logger、追踪、统计与只读健康聚合；不参与业务状态结算',
    invariants: ['日志只含脱敏元数据，统计只有记录接口，观察者不阻断业务'],
    preconditions: '输入通过契约类型与既有配置校验；异步调用带具体身份，调用者只持有分配的能力',
    postconditions: '成功后返回隔离值；状态写入先持久化再提交/通知；已发生平台动作保留未知结果',
    errors: 'sink 故障只计数，根因 errorId 可关联，不暴露输入或原始帧',
    concurrency:
      '同模块所有者协调写入；异步退订与关闭幂等，关闭后不创建新工作；事件按具体身份和幂等键至多一次结算',
    freshness: 'instanceId/traceId/spanId 和 snapshot now，事件来源 lastEventAt 保留',
    compatibility:
      'v1 只增不改；破坏性签名先添加新版本，迁移生产消费者后删除旧入口；既有记录与平台字段兼容',
    examples: [
      {
        id: 'observability.normal',
        kind: 'normal',
      },
      {
        id: 'observability.edge',
        kind: 'edge',
      },
      {
        id: 'observability.failure',
        kind: 'failure',
      },
    ],
  },
] as const);

export const compositionRoots = immutableConstant(['src/main.ts'] as const);
export const stateProvisioners = immutableConstant(['src/task/system.ts'] as const);
export const stateWrites = immutableConstant([
  {
    type: 'TaskStateWriter',
    domain: 'tasks',
    methods: ['save'],
    owners: ['src/task/lifecycle.ts'],
  },
  {
    type: 'MessageStateWriter',
    domain: 'messages',
    methods: ['save'],
    owners: ['src/task/message-queue.ts'],
  },
  {
    type: 'BudgetStateWriter',
    domain: 'task-budgets',
    methods: ['save'],
    owners: ['src/task/budget.ts'],
  },
  {
    type: 'SessionStateWriter',
    domain: 'task-sessions',
    methods: ['save'],
    owners: ['src/task/session-actor.ts'],
  },
] as const);
