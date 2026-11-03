# Task 与 Logger 验收状态

Logger 第一梯队改造：**已实施并通过离线验收（2026-11-03）**。契约与 ADR-002、事件目录和 logger 内核、输入/Task/队列追踪、独立 DSH 观察器、SIGHUP 诊断、配置及运行手册已完成回查。日志为有界 stderr JSONL，仅含元数据；执行与投递终态分别记录，Task 清理后队列仍保留原 trace。

已完成实现与本地验收。生产唯一入口 `src/main.ts` 装配 `TaskSystem`，有效输入与主动请求统一进入 SessionActor、双 lane 和独立持久化消息队列。

生命周期、权限绑定、取消边界、原消息引用、Task 预算、五分钟一次性存活提醒、投递失败终态、重启恢复和附件归属均已实现。配置迁移、健康指标、模块契约及 ADR 已同步。旧整轮锁、重复配额状态、周期进度和后台结果协调已从生产路径移除；历史行为仅保留于 `tests/legacy/` 的回归夹具。

| 本次验证                 | 结果                                                     |
| ------------------------ | -------------------------------------------------------- |
| `npm run typecheck`      | 通过                                                     |
| `npm run build`          | 通过                                                     |
| `npm run lint`           | 通过；未新增抑制，MessageQueue 的既有复杂度债务减少      |
| `npm run format:check`   | 通过；生成的架构预览保持原样                             |
| `npm test`               | 45 个测试文件通过；841 项通过，40 项真实端口用例默认跳过 |
| 最后主动适配方法拆分回归 | Task、wait、主动 watcher/session 共 4 个文件、110 项通过 |
| `git diff --check`       | 通过                                                     |

本次重点证据：`tests/logging.test.ts` 12 项验证共享配置、身份保护、脱敏/异常序列化、诊断到期、执行额度不重置、十万诊断事件、背压、异步断流去重与 flush；`tests/agent-trace.test.ts` 13 项验证嵌套归属、每会话序号、旧执行、通知去重、token/retry/tool 汇总与缓存上限；`tests/runtime-logging.test.ts` 验证十万 stderr 行、协议污染不泄露内容，以及后续退出引用既有根因。

`tests/task-system.test.ts` 当前 48 项使用模拟 DSH、注入连接器与时钟，覆盖同会话并发双 lane、嵌套子代理、Task 清理后的延迟投递、取消与命令回执关联、主动准入、媒体摄取复用、旧记录恢复，以及追踪缓存超限/输出断流/SIGHUP 不影响业务结算。wait 的创建、唤醒与重判 span 在 `tests/proactive-wait.test.ts` 验证。额外契约检查继续覆盖快 lane 工具权限、DSH 控制通道、runtime 硬上限、QQ 单次发送和模型路由配置。安装的 DSH 已实际初始化两个 lane，使用假凭证，未发起模型请求。

历史基线（ADR-001，不作为本次新验收）：42 个文件、804 项离线通过；计划所述 77 项为 Task 38 + 协议 22 + runtime 池 17。历史 `npm run test:integration` 为 3 个文件、104 项本地 mock WebSocket 通过；本次未重跑，真实 WebSocket 仍为独立集成检查。

验收未连接真实模型、QQ 平台或已部署 OneBot 客户端。上述集成测试只连接本地 mock；线上部署需按 [运行手册](RUNBOOK.md) 核对环境与平台出口。

升级前需检查并处理旧 `background-pending.json`，该文件不自动导入新队列。新状态文件为 `tasks.json`、`messages.json`、`task-budgets.json` 和 `task-sessions.json`；待发附件保存于 `message-files/<Task ID>/`，独立于 Task 工作区与终态保留期。未完成执行重启后中断失败，已尝试但结果未知的消息不会自动重发。配置迁移见 [配置说明](CONFIG.md)。
