# 部署手册

面向"在一台 Linux 服务器上把它跑起来"的完整步骤。全部操作为 `docker compose`
命令，**不需要在宿主机上安装 Node.js、pnpm 或任何项目依赖**。

---

## 0. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Linux x86_64 / arm64 | 需要内核支持 Landlock（≥ 5.13）或允许非特权 user namespace |
| Docker | 24+ | 需要 `docker compose` 子命令 |
| 内存 | ≥ 2 GB 可用 | 默认给容器 2 GB 上限；每活跃会话一个 DSH 进程 |
| 磁盘 | ≥ 5 GB | 镜像约 1.5 GB，另加会话日志与工作区 |
| 出网 | 可访问 `api.bot.qq.com` 与 `api.deepseek.com` | WebSocket 长连接是主动出网，**不需要公网 IP、域名或证书** |

**不需要**：公网入口、反向代理、TLS 证书、固定端口映射。

---

## 1. 准备 QQ 机器人

1. 到 <https://q.qq.com/qqbot/> 创建机器人，拿到 **AppID** 与 **AppSecret**。
2. 在控制台的**开发设置**里，把事件接收方式切到 **WebSocket**。
   - 如果用 Webhook，本 MVP 不支持（需要公网 HTTPS + 固定端口 + ed25519 验签）。
3. 记录你的 AppID / AppSecret。
4. 关于"能不能给别人用"：
   - **未认证**：机器人只能被管理员使用，且只能加进管理员自己创建的群；
   - **个人认证**：可公开使用，群数量上限 500；
   - **企业认证**：无此限制。
   - 开发调试可以在控制台配置最多 20 个**内部体验号码**，不受服务范围限制。

> ⚠ 被动回复窗口：**群聊 5 分钟 / 每条最多 5 次**，**单聊 60 分钟 / 每条最多 4 次**。
> 本程序已按此设计（进度回执 + 群聊/单聊各自的配额账本），请不要把
> `QQ_TURN_TIMEOUT_MS` 调到 300000 以上——配置层会直接拒绝（单聊虽然窗口更宽，
> 也沿用这个更保守的上限）。
>
> 单聊默认开启（`QQ_C2C_ENABLED=true`）；只想服务群聊就设为 `false`，
> 因为 `1<<25` 这个 intent 同时承载群聊与单聊，无法在订阅层区分。

---

## 2. 准备 DeepSeek API Key

到 <https://platform.deepseek.com/> 创建 API Key。

**强烈建议给这个 Key 设置消费上限**：agent 拥有容器内执行命令的能力，被 prompt
injection 影响时理论上可以读写并外发该 Key（见 `docs/DESIGN.md` 第 6.4 节）。

---

## 3. 部署

```sh
# 1) 取得代码
git clone <你的仓库地址> qqbot-dsh
cd qqbot-dsh

# 2) 写配置
cp .env.example .env                  # 只放密钥
$EDITOR .env                           # 至少填 QQ_APP_ID / QQ_APP_SECRET / DEEPSEEK_API_KEY
# qqbot.yml（行为参数）已在仓库里，就是默认配置；要改直接改，不用复制

# 3) 构建并启动
docker compose up -d --build

# 4) 看日志
docker compose logs -f qqbot
```

> 如果 `up` 报 `can't set distinct values on 'pids_limit' and
> 'deploy.resources.limits.pids'`，说明资源限制被同时写在了顶层旧式字段与
> `deploy.resources.limits` 两处。本仓库的 `docker-compose.yml` 已统一放在
> `deploy.resources.limits` 下；手动改过该文件的话请只保留一处，详见
> [RUNBOOK 6.0](RUNBOOK.md)。改完用 `docker compose config >/dev/null` 先验证。

启动成功的日志特征（JSON 行，逐行）：

```json
{"level":"info","msg":"存储目录就绪", ...}
{"level":"info","msg":"已获取 access_token","expiresInSec":7200,...}
{"level":"info","msg":"连接 QQ 网关","url":"wss://api.bot.qq.com/websocket/","mode":"identify"}
{"level":"info","msg":"网关就绪（READY）","sessionId":"...","bot":"..."}
{"level":"info","msg":"qqbot-dsh 已就绪，等待群聊/单聊消息"}
```

容器入口还会打印沙箱后端自检结果：

```
[entrypoint] 沙箱后端：bubblewrap 已安装（workspace-write 可真正生效）
```

或（需要关注）：

```
[entrypoint] 警告：未找到 bubblewrap！workspace-write 无法执行命令，
[entrypoint]        DSH 将请求提权到 danger-full-access，实际权限=完全访问。
```

### 3.1 社区框架接入（OneBot，免审核）

官方不对个人开发者开放审核时，用 LLBot（LuckyLilliaBot，原 LLOneBot）或 NapCat
等 OneBot v11 实现接入（设计细节见 [DESIGN.md 第 10 节](DESIGN.md)）。

**推荐拓扑：框架原生跑在宿主 macOS，bot 留在 Docker。** 这也是 macOS 上唯一能
用上「有头模式」的形态——有头模式要在容器里拉起真实 QQ 客户端并需要
`privileged`，而官方 FAQ 明确说 macOS 上用 Docker Desktop 会「QQ 无法启动」
（建议 OrbStack）。

#### 3.1.1 装 LLBot（宿主，有头模式）

LLBot 官方支持 **macOS 12 及以上**，两个包：

| 包 | 特点 |
|---|---|
| `LLBot-Desktop-macos-arm64.tar.xz` | 图形界面、可视化配置、实时日志；新手优先 |
| `LLBot-CLI-macos-arm64.tar.xz` | 命令行，`./llbot --help` 看参数 |

从 [LuckyLilliaBot Releases](https://github.com/LLOneBot/LuckyLilliaBot/releases)
下载（Mac mini 是 Apple Silicon，选 `arm64`），解压到固定目录：

```sh
xattr -dr com.apple.quarantine .   # macOS 会拦未签名二进制，第一次打不开就是它
./start.sh                          # 首次运行（CLI 版）
./llbot                             # 之后启动；或 ./llbot --qq <QQ号> 免扫码快速登录
```

**有头模式是默认的**，不需要任何开关：它由 `bin/pmhq/pmhq_config.json` 里的
`headless` 字段控制，默认 `false` = 拉起真实 QQ 客户端。想改用无头模式（纯协议复刻、
不需要 QQ 客户端，但官方称掉线率更高）才把它设成 `true`。

两个同机部署必踩的坑：

1. **WebUI 默认端口 3080 与 DSH 的 Web GUI 冲突**（两者都默认 3080，同机必然撞）。
   首次登录前改 `bin/llbot/default_config.json` 里的 `webui.port`；已经登录过则改
   `bin/llbot/data/config_<你的QQ号>.json`。改成 3081 之类即可，改完再启动。
2. **有头模式需要图形会话**：它要拉起 QQ 客户端。Mac mini 如果没人登录图形界面
   （纯 SSH 使用），QQ 起不来——要么先用屏幕共享/VNC 登录一次图形会话，要么改用
   无头模式。

登录：二维码的网址与文件路径会打印在终端，也可以直接开 WebUI 登录。用**专门小号**。

> Auth token：官方的 Docker 安装脚本把 <https://auth.luckylillia.com> 的 token 设为
> 必填（有头模式下给 pmhq 用）。原生包是否也需要、以及会不会引导你填，我没能核实
> （官方 CLI 说明文档里没提）——按首次启动的提示走。

#### 3.1.2 配 bot 侧

`.env`（密钥）：

```sh
ONEBOT_ACCESS_TOKEN=$(openssl rand -hex 32)
DEEPSEEK_API_KEY=...
```

`qqbot.yml`（行为参数，仓库自带）：

```yaml
connectors: [onebot]        # 或 [qq-official, onebot] 与官方通道并存
onebot:
  host: 0.0.0.0             # ⚠ 别改成 127.0.0.1，原因见下面
  port: 6700                # ⚠ 别改：compose 的端口映射写死了 6700
```

`docker-compose.yml` 里的 6700 端口映射**默认已经打开**（只绑 `127.0.0.1`，
局域网内其他设备也连不上），直接：

```sh
docker compose up -d --build
```

这条拓扑的连通路径：

```
LLBot（宿主原生）──ws://127.0.0.1:6700/...──▶ 宿主 127.0.0.1:6700
                                                    │ Docker Desktop 端口转发
                                                    ▼
                                              容器内 0.0.0.0:6700
```

> ⚠ **不要**把 `qqbot.yml` 里的 `onebot.host` 改成 `127.0.0.1`。宿主看到的
> `127.0.0.1:6700` 是 Docker 的端口转发，它落到**容器网卡**上；容器里若只绑
> loopback，转发就够不到，症状是"端口映射看着正常但框架死活连不上"。保持
> 默认的 `0.0.0.0`，安全性由宿主侧那个 `127.0.0.1:` 前缀保证。
>
> 同理，LLBot 侧填 `127.0.0.1` 是对的，**不要**填 `host.docker.internal`
> ——那是反方向（容器访问宿主）才用的名字，从这里连反而连不上。

启动顺序建议**先起 bot 容器、再起 LLBot**，这样 LLBot 首次配好反向 WS 时端口已经
在监听。容器重启后 LLBot 若不自动重连，在它的 WebUI 里把那条反向 WS 关掉再启用一次
即可（我们的接入层接受任意时刻重连）。

#### 3.1.3 在 LLBot 里加一条反向 WebSocket

WebUI（登录后）里启用 **OneBot 11 → 反向 WS**，或直接改
`bin/llbot/data/config_<你的QQ号>.json` 的 `ob11.connect`：

```json
{
  "type": "ws-reverse",
  "enable": true,
  "url": "ws://127.0.0.1:6700/onebot/v11/ws",
  "token": "与 .env 里 ONEBOT_ACCESS_TOKEN 完全相同的值",
  "reportSelfMessage": false,
  "reportOfflineMessage": false,
  "messageFormat": "array",
  "debug": false,
  "heartInterval": 30000
}
```

几处是有意的，别改：

- `ws-reverse` —— LLBot 当客户端连我们（本项目的接入层是 WS server）；
- `token` 必须与 `.env` 的 `ONEBOT_ACCESS_TOKEN` **一致**，不一致会在握手阶段被 401 拒绝；
- `messageFormat: "array"` —— 两种格式我们都支持，array 更规范；
- `reportSelfMessage: false` —— 我们另有防自触发兜底；
- `heartInterval: 30000` —— 低于我们 150 秒的「通道僵死」阈值，不会误报。

URL 路径随便是多少都行：我们只校验 token，不校验路径。

#### 3.1.4 验证

```sh
docker compose logs -f qqbot | grep -i onebot     # OneBot 反向 WS 已监听 → 客户端已连入 → 框架已就绪
docker compose exec qqbot node dist/health-probe.js && echo HEALTHY
```

健康检查里 `connectors.onebot.state` 应为 `connected`（`listening` = 我们在等、
框架没连上，回去查 URL 与 token）。

> ⚠ 社区框架（无论有头/无头、宿主/容器）都基于 NTQQ 协议，存在账号风控/封禁风险，
> 请用专门小号。这是平台风险，与本项目代码无关。
> 拉群邀请默认不自动同意（`ONEBOT_AUTO_ACCEPT_GROUP_INVITE=false`），
> 需要机器人进新群时先打开，进完再关回去。

#### 3.1.5 如果以后想让框架也进容器

官方提供一键脚本（会自动生成 compose）：

```sh
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/LLOneBot/LuckyLilliaBot/refs/heads/main/script/install-llbot-docker.sh -o llbot-docker.sh \
  && chmod u+x ./llbot-docker.sh && ./llbot-docker.sh
```

但 macOS 上要注意两点：官方在安装页直接写了 **「macOS: 推荐 OrbStack，避免
Docker Desktop」**；而且要迁运行时的话，你现有的容器与卷不会自动跟过去。
两条容器化路线里，**直连模式（纯协议，不需要 `privileged`）在 Docker Desktop 上是
能跑的**，有头（PMHQ，需 `privileged`）不行——本仓库曾配好过一版直连模式的
compose 服务，后来按"先试宿主有头模式"的决定摘掉了，需要时可以再恢复。

---

## 4. 验证

```sh
# 健康检查：ok=true 才说明真的连上了 QQ 网关
docker compose exec qqbot node dist/health-probe.js && echo HEALTHY

# 看完整状态与计数
docker compose exec qqbot node -e "
fetch('http://127.0.0.1:8080/metrics').then(r=>r.text()).then(console.log)"
```

在群里 @机器人 发一句（或直接私聊机器人，效果相同）：

```
@机器人 用 python 算一下 1 到 100 的平方和，把脚本存到工作区
```

预期：
1. 约 90 秒内如果还没做完，会先收到一条"仍在处理中…"；
2. 随后收到结果；
3. 容器内确实出现了脚本文件：

```sh
docker compose exec qqbot find /data/workspaces -name '*.py' -o -name '*.txt' | head
```

4. 重启容器后追问，仍能记得上文（对话记录回放生效）：

```sh
docker compose restart qqbot
# 群里问：刚才那个脚本在哪？
```

---

## 5. 沙箱后端验证（重要）

这一步决定"workspace-write 是一道真闸"还是"只是一句口号"。

```sh
docker compose run --rm --entrypoint node qqbot scripts/verify-sandbox-capability.mjs
```

两种结果：

| 输出 | 含义 | 处置 |
|---|---|---|
| `VERDICT: SANDBOX-EFFECTIVE` | 有可用后端（bwrap 或 landlock） | 无需处理，工作区边界真实有效 |
| `VERDICT: DEGRADED` | 没有可用后端 | 见下 |

`DEGRADED` 时的选择：

1. **放开非特权 user namespace**（让 bwrap 能用）。在宿主机上：
   ```sh
   sudo sysctl -w kernel.unprivileged_userns_clone=1
   ```
   或给容器加 `--security-opt seccomp=unconfined`。
   ⚠ 这会削弱容器的隔离，请自行权衡。
2. **确认 Landlock 可用**：需要内核 ≥ 5.13 且 LSM 里启用了 landlock
   （`cat /sys/kernel/security/lsm`）。多数现代发行版默认启用。
3. **接受降级**：保持 `allowEscalation: true`（默认），依赖容器边界
   （只读根文件系统、cap_drop、资源上限、非 root）。此时 agent 在容器内
   拥有完全访问权限。
4. **拒绝降级**：把 `dsh-profile/cordis.patch.yml` 里 `allowEscalation` 改成
   `false` 并重建镜像。提权会被拒绝，但**机器人也将无法执行任何命令**。

---

## 6. 常用运维命令

```sh
docker compose logs -f qqbot                 # 跟踪日志
docker compose restart qqbot                 # 重启（会话记忆靠回放恢复）
docker compose down                          # 停止（卷保留）
docker compose down -v                       # 停止并删除所有数据（清空记忆与工作区）
docker compose up -d --build                 # 改代码后重建

# 进入容器手动排查
docker compose exec qqbot bash
docker compose exec qqbot ls -la /data/workspaces /data/bot
docker compose exec qqbot tail -20 /data/bot/conversations/*.jsonl

# 查看资源占用（每活跃会话一个 DSH 进程）
docker compose exec qqbot ps -ef
docker stats qqbot-dsh
```

---

## 7. 调参建议

编辑 `qqbot.yml` 后 `docker compose restart qqbot` 生效；改 `.env`（密钥）用
`docker compose up -d`。两者都不需要重建镜像。

下表给的是**环境变量名**（它们优先于 `qqbot.yml`，所以临时覆盖最方便），
但日常改配置请改 `qqbot.yml` 里对应的项——对应关系见每节的注释，例如
`QQ_MAX_RUNTIMES` ↔ `pool.maxRuntimes`、`QQ_MAX_CHARS` ↔ `qq-official.maxChars`。
要用环境变量覆盖，写进 `.env` 即可（它会被整份注入容器），或加到
`docker-compose.yml` 的 `environment` 段。

> **`.env` 是整份注入的**，好处是以后新增字段不用同时改 compose；代价是文件里
> 任何一行格式不对都会让**容器创建**失败。最典型的是"一行全是 `="——从 Markdown
> 预览里复制配置时，`# =====` 会被当成标题、`#` 被吃掉，然后 Compose 按第一个 `=`
> 切开得到"变量名为空"的条目，报 `invalid environment variable: =====...`，
> 完全看不出该改哪一行。
>
> 自查与修复见 [RUNBOOK 1.2](RUNBOOK.md)；仓库里的 `.env.example` 分隔线已改用
> 短横线（裸的 `----` 行会被 Compose 忽略），从它复制不会再踩这个坑。

| 场景 | 调整 |
|---|---|
| 模型回答太慢/太贵 | `DSH_MODEL=deepseek-flash`（默认，最快）；需要更强推理换 `deepseek-v4-pro` |
| 群里人多、并发高 | 提高 `QQ_MAX_CONCURRENT_TURNS`，同时提高 compose 里的 `cpus`/`memory` |
| 容器内存紧张 | 降低 `QQ_MAX_RUNTIMES`（更频繁地回收 runtime，代价是更频繁的历史回放） |
| 不想让机器人记很久之前的事 | 降低 `QQ_REPLAY_TURNS`（0 = 完全不回放，重启即失忆） |
| 回答太长被截断 | 提高 `QQ_MAX_CHARS`，但注意平台上限未知（超限会报 40054007 并自动折半重试） |
| 希望代码块渲染更好看 | `QQ_MSG_TYPE=2`（Markdown）。注意部分客户端版本渲染效果不稳定 |
| 只想服务群聊，不接受私聊 | `QQ_C2C_ENABLED=false`（`1<<25` 无法只订群聊，只能在这里关） |
| 单聊回复条数不够 | 调小 `QQ_C2C_PROGRESS_MAX`；上限 `QQ_C2C_MAX_REPLIES_PER_MSG=4`，不能再高 |
| 日志太吵 | `QQ_LOG_LEVEL=warn` |
| 图片烧 token / 模型不支持图片 | `BOT_ATTACHMENT_ENABLED=false`（消息照收，图片变成 `[图片]` 占位） |
| 图片太多/太大读不进来 | `BOT_ATTACHMENT_MAX_IMAGES`（默认 4）、`BOT_ATTACHMENT_MAX_BYTES`（默认 8MB）；排查看 `/metrics` 里的 `imagesInlined`/`imagesSkipped`，见 [RUNBOOK 4.5](RUNBOOK.md) |
| 想给某个会话定规矩 | 在该会话工作区目录下写 `AGENTS.md`，DSH 会自动加载（改规则不用重建镜像） |

---

## 8. 改动的生效方式（要不要重建镜像？）

本项目**没有热更新**：后端代码编译进镜像，配置在进程启动时读取。但**不同层次的
改动代价差别很大**——只有前两种才需要重建镜像。

| 你想改的东西 | 需要做什么 | 需要重建镜像？ | 需要 `down`？ |
|---|---|---|---|
| 后端代码（`src/**`） | `docker compose up -d --build` | **是** | 否 |
| `package.json` 依赖 | `docker compose up -d --build` | **是**（要重跑 `npm install`） | 否 |
| `.env`（密钥） | `docker compose up -d` | 否（重建容器即可） | 否 |
| `qqbot.yml`（行为参数） | `docker compose restart qqbot` | 否 | 否 |
| `dsh-profile/cordis.patch.yml`（人设、权限模式） | `docker compose restart qqbot` | 否 | 否 |
| 某个会话的行为规矩（`AGENTS.md`） | 直接改文件 | **都不用** | 否 |
| `docker-compose.yml` 本身 | `docker compose up -d` | 否 | 否 |

**永远不需要 `docker compose down`。** `up -d --build` 会自己重建镜像并替换容器；
`down` 只用于"要改网络/端口映射，或想彻底停止服务"。注意 `down` 默认删容器但
保留卷（记忆与工作区不丢），加 `-v` 才会连数据一起删。

### 8.1 最省事的调优手段：改会话规矩不用碰容器

`AGENTS.md` 是最值得优先使用的调整方式。DSH 的 `dsh-agent-instructions` 按会话
惰性加载工作区里的指令文件，**文件变更会在后续请求中反映出来**（首次请求注入基线，
之后成功的读写操作会让新出现的指令文件生效）。

所以"这个群要按我们的代码规范回答"这类需求，直接写文件即可：

```sh
# 1) 找到该会话的工作区目录（目录名 = 会话键的 sha256 前 16 位；
#    群聊的会话键就是 group_openid，单聊是 c2c:<user_openid>）
docker compose exec qqbot ls /data/workspaces

# 2) 写规矩
docker compose exec qqbot sh -c 'cat > /data/workspaces/<hash>/AGENTS.md <<EOF
- 本群只讨论后端相关话题。
- 回答代码时统一用 Python 3.12 语法。
- 不要贴超过 30 行的代码，长内容写进工作区文件再告诉我文件名。
EOF'
```

### 8.2 改代码时的快速迭代（跳过镜像构建）

镜像重建里最慢的是 `npm install` + `tsc`。开发时用自带的覆盖文件跳过这一层：

```sh
# 终端 A：本地增量编译，改代码自动重编
npm install
npx tsc -p tsconfig.json --watch

# 终端 B：用本地 dist 覆盖镜像里的 dist
docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# 之后每次改完代码只需重启，不必重建镜像
docker compose -f docker-compose.yml -f docker-compose.dev.yml restart qqbot
```

`docker-compose.dev.yml` 把 `./dist` 与 `./dsh-profile` 以**只读**方式覆盖进容器，
所以改代码、改人设都只需重启。

**两个限制**：
- `node_modules` 仍来自镜像，改了 `package.json` 必须重建镜像；
- 绑定挂载要求容器内用户（uid 10001）能读到这些文件。原生 Linux 上若文件权限是
  `600` 会失败，用 `sudo chmod a+r -R dist dsh-profile` 修一下（本仓库的文件权限
  已归一化为 644/755）。

生产部署请回到普通的 `docker compose up -d --build`。

---

## 9. 联网能力：搜索能用但抓不到原文怎么办

### 9.1 现象与原因

典型症状：机器人**能搜索**，但被要求读某个具体网页时，会回一句类似
"我容器里抓不到原文（网络策略拦截），以上来自搜索结果标题"。

这句话是模型对工具报错的**推断**，不是真的网络被拦。真实原因在 DSH 的
HTTP 抓取后端（`@deepseek-ai/dsh-web-fetch-http`）：

1. 该 provider 发请求前会**自己解析域名**，并要求解析结果**全部是公网单播地址**，
   否则直接抛 `WEB_BLOCKED_URL`，**连请求都不发**。
2. 宿主（开发机/服务器）如果装了 fake-IP 模式的代理（Clash、Surge 一类），
   DNS 会把**所有**域名解析成 RFC2544 保留段 `198.18.0.0/15`：

   ```sh
   # 在宿主上执行，看到 198.18.x.x 就说明命中了这个坑
   node -e "require('dns').promises.lookup('example.com',{all:true}).then(console.log)"
   # [ { address: '198.18.0.52', family: 4 } ]
   ```

   `198.18.0.0/15` 不是公网单播地址，于是**每次 web_fetch 都被自家策略拦下**。
   Docker Desktop 的 DNS 转发到宿主解析器，容器里解析出来是同一批 fake IP。

**注意区分两条链路**：
- `web_search` 走的是 **DeepSeek 服务端搜索**，只回标题/URL/摘要，与容器出网无关，
  所以它一直是好的；
- `web_fetch` 才是容器自己发请求的那个，被上面的校验挡住。

### 9.2 解决办法：显式配置 HTTP 代理

`dsh-web-fetch-http` 只有在**目标命中代理策略**时才会跳过 DNS 与公网地址校验
（交给代理解析源站）。`dsh` 启动器在 boot 时会读取标准代理环境变量并安装全局
dispatcher，所以只需在 `docker-compose.yml` 的 `qqbot.environment` 里给出：

```yaml
      HTTPS_PROXY: http://host.docker.internal:7897
      HTTP_PROXY: http://host.docker.internal:7897
```

配套的 `extra_hosts: ["host.docker.internal:host-gateway"]` 也要在（Linux 原生
Docker 没有 `host.docker.internal` 这个名字，靠它补上；Docker Desktop 自带）。

**三个必须注意的点**：

1. **端口要对**：`7897` 是 Clash 的 HTTP/混合端口，常见值还有 `7890`。换端口只改
   这两行。必须是 **HTTP(S) 代理**——`dsh-http-proxy` 不支持 SOCKS/PAC，遇到这类
   值会打一条诊断然后跳过（表现为"设了也没用"）。
2. **不要把想抓取的站点写进 `NO_PROXY`**。`no_proxy` 命中的 URL 会退回直连分支，
   公网 IP 校验重新生效，又变成 `WEB_BLOCKED_URL`。实测：

   ```sh
   NO_PROXY=example.com  →  example.com 抓取失败（WEB_BLOCKED_URL）
   NO_PROXY=example.com  →  baidu.com   抓取成功（走代理）
   ```
3. **代理变量不要写进项目根目录的 `.env`**。`dsh` 启动器对项目 `.env` 里的代理
   名字有 fail-loud 守卫（怕仓库决定流量去向），写进去会**拒绝启动**。要覆盖就用
   `docker-compose.yml` 的 `environment`，或 `$DSH_HOME/.env`（容器内
   `/data/dsh/.env`，属"用户级默认值"层）。

### 9.3 改了之后怎么确认

```sh
# 1) 配置已进容器
docker compose exec qqbot env | grep -i proxy

# 2) 代理可达（这一步不通，web_fetch 一定不通）
docker compose exec qqbot curl -sS -o /dev/null -w '%{http_code}\n' \
  -x http://host.docker.internal:7897 https://example.com

# 3) 一次性端到端自检（真的驱动 dsh 抓一个网页并核对正文）
docker compose exec qqbot node scripts/smoke-web-fetch.mjs

# 4) 或者在群里发一条"帮我读一下 <某个具体网址> 的正文并总结"
```

第 3 步会花掉一次真实模型调用（约十几秒），它断言四件事：`web_fetch` 被调用、
回复里出现了目标页面正文独有的字符串、回复里没有 `WEB_BLOCKED_URL` 一类失败措辞、
协议通道全程干净。全 PASS 时会打印 `--- 失败项 ---（无）`，退出码 0。

**代价与回退**：设了代理后，宿主的代理进程成为**硬依赖**——代理没起来时
`web_fetch` 会直接失败（报 `WEB_FETCH_TIMEOUT` / `WEB_PROVIDER_ERROR`），而不再是
静默降级。想回退就删掉那两行并 `docker compose up -d`。

**若代理不可用时的兜底**：容器内 `curl` 本身能出网，可以在会话工作区写个
`AGENTS.md` 规则，让模型在 `web_fetch` 报 `WEB_BLOCKED_URL` 时改用 shell 抓取。
但这条路径绕开了 DSH 的受限输出与 HTML→Markdown 转换，回答质量更差，只当止血用。

---

## 10. 升级

```sh
git pull
docker compose up -d --build
```

**关于会话记忆**：升级/重启后 DSH 会话是新建的，上下文由
`/data/bot/conversations/*.jsonl` 回放恢复。所以升级不会丢记忆，但会替换
`DEEPSEEK_API_KEY` 之外的所有运行时状态。

**关于 DSH 版本**：`package.json` 里 `@deepseek-ai/dsh` 是**精确版本**
（`0.1.5-rc.2`）。本项目依赖 DSH 的 stdio JSON-RPC 协议；协议只有 3 个方法
且我们会在 `initialize` 时校验服务端身份，所以升级 DSH 后如果协议有变会在启动
日志里明确报错，不会静默出错。升级前建议先在测试环境跑一遍
`docker compose run --rm --entrypoint node qqbot scripts/smoke-dsh.mjs`。

---

## 11. 卸载

```sh
docker compose down -v          # 删除容器与所有卷（工作区、会话日志、对话记录）
docker rmi qqbot-dsh:0.1.0      # 删除镜像
```
