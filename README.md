# qqbot-dsh

把 **DeepSeek Harness (DSH)** 作为 agent 内核的 QQ 群聊 / 单聊机器人。
接入层是可插拔的多平台结构，同一个服务可以同时挂：

- **官方开放平台**（`qq-official`）：api.bot.qq.com，需审核；
- **社区框架**（`onebot`）：NapCat / LLOneBot / Lagrange 等 OneBot v11 实现，
  反向 WebSocket 接入，**无需审核**（官方目前不对个人开发者开放审核时走这条路）。

只支持 Docker 部署，`docker compose up -d --build` 即可运行。

```
官方：QQ 群 @机器人 / 单聊私信 ──wss 连出──▶ api.bot.qq.com
社区：NapCat/LLOneBot ──反向 wss 连入──▶ 本服务 :6700
                    │（两路可同时启用）
                    ▼
┌──────────────────────────────────────────────┐
│ 容器 qqbot-dsh                                │
│  接入层（每平台一个连接器）→ 编排层 → DSH 池    │
│  core/connector.ts 契约   配额/进度  每会话一进程│
│                     │                         │
│                 /data：会话日志·工作区·对话记录 │
└──────────────────────────────────────────────┘
   │
   ▼  agent 在容器内的会话专属工作区里写代码、跑命令
```

## 快速开始

```sh
cp .env.example .env                  # 只填密钥（4 个凭证 + 可选管理员白名单）
docker compose up -d --build          # qqbot.yml 随仓库提供，就是默认配置，直接用
docker compose logs -f
```

然后在群里 @机器人、或直接私聊机器人，说一句需求。详细步骤见 **[docs/DEPLOY.md](docs/DEPLOY.md)**。

也可以直接发**图片**、**引用**某条消息再提问、或发**语音**（用官方 ASR 文本）——
这些都会作为多模态内容送进模型；开关与配额见 [DESIGN.md 第 11 节](docs/DESIGN.md)。

### 用社区框架接入（免审核）

官方开放平台目前不对个人开发者开放审核。社区框架（LLBot / NapCat 等 OneBot v11
实现）不需要审核，而且没有被动回复窗口与回复次数限制，自由度更高。

推荐拓扑是**框架原生跑在宿主、bot 留在 Docker**——这也是 macOS 上能用「有头模式」
（拉起真实 QQ 客户端，官方称比纯协议模式更稳）的唯一形态：

```sh
# .env 里（密钥）：
ONEBOT_ACCESS_TOKEN=<足够长的随机串>   # openssl rand -hex 32
DEEPSEEK_API_KEY=...

# qqbot.yml 里（行为参数）：
connectors: [onebot]                    # 或 [qq-official, onebot] 并存
```

然后在 LLBot 里加一条**反向 WebSocket** 指向
`ws://127.0.0.1:6700/onebot/v11/ws`，token 与 `ONEBOT_ACCESS_TOKEN` 一致。
6700 端口映射在 `docker-compose.yml` 里默认已打开（只绑 loopback）。

完整步骤（含 macOS 安装、两个必踩的端口/图形会话坑、反向 WS 配置）见
[docs/DEPLOY.md 第 3.1 节](docs/DEPLOY.md)。

社区框架没有官方那种"5 分钟被动窗口 + 每条消息最多 5 次回复"的限制，
所以 OneBot 通道的单轮超时默认放宽到 10 分钟（`ONEBOT_TURN_TIMEOUT_MS`），
回复配额只是防失控的安全阀。

> ⚠ 社区框架（无论宿主还是容器）都基于 NTQQ 协议，存在账号风控/封禁风险，
> 建议用专门的小号。这是平台风险，与本项目代码无关。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | 方案设计：架构、多接入模型、协议契约、硬约束落地、权限与安全、实测结论 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 部署手册：从零到跑通，含沙箱后端验证与调参建议 |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | 排障手册：按症状组织的排查流程 + 未实测项清单 |

## 这个项目特别处理了什么问题

QQ 机器人的约束比看起来紧得多，下面每一条都有对应机制与测试：

| 约束 | 机制 |
|---|---|
| 被动回复窗口只有 **群聊 5 分钟 / 单聊 60 分钟**，每条消息最多回 **群聊 5 次 / 单聊 4 次** | 进度回执 + 回复配额账本（群聊/单聊各一套配额），永远给最终答案留配额；`msg_seq` 统一分配避免平台去重（40054005） |
| `session/prompt` **没有 resume 语义**，进程重启必失忆 | 桥接层自己维护对话记录，runtime 重建时按边界标记回放历史 |
| `initialize.cwd` 是**进程级**的 | 一个会话（群 / 单聊用户）一个 DSH 进程 + 一个独立工作区，避免会话间互相看到文件 |
| 单聊与群聊共用 `1<<25`，intent 层无法只订一种 | 业务层开关 `QQ_C2C_ENABLED=false` 可只服务群聊，且单聊用 `c2c:` 前缀的工作区/记录，不会与群串味 |
| 鉴权失败时 **HTTP 状态码仍是 200** | 按响应体 `code` 判断；`expires_in` 按字符串解析 |
| 心跳持续发出但收不到 ACK（连接僵死） | ACK 超时计时器跨心跳周期存活——**这个 bug 是被单测抓出来的** |
| 消息内容不只有文本：**引用、图片、语音、卡片** 各有各的字段 | 统一归一化成平台无关的 *内容片段*（`core/content.ts`），图片内联成多模态 prompt block、语音用官方 ASR 文本、卡片渲染成一行说明；详见 [DESIGN.md 第 11 节](docs/DESIGN.md) |
| 无法从文档确认的项（消息长度上限等） | 保守默认 + 遇错降级，且全部列进 [RUNBOOK 第 7 节](docs/RUNBOOK.md) |

## 权限模型（请务必了解）

采用 **workspace-write + 无人值守审批桩**：

- agent 在工作区（该会话专属目录）内可自由读写、执行命令；
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
npm test                 # 离线单测：不触网、不启动 DSH 子进程
```

### 改了东西要怎么生效

**没有热更新**，但只有改后端代码/依赖才需要重建镜像：

| 改动 | 命令 | 重建镜像 |
|---|---|---|
| `src/**` 后端代码 | `docker compose up -d --build` | 是 |
| `.env`（密钥） | `docker compose up -d` | 否 |
| `qqbot.yml`（行为参数） | `docker compose restart qqbot` | 否 |
| `dsh-profile/cordis.patch.yml`（人设/权限） | `docker compose restart qqbot` | 否 |
| 某个会话的规矩（`AGENTS.md`） | 直接写文件，连重启都不用 | 否 |

**永远不需要 `docker compose down`**——`up -d --build` 会自行重建镜像并替换容器。

改代码时想跳过镜像构建，用自带的开发覆盖文件：

```sh
npx tsc -p tsconfig.json --watch                                       # 终端 A
docker compose -f docker-compose.yml -f docker-compose.dev.yml up       # 终端 B
docker compose -f docker-compose.yml -f docker-compose.dev.yml restart qqbot  # 改完代码
```

详见 [DEPLOY.md 第 8 节](docs/DEPLOY.md)。

### 容器内验证脚本（需要 `DEEPSEEK_API_KEY`，会真实调用一次模型）

```sh
docker compose run --rm --entrypoint node qqbot scripts/smoke-dsh.mjs      # 端到端驱动一轮 DSH
docker compose run --rm --entrypoint node qqbot scripts/smoke-web-fetch.mjs # 验证 web_fetch 真能抓到正文
docker compose run --rm --entrypoint node qqbot scripts/verify-sandbox.mjs # 判定沙箱是否真闸
docker compose run --rm --entrypoint node qqbot scripts/probe-dsh.mjs      # 诊断 profile 组合问题
```

`smoke-web-fetch.mjs` 用于排查"能搜索、但抓不到原文"：它让模型真的读一个网页并核对
正文内容。抓不到通常是宿主 fake-IP 代理与 DSH 公网地址校验冲突，见
[DEPLOY.md 第 9 节](docs/DEPLOY.md)。

## 目录结构

```
docker-compose.yml       生产部署入口
docker-compose.dev.yml   开发覆盖文件（挂载本地 dist，跳过镜像重建）
.env.example             密钥样例（5 个凭证 / 个人标识）
qqbot.yml                行为配置（随仓库提供 = 默认配置；不含密钥与个人标识）
src/config.ts            env + qqbot.yml 三层合并 + 语义校验 + 启动期快速失败
src/config-file.ts       qqbot.yml 读取与形状校验（未知键名直接报错）
src/core/       接入层契约：BotConnector / 归一化事件 / 内容片段与扁平化（编排层只依赖这里）
src/adapters/   接入平台：qq-official（官方开放平台）/ onebot（NapCat 等社区框架）
src/dsh/        DSH 桥接：NDJSON JSON-RPC 客户端 / 子进程监督 / 进程池 / turn 归并 / 图片内联
src/pipeline/   编排：调度 / 配额与进度 / 分段 / 文本清洗 / 并发原语（全平台共用一条链路）
src/store/      持久化：对话记录（JSONL）/ 事件去重 / 会话映射 / 路径布局
dsh-profile/    DSH profile 补丁 + 自动审批桩
scripts/        容器入口 + 五个验证脚本
tests/          离线单测
docs/           方案设计 / 部署手册 / 排障手册
```

## 许可与来源

依赖 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）。
QQ 协议实现依据**实况官方文档**（<https://bot.q.qq.com/wiki/develop/api-v2/>），
不使用已停更的 `tencent-connect/bot-docs` 仓库作为依据——详见
[DESIGN.md 第 9 节](docs/DESIGN.md) 的来源说明。
