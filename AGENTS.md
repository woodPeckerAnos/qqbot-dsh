# 项目入口

先读 [README.md](README.md)、[架构](docs/ARCHITECTURE.md) 和 [模块契约](docs/MODULE-CONTRACTS.md)。
修改行为前先更新契约与 ADR，代码完成后回查契约、配置和验收。现状与历史方案分开标注。
运行入口只有 `src/main.ts`；有效输入由 SessionActor 创建 Task，禁止重新引入整轮会话锁。
执行状态只由 TaskLifeCycleManager 写入，消息投递状态只由 MessageQueue 写入。
验证使用注入 DSH、连接器和时钟的离线 mock；真实 WebSocket 为独立集成检查。

决策见 [ADR](docs/adr/)。
