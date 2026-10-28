# qqbot-dsh

> **把 DeepSeek Harness（DSH）接进 QQ。** 一个服务、多个出口、会主动说话的群聊 agent。

三个亮点，决定了它和常见 QQ 机器人不一样：

| | 亮点 | 一句话 |
|---|---|---|
| ⚙️ | **完整 agent 能力** | 内核是 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh)：每个会话一个独立进程 + 独立工作区，能真的写代码、跑命令、读文件、多步干活并交付产物 |
| 🔌 | **一套服务，多套出口** | 官方开放平台与社区框架（OneBot v11）**可同时在线**，编排层以上只有一条代码路径；接入差异全部收在适配器里 |
| 💬 | **主动发言** | 不只对 @ 反应：旁听群聊 → 判断该不该开口 → 五类场景下主动插话，带限流、**话题会话发言预算**、「没人理我就停」等硬闸门 |
| 🎭 | **可切换的人设前台** | 管理员发 `/persona <名>` 即可切换该会话的应答风格（预设 = `dsh-profile/personas/*.md`），写入工作区 AGENTS.md 标记区块，**下一条消息生效、无需重启**；长任务由后台子代理托管 + 长任务提示注入补强，会话不被卡死（[DESIGN §13–14](docs/DESIGN.md)） |

```mermaid
flowchart LR
  subgraph QQ["QQ 侧"]
    A["官方开放平台<br/>api.bot.qq.com"]
    B["社区框架<br/>NapCat / LLBot"]
  end

  subgraph BOT["qqbot-dsh（一个容器）"]
    C["接入层<br/>platform adapters"] --> D["编排层<br/>并发 · 配额 · 进度 · 去重"]
    D --> E["DSH 池<br/>一会话一进程一工作区"]
    G["主动介入<br/>旁听 → 判定 → 否决"] -.->|主动发言| C
  end

  A <-->|wss| C
  B <-->|反向 wss :6700| C
  B -.->|旁听非 @ 消息| G
  E --> F["写代码 · 跑命令 · 产出文件<br/>结果与产物回发到 QQ"]
  F --> C
```

| 通道 | 接入方式 | 旁听（听得到没 @ 的消息） | 主动发言 |
|---|---|---|---|
| **官方开放平台** `qq-official` | 主动 wss 连出 api.bot.qq.com，需审核 | 需开通「接收所有消息」能力 | ❌ 平台不支持（主动推送已停用、群聊每月 4 条） |
| **社区框架** `onebot` | 反向 WebSocket 连入 `:6700`，**免审核** | ✅ | ✅ |

---

## 快速开始

只支持 Docker 部署。`qqbot.yml` 随仓库提供（= 默认配置，带注释，**不用复制**），
所以起步只有两步：**填 `.env` → `docker compose up -d --build`**。

要填哪些凭证，取决于走哪条通道（默认配置里两条都开着，不用就把另一条从
`qqbot.yml` 的 `connectors` 里删掉）：

| 通道 | `.env` 里必填 | 说明 |
|---|---|---|
| **社区框架**（推荐） | `DEEPSEEK_API_KEY`、`ONEBOT_ACCESS_TOKEN` | 免审核；`connectors: [onebot]` |
| **官方开放平台** | `QQ_APP_ID`、`QQ_APP_SECRET`、`DEEPSEEK_API_KEY` | 需审核；`connectors: [qq-official]` |

```sh
cp .env.example .env
docker compose up -d --build
docker compose logs -f
```

启动后在群里 @机器人、或直接私聊说一句需求。**完整步骤与常见坑见
[docs/DEPLOY.md](docs/DEPLOY.md)**；社区框架那条路还要多做一步反向 WS 配置（见下）。

也可以直接发**图片**、**引用**某条消息再提问、发**转发消息块（合并转发）**、
发**文件（PDF 等）**、或发**语音**（用官方 ASR 文本）——这些都会送进模型；
超限的长图/大图会自动降采样、长截图按块切片送入（不会再说"收不到图片"），
开关与配额见 [DESIGN 第 11 节](docs/DESIGN.md)。

### 走社区框架：接上反向 WebSocket

`.env` 填好后，在框架（NapCat / LLBot）里加一条**反向 WebSocket** 指向
`ws://127.0.0.1:6700/onebot/v11/ws`，token 与 `ONEBOT_ACCESS_TOKEN` 一致。
6700 端口默认已映射（只绑 loopback，不对局域网开放），所以框架跑在宿主即可连上。

框架选型（macOS 实测：**NapCat 有头形态掉线率明显更低**）、必踩的端口/图形会话坑、
完整反向 WS 配置：见 **[DEPLOY 第 3.1 节](docs/DEPLOY.md)**。

> ⚠️ 社区框架基于 NTQQ 协议，存在账号风控风险，**建议用专门的小号**。这是平台风险，与代码无关。

### 可选：打开主动发言

默认**关闭**；即使打开也先进入**灰度观察**（判定照跑、只记录"本应发言"，不真的发）。

> 🔎 **群白名单与主动发言是两件事。** `BOT_LISTEN_GROUPS` 同时决定「观察窗口」
> 的范围——**只想要"被 @ 时能看懂大家在聊什么"也必须填它**，而
> `BOT_PROACTIVE_ENABLED` 保持 `false` 即可（滚窗与主动发言已解耦，见
> [store/window.ts](src/store/window.ts)）。

```ini
# .env（群号是个人标识，只在这里配）
BOT_LISTEN_GROUPS=onebot:123456      # 白名单；留空 = 不接任何群、也不观察任何群
BOT_PROACTIVE_ENABLED=true           # 总开关
BOT_PROACTIVE_DRY_RUN=true           # 默认值：先观察，确认判据准了再改 false
```

```bash
# 可选：兴趣池（场景 5）。仓库里已有一份近乎为空的 interests.yml 占位，
# 空池 = 场景 5 不触发（其余四个场景不受影响）。要真的用起来，照样例填：
cp src/pipeline/proactive/interests/interests.yml.example interests.yml
```

> ⚠️ 别删掉宿主上的 `interests.yml` / `qqbot.yml`：compose 是 bind mount，
> 文件不存在时 Docker 会**自动建一个同名目录**，容器启动会直接失败。

它**会在什么情况下开口**，用人话写在
**[SCENES.md](src/pipeline/proactive/interests/SCENES.md)**：五类场景（指代 / 续聊追问 /
无人应答 / 持续讨论 / 兴趣话题）+ 全局闸门（没人理我就停、限流、话题会话
`sessionBudget`、夜间静默）。
灰度期间看 `curl -s localhost:8080/health | jq .proactive` 的 `wouldSend` 与
`sessions`（`opened` / `closedBy` / `spokeInSession`——后者回答"预算 2 到底对不对"）；
"它为什么不说话"的排查顺序见 **[RUNBOOK §5](docs/RUNBOOK.md)**。

### 可选：换/加模型提供商

默认走 DeepSeek 官方路由（`deepseek-official` + `DEEPSEEK_API_KEY`）。要换成或增加
其他提供商——OpenAI / Anthropic 等 pi-ai 目录内的厂商，或任何 OpenAI 兼容的
自建网关——在 `qqbot.yml` 的 **`models:` 段**声明路由，密钥以 `apiKeyEnv` 引用、
值写进 `.env`（内联密钥会在启动期被直接拒绝），然后把 `dsh.provider` 指到对应
路由名即可。机制与完整示例见 qqbot.yml 的 `models:` 节注释；字段语义以 DSH 的
[配置目录](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/config-catalog.md)
为准。

---

## 它特别处理了什么

QQ 机器人的约束比看起来紧得多。挑几条最有代表性的（完整清单见 [DESIGN](docs/DESIGN.md)）：

| 平台约束 | 处理方式 |
|---|---|
| 被动窗口只有**群聊 5 分钟 / 单聊 60 分钟**，每条消息最多回 **5 / 4 次** | 回复配额账本 + 进度回执，永远给最终答案留配额；`msg_seq` 统一分配避免平台去重 |
| `session/prompt` **没有 resume 语义**，进程重启必失忆 | 桥接层自维护对话记录，runtime 重建时按边界标记回放 |
| 被 @ 时**看不到群里刚才在聊什么**（DSH 只记得与 bot 的往来） | **观察窗口**：静默记录白名单群的每条消息（含 bot 自己的回复），被 @ 时把当前话题注入 prompt；纯内存、不落盘、不依赖主动发言开关 |
| 上下文里的 `[图片: x.jpg]` **只是占位**，所以"群里先发图、再 @ 问这是什么"永远答不出来 | 窗口条目额外留下**媒体引用**（url + fileId），被 @ 时按配额（`observation.injectImages` 默认 2 / `injectFiles` 默认 1）取**最近**的那几张走与当前消息同一条下载链路，并在 prompt 里指认"#1 = [谁] 的「[图片: x.jpg]」"；旁听期间一个字节都不下载 |
| `initialize.cwd` 是**进程级**的 | 一会话一进程一工作区，会话之间互相看不到文件 |
| **转发消息块（合并转发）** 的内容要么内联在事件里、要么只有一个 id 得回查 | 优先用上报里已内联的逐条内容（NapCat 的 `forward.data.content`），只有拿到 id 时才调 `get_forward_msg`；展开成带条号与发言人的逐条文本再并进正文——只有这样才能让对话记录、冷启动回放、话题判定与命令匹配看到同一份内容；失败退回 `[聊天记录]`，且**转发块里的 @ 不算提及** |
| 别人转发的**聊天记录**一股脑灌进上下文会跑题又烧 token | 旁听消息里的记录**只留 id**（正文里是 `[转发消息]（内容未读入）`）；被 @ 且这次的问题明确提到它时，才由话题判定那一次调用顺带判出并回查（`fetchForward`，复用同一套上限与 LRU），取不到就明说"没读出来"、不让模型猜 |
| 19 位消息 id 过一遍 `Number()` 会丢精度，而 NapCat 恰好优先取 `message_id` | 动作参数按**能否无损往返**决定类型（大 id 原样传字符串）；真机症状是聊天记录永远只剩 `[聊天记录]` 占位 |
| 用户发来的**文件**是字节、模型读不了 | 落 `inbox/` 供 agent 深挖 + 抽取正文（PDF 走 `pdftotext`），以不可信内容边界进 prompt；解析器缺失自动降级 |
| **长截图**整张缩下去只剩 185px 宽，文字读不出 | 按「每块 ≤ 模型单图 64 万像素预算」**原生分辨率切片**（`attachments.maxImageTiles`，默认 12），块内不再重编码；切不完的部分在正文里明说"其余未读入" |
| 单边 > 8192 / 像素 > 6400 万 / 字节超限的图被 runtime 整条拒收 | 先解码探测真实像素，再降采样/重编码到准入范围内；只有**解不开**的字节才不内联（否则整条 prompt 会被拒） |
| 一轮产出多个文件会刷屏 | 自动打包成单个 zip 发一条；只发本轮新产生的文件 |
| 主动推送能力官方已停用 | 收敛成一个平台能力：官方层 do nothing，社区框架直接发，**外层一条逻辑** |

## 权限模型（请务必了解）

**workspace-write + 无人值守审批桩**：agent 在工作区内可自由读写执行；工作区之外由沙箱挡住；
无头环境里的审批由桩自动放行（否则工具调用会被 fail-closed 拒绝）。

⚠️ **关键前提**：沙箱需要可用后端（Linux 上 `bwrap` 或 `Landlock`）。两者都不可用时，
`workspace-write` 会退化为**事实上的完全访问**——此时容器本身（只读根文件系统、
`cap_drop: ALL`、资源上限、非 root）才是真正的边界。确认你的部署属于哪种：

```sh
docker compose run --rm --entrypoint node qqbot scripts/verify-sandbox-capability.mjs
```

`SANDBOX-EFFECTIVE` = 边界有效；`DEGRADED` = 已降级（处置见 [DEPLOY 第 5 节](docs/DEPLOY.md)）。
残余风险（agent 可执行任意代码并出网、API Key 在容器内可见）见 [DESIGN 6.4](docs/DESIGN.md)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | 方案设计：架构、多接入模型、协议契约、硬约束落地、权限与安全 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 部署手册：从零到跑通，含框架选型与调参建议 |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | 排障手册：按症状组织的排查流程（主动发言见 §5） |
| [SCENES.md](src/pipeline/proactive/interests/SCENES.md) | **主动介入场景的自然语言真相源**：什么情况下会说、典型对话、红线 |
| [proactive/README](src/pipeline/proactive/README.md) | 主动发言模块：能力收敛、三层判定架构、降级链 |
| [proactive/AGENT-CONTRACT](src/pipeline/proactive/AGENT-CONTRACT.md) | 扩展契约（给 agent 读）：新增介入规则 / 新增平台 / 改场景表 |
| [PROACTIVE-INTERVENTION-ARCH](docs/PROACTIVE-INTERVENTION-ARCH.md) | 主动介入架构方案：5 场景 → 三段式架构、取舍与未实现项 |
| [WAIT-CONVERGENCE-REQUIREMENT](docs/WAIT-CONVERGENCE-REQUIREMENT.md) | 需求：`wait`（延迟重查）的收敛——票据化、三类理由、唤醒前本地判断、11 条验收 |
| [TOPIC-SESSION-REQUIREMENT](docs/TOPIC-SESSION-REQUIREMENT.md) | 需求（**已实施**）：用「话题 session + 发言预算」替代旧的每话题一次闸门（预算 2 / 静默 10 分钟关闭 / 不做 topicChange） |
| [NEW-CONTENT-REQUIREMENT](docs/NEW-CONTENT-REQUIREMENT.md) | ~~已作废~~：本地信号集方案（被上一份取代，保留作"被否掉的方案"记录） |

## 开发

```sh
npm install
npm run typecheck
npm test                 # 离线单测：不触网、不启动 DSH 子进程
```

**改了东西要怎么生效**（没有热更新，但只有改后端代码才需要重建镜像）：

| 改动 | 命令 | 重建镜像 |
|---|---|---|
| `src/**` 后端代码 | `docker compose up -d --build` | 是 |
| `.env`（密钥 / 开关 / 白名单） | `docker compose up -d` | 否 |
| `qqbot.yml`、`interests.yml`（挂载的配置） | `docker compose restart qqbot` | 否 |
| 某个会话的规矩（工作区里的 `AGENTS.md`） | 直接写文件，连重启都不用 | 否 |
| 某个会话的人设风格（`/persona <名>` 命令） | 群里发命令，下一条消息生效 | 否 |
| 新增人设预设（`dsh-profile/personas/*.md`） | 直接加文件，`/persona` 立刻列得出 | 否¹ |

> ¹ `dsh-profile/` 打进镜像但预设目录默认经 `personas.dir` 指向它；用官方镜像时在容器里
> 加文件（或把目录 mount 出来改），都不需要重建镜像。

> `.env` 是**容器创建时**注入的：`restart` 不会重读它，所以那一行必须是 `up -d`。

**永远不需要 `docker compose down`**。想跳过镜像构建调试：用 `docker-compose.dev.yml`
挂本地 `dist`（见 [DEPLOY 第 8 节](docs/DEPLOY.md)）。

### 容器内验证脚本（需要真实 `DEEPSEEK_API_KEY`，会调用一次模型）

```sh
docker compose run --rm --entrypoint node qqbot scripts/smoke-dsh.mjs       # 端到端驱动一轮 DSH
docker compose run --rm --entrypoint node qqbot scripts/smoke-web-fetch.mjs # 验证 web_fetch 真能抓到正文
docker compose run --rm --entrypoint node qqbot scripts/verify-sandbox.mjs  # 判定沙箱是否真闸
docker compose run --rm --entrypoint node qqbot scripts/probe-dsh.mjs       # 诊断 profile 组合问题
docker compose run --rm --entrypoint node qqbot scripts/probe-dual-session.mjs # 同进程双会话是否真并发（双通道方案前提）
```

## 目录结构

```
docker-compose.yml       生产部署入口（qqbot.yml / interests.yml 以只读方式挂进来）
docker-compose.dev.yml   开发覆盖：挂本地 dist，跳过镜像重建
.env.example             密钥与个人标识样例（不含行为参数）
qqbot.yml                行为配置（随仓库提供 = 默认值，带注释直接用）

src/config.ts            env + qqbot.yml 三层合并 + 语义校验 + 启动期快速失败
src/config-file.ts       qqbot.yml 读取与形状校验（未知键名直接报错）
src/core/                接入层契约：BotConnector / 归一化事件 / 内容片段（编排层只依赖这里）
src/adapters/            接入平台：qq-official（官方）/ onebot（社区框架）
src/dsh/                 DSH 桥接：JSON-RPC 客户端 / 子进程监督 / 进程池 / turn 归并 / 图片内联与长图切片
src/pipeline/            编排：调度 / 配额与进度 / 分段 / 并发原语（全平台共用一条链路）
                         ＋长任务提示注入（hints.ts，persona 纪律的桥接层补强）
src/pipeline/proactive/  主动发言聚集地：SCENES.md + 兴趣池 + 搜集/判定/否决/投递四层
src/store/               持久化：对话记录（JSONL）/ 事件去重 / 会话映射 / 路径布局
                         ＋观察窗口（window.ts，内存滚窗：被 @ 与主动判定共用的上下文源）
                         ＋人设选择（personas.ts：预设目录 → 工作区 AGENTS.md 标记区块）
dsh-profile/             DSH profile 补丁 + 自动审批桩
dsh-profile/personas/    预设风格前台：每个 <名>.md 是一个 /persona 可切换的人设
scripts/                 容器入口 + 验证脚本
tests/                   离线单测（738 条）
docs/                    方案设计 / 部署手册 / 排障手册
```

## 许可与来源

依赖 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）。
QQ 协议实现依据**实况官方文档**（<https://bot.q.qq.com/wiki/develop/api-v2/>），
不使用已停更的 `tencent-connect/bot-docs` 作为依据——详见 [DESIGN 第 9 节](docs/DESIGN.md)。
