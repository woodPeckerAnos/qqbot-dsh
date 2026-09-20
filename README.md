# qqbot-dsh

把 **DeepSeek Harness (DSH)** 作为 agent 内核接入 **QQ 官方开放平台**的群机器人。
只支持 Docker 部署，`docker compose up -d --build` 即可运行。

```
QQ 群 @机器人
   │
   ▼  wss://api.bot.qq.com（主动出网，无需公网入口）
┌──────────────────────────────────────────────┐
│ 容器 qqbot-dsh                                │
│  QQ 接入层  →  编排层  →  DSH runtime 子进程   │
│  零依赖 WS     配额/进度    每群一个进程        │
│                     │                         │
│                 /data：会话日志·工作区·对话记录 │
└──────────────────────────────────────────────┘
   │
   ▼  agent 在容器内的群专属工作区里写代码、跑命令
```

## 快速开始

```sh
cp .env.example .env      # 填 QQ_APP_ID / QQ_APP_SECRET / DEEPSEEK_API_KEY
docker compose up -d --build
docker compose logs -f
```

然后在群里 @机器人 说一句需求。详细步骤见 **[docs/DEPLOY.md](docs/DEPLOY.md)**。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | 方案设计：架构、协议契约、硬约束落地、权限与安全、实测结论 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 部署手册：从零到跑通，含沙箱后端验证与调参建议 |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | 排障手册：按症状组织的排查流程 + 未实测项清单 |

## 这个项目特别处理了什么问题

QQ 群机器人的约束比看起来紧得多，下面每一条都有对应机制与测试：

| 约束 | 机制 |
|---|---|
| 群被动回复窗口只有 **5 分钟**，每条消息最多回 **5 次** | 进度回执 + 回复配额账本，永远给最终答案留配额；`msg_seq` 统一分配避免平台去重（40054005） |
| `session/prompt` **没有 resume 语义**，进程重启必失忆 | 桥接层自己维护对话记录，runtime 重建时按边界标记回放历史 |
| `initialize.cwd` 是**进程级**的 | 一个 QQ 群一个 DSH 进程 + 一个独立工作区，避免群间互相看到文件 |
| 鉴权失败时 **HTTP 状态码仍是 200** | 按响应体 `code` 判断；`expires_in` 按字符串解析 |
| 心跳持续发出但收不到 ACK（连接僵死） | ACK 超时计时器跨心跳周期存活——**这个 bug 是被单测抓出来的** |
| 无法从文档确认的项（消息长度上限等） | 保守默认 + 遇错降级，且全部列进 [RUNBOOK 第 7 节](docs/RUNBOOK.md) |

## 权限模型（请务必了解）

采用 **workspace-write + 无人值守审批桩**：

- agent 在工作区（该群专属目录）内可自由读写、执行命令；
- 工作区之外由**沙箱**强制挡住；
- 无人值守的审批由桩自动放行（否则无头环境里工具调用会被 fail-closed 拒绝）。

**关键前提**：沙箱需要有可用的后端。在 Linux 上 DSH 使用 `bwrap` 或 `Landlock`。
若两者都不可用，`workspace-write` 会退化为**事实上的完全访问**——此时容器本身
（只读根文件系统、`cap_drop: ALL`、资源上限、非 root）才是真正的边界。

用这条命令确认你部署里的真实情况：

```sh
docker compose run --rm --entrypoint node qqbot scripts/verify-sandbox-capability.mjs
```

`SANDBOX-EFFECTIVE` = 工作区边界有效；`DEGRADED` = 已降级，处置见
[DEPLOY.md 第 5 节](docs/DEPLOY.md)。残余风险（agent 可执行任意代码并出网、
API Key 在容器内可见）详见 [DESIGN.md 6.4](docs/DESIGN.md)。

## 开发

```sh
npm install
npm run typecheck
npm test                 # 143 项单测，全离线：不触网、不启动 DSH 子进程
```

容器内验证脚本（需要 `DEEPSEEK_API_KEY`，会真实调用一次模型）：

```sh
docker compose run --rm --entrypoint node qqbot scripts/smoke-dsh.mjs      # 端到端驱动一轮 DSH
docker compose run --rm --entrypoint node qqbot scripts/verify-sandbox.mjs # 判定沙箱是否真闸
docker compose run --rm --entrypoint node qqbot scripts/probe-dsh.mjs      # 诊断 profile 组合问题
```

## 目录结构

```
src/qq/         QQ 接入层：token / WS 生命周期 / OpenAPI / wire 类型
src/dsh/        DSH 桥接：NDJSON JSON-RPC 客户端 / 子进程监督 / 进程池 / turn 归并
src/pipeline/   编排：调度 / 配额与进度 / 分段 / 渲染 / 并发原语
src/store/      持久化：对话记录（JSONL）/ 事件去重 / 会话映射 / 路径布局
dsh-profile/    DSH profile 补丁 + 自动审批桩
scripts/        容器入口 + 四个验证脚本
tests/          143 项离线单测
docs/           方案设计 / 部署手册 / 排障手册
```

## 许可与来源

依赖 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）。
QQ 协议实现依据**实况官方文档**（<https://bot.q.qq.com/wiki/develop/api-v2/>），
不使用已停更的 `tencent-connect/bot-docs` 仓库作为依据——详见
[DESIGN.md 第 9 节](docs/DESIGN.md) 的来源说明。
