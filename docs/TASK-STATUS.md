# Task 重构状态

已完成实现与本地验收。生产唯一入口 `src/main.ts` 装配 `TaskSystem`，有效输入与主动请求统一进入 SessionActor、双 lane 和独立持久化消息队列。

生命周期、权限绑定、取消边界、原消息引用、Task 预算、五分钟一次性存活提醒、投递失败终态、重启恢复和附件归属均已实现。配置迁移、健康指标、模块契约及 ADR 已同步。旧整轮锁、重复配额状态、周期进度和后台结果协调已从生产路径移除；历史行为仅保留于 `tests/legacy/` 的回归夹具。

| 验证                       | 结果                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `npm run typecheck`        | 通过                                                             |
| `npm run build`            | 通过                                                             |
| `npm test`                 | 42 个测试文件通过；804 项通过，40 项真实端口用例默认跳过         |
| `npm run test:integration` | 3 个测试文件、104 项通过；统一 OneBot mock 的真实 WebSocket 回路 |
| `git diff --check`         | 通过                                                             |

`tests/task-system.test.ts` 的 38 项验收使用模拟 DSH、注入传输与时钟，覆盖双 lane 独立推进、静默与失败、迟到事件、前台子代理、引用与发送锚点分离、预算结算、提醒、取消、恢复和附件持久化。额外契约检查覆盖快 lane 工具权限、DSH 控制通道、runtime 硬上限、QQ 单次发送和模型路由配置。安装的 DSH 已实际初始化两个 lane，使用假凭证，未发起模型请求。

验收未连接真实模型、QQ 平台或已部署 OneBot 客户端。上述集成测试只连接本地 mock；线上部署需按 [运行手册](RUNBOOK.md) 核对环境与平台出口。

升级前需检查并处理旧 `background-pending.json`，该文件不自动导入新队列。新状态文件为 `tasks.json`、`messages.json`、`task-budgets.json` 和 `task-sessions.json`；待发附件保存于 `message-files/<Task ID>/`，独立于 Task 工作区与终态保留期。未完成执行重启后中断失败，已尝试但结果未知的消息不会自动重发。配置迁移见 [配置说明](CONFIG.md)。
