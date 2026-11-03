# 现行架构

交互式架构图：[SessionActor 与双 lane 任务编排](diagrams/session-actor-lanes.html)（源：[candidate](diagrams/session-actor-lanes.architecture.json)）。

核心 Logger 已以显式只读 TraceContext 贯通输入、Task、双 lane、DSH 父子执行、产物和独立投递队列；日志只含元数据。状态写入权与调度不变，设计见 [ADR-002](adr/002-logging-tracing.md)。

每次启动生成 instanceId，每个输入或主动评估生成 traceId。Task、lane、执行、子代理、产物和消息分别有 span；队列独立持久化 trace，Task 结束或清理后仍能关联投递，新的发送锚点不改写原输入。执行终态与投递终态分别记录。wait 票据保留触发 span，取消事件关联发起命令和目标 Task。

Logger 子实例共享配置、预算与 stderr JSONL 缓冲。TaskLifeCycleManager 与 MessageQueue 在状态持久化后记录事件，DshLaneRunner 记录执行与产物，独立 AgentTraceObserver 只消费实时通知、按每个 DSH 会话水位去重并在执行结束释放有界缓存。RuntimePool 只保留资源事件，DshRuntime 记录首次进程/协议根因，状态事件引用 errorId。日志配置可用 SIGHUP 重载，其他配置仍需原来的生效流程。

## Task 与双 lane

当前运行架构：接入、归一化、去重、命令、输入判定 → SessionActor → TaskLifeCycleManager → 两个独立 LaneScheduler → SessionOutputCoordinator → MessageQueue → 连接器。唯一入口 `src/main.ts` 已完成装配。

每个有效输入和主动请求恰好创建一个 Task，原子准入两个 lane。同 Session 每个 lane 串行，lane 之间独立推进。Actor 只协调短事务；长执行、媒体整理和上传不占 Actor 锁。上下文在输入时固定，话题切换只影响后续 generation。

快 lane 独立 runtime / session，thinking=false、reasoningEffort=off，仅可查询和取消 Task。慢 lane 自行判定长技能（包括深度推理）；普通问答正常返回 NO_REPLY；实际执行失败、超时和空结果必须产生失败产物。子代理前台等待，执行及子代理均终结后结算。

两个 lane 终结才结算 Task。取消优先，否则任一失败为 failed，其余 completed。执行完成不等待投递；投递失败不改写执行状态。已入队产物取消后仍发送。/stop 取消命令到达时有 lane 正执行的 Task；/new 取消全部未完成 Task 并重置上下文。

慢、延迟、主动和存活提醒引用输入时保存的原消息。引用目标与平台出口锚点独立。相同 Task 完全相同正文去重，附件单独保留。后来的话题或回答不撤销已授权的主动请求。

主动预算按 Task 预留一个单位，首次任意消息成功送达提交一次，静默或所有投递失败释放。范围绑定触发时的话题。队列先持久化再尝试发送；失败或超时不重试，只生成一次不递归失败通知。重启不恢复执行、不重发已尝试但结果未知的消息。

默认快 30 秒、慢 30 分钟（排队不计时），runtime 总上限 8、各 lane 4；Session 未完成 Task 32、全局 128，终态保留 7 天。待发消息及文件独立保存。快送达且慢开始后等 5 分钟，慢仍执行才发最多一次存活提醒；无即时合法出口放弃。

## 平台前提

- **DSH 协议自研**：`@deepseek-ai/dsh-sdk-client` 未发布，桥接层直接实现 NDJSON JSON-RPC：3 个方法（`initialize` / `session/prompt` / `shutdown`）与 4 个通知（`session.event` / `session.status` / `subagent.started` / `subagent.finished`）。`session/prompt` 只返回入队回执，结果只能从事件流取；`initialize` 校验 `serverInfo.name` 以发现协议漂移。
- **被动回复窗口**：群聊 5 分钟 / 5 次，单聊 60 分钟 / 4 次，这是全系统最硬的约束。配额按会话类型取（`QQ_MAX_REPLIES_PER_MSG` / `QQ_C2C_MAX_REPLIES_PER_MSG`）；单轮超时故意沿用群聊保守上限（<295s），因为"超时提示发不出去"比"任务跑得不够久"更难排查。
- **没有 resume**：`session/prompt` 走 `agents.create()` 而不是 `open()`，重启后同一 `sessionId` 也是空上下文。"重启不失忆"只能由桥接层的对话记录与冷启动回放兜底。

## DSH profile 与 persona

- 不新建 bundle，在 `sdk` profile 上打 patch：`dsh --profile sdk --patch dsh-profile/cordis.patch.yml`。首次运行自动初始化 `$DSH_HOME/profiles/sdk`，镜像不预置 profile。
- patch 五件事：覆盖 persona（群助手 + 输出纪律）、钉死 `approval.policy = ask` 并挂 auto-approve 桩、钉死 `sandbox-policy.mode = workspace-write`、只 `disabled` 掉纯叶子 `tool-jobs`、插入本地插件。
- 两个实测坑：`!!js` 的值会被 `eval`，表达式必须写在一行，换行用 `String.fromCharCode(10)`；不能 `disabled` 提供服务器的行，否则依赖方永远 pending（boot 报 "entries did not activate"）。
- `/persona <名>` 把预设写进该会话工作区 `AGENTS.md` 的标记区块，DSH 每步探测 mtime，下一个 turn 生效，不重建 runtime。预设只放风格与口径，身份、安全与派发纪律在 `personaPrefix`。

## 安全边界

- 三层：DSH 沙箱（`workspace-write`）+ 审批（`ask` + auto-approve 桩）+ 容器加固。`policy: never` 不可用——它会在应答者之前直接拒绝，agent 等于写不了文件。
- **降级路径**：宿主没有可用沙箱后端时，`workspace-write` 会请求提权并退化成事实上的完全访问。镜像装 bubblewrap 作为 Linux 后端，`scripts/verify-sandbox.mjs` 验收（`SANDBOX-EFFECTIVE` / `DEGRADED`），entrypoint 检查 bwrap；`allowEscalation` 决定 fail-open（可用但降级）还是 fail-closed（只能做不需执行命令的事）。
- **容器才是真边界**：只读根文件系统、仅三个具名卷 + tmpfs `/tmp`、`cap_drop: ALL`、`no-new-privileges`、非 root uid 10001、`pids_limit 512`、2 CPU / 2GB、日志 `20m × 5`。
- **残余风险**：agent 可执行任意代码并出网（prompt injection 可外发内容）；`DEEPSEEK_API_KEY` 在容器内可见；同容器不同会话的工作区互相可读；群成员与私聊用户身份不可信；`tool-jobs` 关闭但 bash 仍可 `&` 起后台进程；图片下载是受控 SSRF 面（字节嗅探为 png/jpeg/webp/gif、单张与张数上限、下载超时，不拒绝内网地址）。

## 接入与连接器

- 唯一接缝 `src/core/connector.ts`：`BotConnector` 收发两侧是 `NormalizedEvent` 与 `reply(ReplyContext, OutgoingMessage)`；编排层不 import 任何 `adapters/*` 内部实现。
- 会话键：官方保持裸 openid 与 `c2c:` 前缀（既有目录不迁移）；OneBot 用 `ob11:g<群号>` / `ob11:u<QQ号>`——数字 QQ 号与 openid 是两套命名空间，无前缀必碰撞。
- 自由度差异显式落在 `ReplyPolicy`：官方有回复窗口、条数上限、`(msg_id, msg_seq)` 去重、单轮 <295s；OneBot 无窗口、无 seq、默认 600s。配额账本、分段等平台无关逻辑留在编排层。
- OneBot：本服务起反向 WS server（默认 6700），框架作为客户端连入；`ONEBOT_ACCESS_TOKEN` 必填；动作以 `echo` 对回、15 秒超时；按"最近投递过该会话事件的连接"回发；加好友默认同意、拉群邀请默认拒绝；忽略 `self_id`；群消息只响应 @。

## 富媒体

- 接缝是 `MessagePart`（text / image / voice / media / quote / forward）：片段只放引用信息，下载放到 turn 期；`content` 是 `parts` 的扁平化结果，同时承担对话记录、冷启动回放、命令匹配与日志——四处必须是同一份文本。
- **图片**：MIME 以字节嗅探为准（只接受 png/jpeg/webp/gif）；单张字节、张数与超时都有上限；超限先降采样或重编码，解不开才不内联（否则 runtime 会以 `INVALID_IMAGE` 拒掉整条 prompt）；极端长宽比按"每块 ≤64 万像素"切片（默认 12 块）；任一张失败只降级成一行文字说明；冷启动回放是纯文本，不重下载历史图片。
- **转发块**：在连接器期展开（因为 `content` 五处共用），只在 `atSelf` 判定通过后回查；转发 id 走 LRU + TTL；`maxNodes` / `maxNodeChars` / `maxChars` / `maxDepth` 四重上限，嵌套共用外层预算，另计回查次数与墙钟；`message_id` 必须保持原类型（19 位十进制超 2^53，转 `Number()` 会静默改写，NapCat 优先取它）；回查失败一律退回 `[聊天记录]`，`.catch` 保证丢补全也不丢消息。
- **文件**：白名单外的类型不下载；`pdftotext` 抽取 + 落盘两条路；文件名 sanitize、`wx` 标志防覆盖、realpath 必须落在工作区内；正文包在边界标签里并用 `guardUntrustedText` 中和伪造标签；`inbox/` 与 `outbox/` 不得同名。
- **出站**：`outbox/` 目录约定（超时/中断下仍可靠），realpath 必须仍在 outbox 内；附件与文本共享配额——文本保底 1 条、只剩 1 条时反转给附件、附件先发、超限降级为一行说明；官方两步上传后发 `msg_type=7`，OneBot 走消息段或 `upload_*`，字节传输默认 base64。

## 来源

- **DSH**：本地安装包源码核对（`dsh-sdk-protocol`、`dsh-sdk-jsonrpc-server`、`dsh-agent-loop`、`dsh-user-approval`、`dsh-permission-presets`、`dsh-sandbox-policy`、`dsh-app-boot`）。
- **QQ**：[API v2 文档首页](https://bot.q.qq.com/wiki/develop/api-v2/)、access-token、事件 payload 与 intents、WebSocket 接入与错误码、消息收发与频控、发送群/单聊消息、单聊事件与 changelog。
- **已废弃**：`tencent-connect/bot-docs` 最后提交 2025-04-21，域名与主动推送状态均与实况不符，不作为依据。

历史推导（旧单轮执行、后台派发、周期进度与各平台实测细节）见 git 历史中的 `docs/DESIGN.md`，现行实现以本文件与 ADR 为准。
