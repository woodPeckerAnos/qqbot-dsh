# 云主机部署（云平台无关）

本文件是 `feat/cloud-migration` 分支上的**本地评估稿**：只描述"把现有 Docker
部署迁到任意一台 Linux 云主机"需要动什么、怎么验证、怎么回滚。不绑定任何
云厂商资源（VPC / 负载均衡 / 对象存储 / 托管数据库都不需要）。

结论：**应用代码不需要改**。它是主动出网的 WebSocket 客户端，官方接入不需要
公网 IP、域名或 TLS 证书。上云的主要工作是部署配置、NapCat 容器化、数据
迁移和风控配套。

---

## 1. 运行盘点

| 项 | 现状 |
|---|---|
| 运行时 | Node.js 24（镜像 `node:24-bookworm-slim`），`package.json` 要求 ≥22.4 |
| 进程 | 1 个主进程 `node dist/main.js` + 每个活跃会话一个 `dsh` 子进程（LRU，默认上限 8） |
| 依赖 | `@deepseek-ai/dsh`（精确版 0.1.5-rc.2）、`sharp`、`ws`、`yaml`；构建期另需 typescript |
| 监听端口 | `8080` 健康检查（容器内）；`6700` OneBot 反向 WS（仅回环） |
| 出网 | `api.bot.qq.com`（官方 WebSocket 网关）、`api.deepseek.com`（默认模型/搜索）、可选 `ark.cn-beijing.volces.com`（模型路由或联网搜索走方舟时）、可选 HTTP 代理 |
| 数据 | `dsh-home`（DSH 会话日志与 profile）、`workspaces`（每会话工作区）、`bot-state`（对话记录/去重/会话映射/人设/谷时段覆盖/后台待投递） |
| 配置 | 仓库内 `qqbot.yml` + `config/*.yml` + `dsh-profile/`（profile 补丁、人设、审批桩）只读 bind mount；`interests.yml` 同理；`config/local/*.yml` **不进 git** |
| 密钥 | 只从 `.env` 注入：`QQ_APP_ID` / `QQ_APP_SECRET` / `DEEPSEEK_API_KEY` / `ONEBOT_ACCESS_TOKEN`（按启用的接入与模型路由判断是否必需），另有 `BOT_ADMINS`、`BOT_LISTEN_GROUPS` 等个人标识 |
| 启动 | `scripts/entrypoint.sh`：目录与权限 → 幂等初始化 DSH profile → 沙箱后端自检 → 必需 env 检查 → `exec node dist/main.js` |
| 停止 | SIGTERM → 先停连接器 → 等在处理的 turn（最多 30s）→ 逐级关闭 DSH runtime（15s） |
| 健康 | `/healthz`：**至少一个接入连接器已建立事件通道**才 200；`/metrics`：JSON 计数。容器 HEALTHCHECK 用 `node dist/health-probe.js` |
| 加固 | 只读根文件系统、`/tmp` tmpfs、`cap_drop: ALL`、`no-new-privileges`、非 root uid 10001、2 CPU / 2GB / 512 pids |
| CI | GitHub Actions：类型检查 + 单测（793 项，全离线）+ 构建镜像 + 入口快速失败 + 沙箱能力检查 |

叠加 `docker-compose.napcat.yml` 后多一个独立 sidecar：

| 项 | NapCat sidecar |
|---|---|
| 镜像 | `mlikiowa/napcat-docker`（Linux QQ + Xvfb，amd64/arm64） |
| 作用 | QQ 登录与 OneBot 协议端，作为 WS 客户端连 `qqbot:6700` |
| 数据 | `napcat-qq`（登录态/设备信息）、`napcat-config`（账号与网络配置）、`napcat-plugins` |
| 端口 | 仅 `127.0.0.1:6099` WebUI；无公网入站 |
| 资源 | 镜像约 2.1GB 磁盘；常驻内存按 Electron QQ + Xvfb 估算约 0.5–1GB（官方未给最低值，上线后用 `docker stats` 实测为准） |

### 本地已验证

- `npm run typecheck`：通过
- `npm test`：37 个文件 / 793 项全部通过
- `npm ci --dry-run --no-audit --no-fund`：退出码 0，锁文件与 `package.json` 一致
- 代理空值语义：直接调用 `@deepseek-ai/dsh-http-proxy`，`HTTPS_PROXY=""`
  解析为直连（`proxied:false`），非空才走代理
- compose 覆盖层合并：`docker compose -f docker-compose.yml -f docker-compose.cloud.yml config`
  输出中代理为空、8080 仅绑 `127.0.0.1`
- NapCat 覆盖层合并：`docker compose -f docker-compose.yml -f docker-compose.cloud.yml
  -f docker-compose.napcat.yml config` 退出码 0；`stop_grace_period` 为 1m30s，
  6700 / 8080 / 6099 全部只绑 `127.0.0.1`
- 合并环境核对：`WEBUI_TOKEN` 只出现在 NapCat（来自 `napcat.env`），
  qqbot 的 environment 中没有该键
- `scripts/cloud-preflight.sh --with-napcat`：分文件检查 `.env` 与 `napcat.env`；
  WebUI token 放错到 `.env` 会被拒绝；除本机 Docker daemon 未启动外无阻断项
- `scripts/volume-bundle.sh`：`bash -n` 通过；`verify` 正常批次通过、篡改后失败；
  `--dry-run` 输出解析后的绝对路径；缺 `--yes` 拒绝；缺少归档、归档未列入
  `SHA256SUMS`、卷集合/项目名不匹配都会在清卷前失败；用 stub `docker` 验证了
  backup/restore 遇到运行中容器会拒绝（真实 Docker 卷操作仍未实测）

未验证项统一列在 6.1，必须在云主机上执行，不能标为已通过。

---

## 2. 与本地部署的差异

### 2.1 代理（阻断项，已解决）

基础 `docker-compose.yml` 把 `HTTPS_PROXY/HTTP_PROXY` 硬编码到
`host.docker.internal:7897`（开发机上的 Clash/Surge）。云主机没有这个代理，
会让 `web_fetch` 等走 fetch 的调用失败。

`docker-compose.cloud.yml` 把两个变量置空。DSH 的代理策略把空串视为未设置
（已用包内 API 实测），因此恢复直连，且不需要改基础文件、不影响本地部署。

> 如果云主机确实需要出网代理，**不要**用这个覆盖层，改为建一个不入库的
> `docker-compose.site.yml` 覆盖 `environment`。代理变量不能写进项目根目录
> 的 `.env`：DSH 对项目 `.env` 里的代理名是 fail-loud 的。

### 2.2 优雅退出（已补）

覆盖层设置 `stop_grace_period: 90s`。应用自身最坏约 45s（30s 等在途 turn +
15s 关闭 runtime），Docker 默认 10s 会直接 SIGKILL，留下半条会话日志。

### 2.3 健康检查端口

基础 compose 刻意不映射 8080。覆盖层把它绑到 `127.0.0.1:8080`，供宿主监控
（cron、云监控 agent）使用，公网与同 VPC 其他机器都连不上。

### 2.4 镜像标签与回滚

基础镜像标签固定 `qqbot-dsh:0.1.0`，重复构建会覆盖同一个标签，没有历史。
覆盖层支持 `QQBOT_IMAGE_TAG`（写进 `.env` 即可被 compose 插值），建议每次
部署用日期或 git 短 SHA：

```sh
QQBOT_IMAGE_TAG=20261030-24dd7f0
```

### 2.5 构建架构

镜像里的 `sharp` 按构建机架构落可选依赖，Dockerfile 的 prune 会删掉异平台
包。**在 amd64 上构建的镜像不能直接跑在 arm64 云主机上**（反之亦然）。
要么在目标架构主机上构建，要么用 `docker buildx build --platform` 构建多架构
镜像并推送到任意 OCI 仓库。

### 2.6 构建可复现性（已实现，镜像构建未实测）

Dockerfile 现在同时拷贝 `package.json` 与 `package-lock.json`，
`scripts/docker-install.mjs install` 改为 `npm ci`：按锁文件精确安装，避免
不同时间构建装到不同小版本。目标架构构建、`sharp` 原生模块剪枝、入口脚本和
沙箱检查都没有改动。

本地验证：`npm ci --dry-run --no-audit --no-fund` 退出码 0，说明锁文件与
`package.json` 一致。**镜像构建本身未实测**（本机 Docker daemon 不可用），
需在云主机或 CI 上补一次 `docker build`。

### 2.7 镜像不是自包含的

`.dockerignore` 排除了 `config/`、`docs/`、`tests/`，运行时配置靠 bind mount
从宿主机仓库读取。所以云主机上必须保留一份仓库（至少 `qqbot.yml`、
`config/`、`dsh-profile/`、`interests.yml`），只 `docker compose pull` 起不来。

---

## 3. NapCat 进容器：资源与风控评估

### 3.1 拓扑

```
┌─────────────── docker compose ───────────────┐
│  napcat（Linux QQ + Xvfb + NapCat）           │
│      │ 反向 WS ws://qqbot:6700/...?token=... │
│      ▼                                        │
│  qqbot（Node + DSH 子进程）──出网──▶ QQ 网关/模型 │
└──────────────────────────────────────────────┘
```

**必须是独立容器，不能和 qqbot 同容器。** qqbot 里的 agent 能执行命令；
同容器等于把 QQ 登录态、NapCat 配置直接暴露给 agent。两者只通过
`qqbot-net` 内部 DNS 通信，NapCat 不发布 OneBot 端口。

### 3.2 资源占用

| 规格 | 结论 |
|---|---|
| 4 vCPU / 4GB（腾讯云） | **推荐**。qqbot 2GB + NapCat 1GB + 系统约 1GB = 4GB，配 2GB swap 更稳 |
| 2 vCPU / 4GB（阿里云） | **可运行下限**。CPU 更紧，构建镜像时必须先停服务；并发按默认 4/2 限制 |
| 2 vCPU / 2GB | **不够**。bot 的 2GB 上限就吃满主机，NapCat 起不来 |
| 磁盘 | ≥20GB。两个镜像约 1.5GB + 2.1GB，另加 QQ 缓存、工作区、会话日志 |

建议：

- 主机加 **2GB swap**（4GB 内存下 NapCat 的 Electron 峰值需要兜底）；
- 覆盖层已把 `QQ_MAX_RUNTIMES` 默认降到 **4**、`QQ_MAX_CONCURRENT_TURNS`
  默认降到 **2**；4C4G 可在 `.env` 里上调，2C4G 建议保持默认；
- 构建和运行错开：先 `docker compose build`，再 `up -d`，不要在 bot 跑着时构建；
  2C4G 更建议在 CI/本机构建后推 OCI 仓库，云主机只 pull；
- NapCat 上限 **1GB / 1.5 CPU / 512 pids** 已写进覆盖层，优先保护 bot 的
  2GB 配额；实测若被 OOM 杀掉，用 `docker stats` 看峰值再小幅调整。

### 3.3 风控：哪些因素会变、怎么稳住

NapCat 官方镜像的 entrypoint 已经做了一批容器特征清理（删除 `/.dockerenv`、
伪装 hostname、`/proc/1/*`、cgroup、DMI、mountinfo 等），但其中 `mount --bind`
需要 `CAP_SYS_ADMIN`，默认能力下会静默失败——**只能算部分生效**。为了提权去
开 `privileged` 不划算，安全代价远大于收益。

真正要守住的是下面这些：

1. **持久化 `/app/.config/QQ`**（`napcat-qq` 卷）。QQ 的设备标识、登录态、
   本地数据都在这里；容器重建但卷还在，设备身份就还在。这是最重要的一条。
2. **持久化 `/app/napcat/config`**（`napcat-config` 卷）。账号与 OneBot 配置，
   丢了要重新扫码，也会带来一次登录环境变化。
3. **固定镜像版本**。`latest` 会在某次 `pull` 后悄悄换 QQ/NapCat 版本，客户端
   版本本身就是可观察特征。覆盖层用 `NAPCAT_IMAGE_TAG` 钉死，升级前留旧镜像。
4. **固定 MAC 与 hostname**。覆盖层设置了 `mac_address` 和
   `hostname: qqbot-napcat`，避免每次 `up` 都换一组环境值。
5. **稳定公网出口 IP**。跨云迁移（腾讯 → 阿里）必然换 IP，这是最大的一次
   环境跳变。建议：先定平台再迁，迁一次到位；之后尽量不换地域/弹性 IP。
   不要为了"试试"反复在两个云之间搬。
6. **同一账号只跑一个实例**。双跑会互相顶下线，是最容易被判定异常的行为。
   迁移时先停源实例，再起目标实例，禁止并行。
7. **首登在最终主机上完成**。扫码/设备验证在哪个 IP 完成，后续就尽量保持
   那个环境；不要在本机登录后再把卷搬到云上。
8. **减少无谓重启/升级**。每次重建容器都会触发登录态复用，频繁重启本身
   就是异常信号；升级选低峰期，一次完成。
9. **账号与行为**。用专门小号；避免短时间大量加群/发消息/加好友；现有代码
   的回复配额与谷时段机制要继续保留。平台风控是概率问题，不能承诺零风险。

### 3.4 安全边界

- NapCat 容器**不挂** `docker.sock`，**不** `privileged`，不 `cap_add: SYS_ADMIN`；
- WebUI `6099` 只绑 `127.0.0.1`，通过 SSH 隧道访问；
- **WebUI token 只放 `napcat.env`**（`env_file` 仅 NapCat 读取），不放进 qqbot
  的 `.env`。qqbot 的 `.env` 会整份注入，DSH 子进程又继承环境变量；放一起等于
  把管理面口令交给 agent；
- 这隔离的是文件、登录态与凭据，**不是网络**：qqbot 与 napcat 同处
  `qqbot-net`，qqbot 仍能访问 `napcat:6099`。不要宣称管理面网络不可达；
  6099 只绑宿主回环是防公网入站，不是容器间 ACL；
- `napcat-config` 里有 OneBot token，`napcat-qq` 里有 QQ 登录态，两者都属于
  敏感数据，备份必须加密传输；
- 第三方镜像 `mlikiowa/napcat-docker` 属于供应链依赖：固定版本，升级前看
  Release，必要时固定 digest；
- `docker compose config` 可能把 `ONEBOT_URL` 里的 token 和 `env_file` 里的
  `WEBUI_TOKEN` 展开打印，排障时不要把输出原样贴到群里或日志系统。
- 改 `ONEBOT_ACCESS_TOKEN` 后要同步 NapCat：entrypoint 只在
  `onebot11.json` 不存在时生成反向 WS 配置，直接改 `.env` 不会更新它。
  在 NapCat WebUI 的「网络配置」里改 token，或停容器后删掉
  `napcat-config` 卷里的 `onebot11.json` 再启动（会重新生成）。

---

## 4. 部署步骤（任意 Linux 云主机）

下面命令统一使用三个 compose 文件，建议先定义一个函数，避免每次写全。
函数形式在 bash 和 zsh 中都可直接执行，不依赖 shell 对字符串变量的空格拆分：

```sh
COMPOSE() { docker compose -f docker-compose.yml -f docker-compose.cloud.yml -f docker-compose.napcat.yml "$@"; }
```

### 4.1 全新部署（没有旧数据）

```sh
# 1) 取得代码
git clone <repo> qqbot-dsh && cd qqbot-dsh
git checkout feat/cloud-migration        # 评估期；合并后换 main

# 2) 配置：qqbot 用 .env，NapCat 管理口令单独放 napcat.env
cp .env.example .env && chmod 600 .env
$EDITOR .env                              # 填密钥、BOT_ADMINS / BOT_LISTEN_GROUPS、
                                          # BOT_CONNECTORS=onebot（只用 NapCat 时）、
                                          # ONEBOT_ACCESS_TOKEN（不要写 WEBUI_TOKEN）
cp napcat.env.example napcat.env && chmod 600 napcat.env
$EDITOR napcat.env                        # 填 WEBUI_TOKEN；只由 NapCat env_file 读取

# 3) 前置检查（两个 env 文件就位后执行，避免必填项误报）
bash scripts/cloud-preflight.sh --with-napcat

# 4) 如果本机有 models 路由或本地覆盖，必须一起带过来（不进 git）
#    config/local/models.yml、config/local/*.yml

# 5) 固定镜像标签：build/create/up 必须用同一标签。
#    在同一 shell 里 export；建议同时固化到 .env，避免新 shell 丢变量。
export QQBOT_IMAGE_TAG="$(date +%Y%m%d)-$(git rev-parse --short HEAD)"
# echo "QQBOT_IMAGE_TAG=$QQBOT_IMAGE_TAG" >> .env

# 6) 构建（先构建，避免运行中构建抢内存）
COMPOSE build

# 7) 启动空卷
COMPOSE up -d

# 8) 看 NapCat 日志里的二维码并扫码登录
COMPOSE logs -f napcat

# 9) 验证
curl -s http://127.0.0.1:8080/healthz | head -40
```

### 4.2 迁移部署（先确认旧端形态，不能混用）

**A. 宿主原生 NapCat → 云 sidecar（当前主线）**：只迁 bot 三卷。原生 QQ 不在
Compose 里，脚本看不到它，必须先按原方式停掉；云端 NapCat 三卷保持空白，
在最终主机首登。

**B. 旧 sidecar → 新 sidecar**：才停完整 Compose、迁六卷。

两条路径的 `backup` / `restore` 必须使用同一组 `--volumes`，不能混用。

> 旧主机也要能运行本次分支的 `scripts/volume-bundle.sh`。它只是迁移工具，
> 不改变运行配置：可以只把该脚本拷到旧仓库（或 `git show` 出来），不必为了
> 迁移切换旧实例的代码/重启服务。旧主机还需预装 `age` 或 `gpg`。

#### 4.2A 宿主原生 NapCat（只迁 bot 三卷）

```sh
# --- 旧主机 ---
cd qqbot-dsh
# 1) 按原方式停原生 QQ（systemd / LaunchAgent / 手工退出都行），确认进程已退出
# 2) 停 bot：用旧主机原来的 compose 组合，下面以基础文件为例
COMPOSE_OLD() { docker compose -f docker-compose.yml "$@"; }
COMPOSE_OLD stop qqbot

# 3) 只备份 bot 三卷；不要带 napcat-*（旧端没有这三组卷）
bash scripts/volume-bundle.sh backup --project qqbot-dsh --out backups \
  --volumes "dsh-home workspaces bot-state"

# 4) 加密整包（接收方公钥；私钥只在目标机/离线介质）
tar -C backups -czf - <批次目录> | age -r <接收方公钥> > <批次目录>.tar.age
sha256sum <批次目录>.tar.age > <批次目录>.tar.age.sha256

# --- 新主机 ---
git clone <repo> qqbot-dsh && cd qqbot-dsh
git checkout feat/cloud-migration
COMPOSE() { docker compose -f docker-compose.yml -f docker-compose.cloud.yml -f docker-compose.napcat.yml "$@"; }
cp .env.example .env && chmod 600 .env
$EDITOR .env
cp napcat.env.example napcat.env && chmod 600 napcat.env
$EDITOR napcat.env
# 带上 config/local/*.yml
bash scripts/cloud-preflight.sh --with-napcat

# 5) 解密并校验（先建目录；私钥不入库，按 -i 指定）
mkdir -p backups
sha256sum -c <批次目录>.tar.age.sha256
age -d -i <identity-file> <批次目录>.tar.age | tar -C backups -xzf -

# 6) 构建并建卷，先不启动
export QQBOT_IMAGE_TAG="$(date +%Y%m%d)-$(git rev-parse --short HEAD)"
COMPOSE build
COMPOSE create

# 7) 整批预检 + 覆盖恢复三卷；--volumes 必须和 backup 完全一致
bash scripts/volume-bundle.sh verify  --bundle backups/<批次目录> --project qqbot-dsh \
  --volumes "dsh-home workspaces bot-state"
bash scripts/volume-bundle.sh restore --bundle backups/<批次目录> --yes --project qqbot-dsh \
  --volumes "dsh-home workspaces bot-state"

# 8) 数据就位后启动；NapCat 三卷为空，首次扫码登录
COMPOSE up -d
COMPOSE logs -f napcat
```

#### 4.2B 旧 sidecar（迁六卷）

```sh
# --- 旧主机：旧端已经是 qqbot + NapCat sidecar ---
cd qqbot-dsh
COMPOSE_OLD() { docker compose -f docker-compose.yml -f docker-compose.cloud.yml -f docker-compose.napcat.yml "$@"; }
COMPOSE_OLD stop

bash scripts/volume-bundle.sh backup --project qqbot-dsh --out backups
tar -C backups -czf - <批次目录> | age -r <接收方公钥> > <批次目录>.tar.age
sha256sum <批次目录>.tar.age > <批次目录>.tar.age.sha256

# --- 新主机 ---
git clone <repo> qqbot-dsh && cd qqbot-dsh
git checkout feat/cloud-migration
COMPOSE() { docker compose -f docker-compose.yml -f docker-compose.cloud.yml -f docker-compose.napcat.yml "$@"; }
cp .env.example .env && chmod 600 .env
$EDITOR .env
cp napcat.env.example napcat.env && chmod 600 napcat.env
$EDITOR napcat.env
# 带上 config/local/*.yml
bash scripts/cloud-preflight.sh --with-napcat

mkdir -p backups
sha256sum -c <批次目录>.tar.age.sha256
age -d -i <identity-file> <批次目录>.tar.age | tar -C backups -xzf -

export QQBOT_IMAGE_TAG="$(date +%Y%m%d)-$(git rev-parse --short HEAD)"
COMPOSE build
COMPOSE create

# 六卷：verify/restore 都不传 --volumes（默认六组），预检会核对 manifest
bash scripts/volume-bundle.sh verify  --bundle backups/<批次目录>
bash scripts/volume-bundle.sh restore --bundle backups/<批次目录> --yes

COMPOSE up -d
```

> `volume-bundle.sh` 的 bundle 包含所选卷、`manifest.txt` 和 `SHA256SUMS`；
> 预检会核对 manifest 的项目名、卷集合、每个 `.tgz` 是否存在并列入清单。
> 加密在脚本外做：脚本不接收口令；`age -d -i` 的私钥只放目标机或离线介质。

首次登录（仅空卷或 NapCat 登录态失效时需要）：

```sh
# 本机开隧道，浏览器打开 http://127.0.0.1:6099/webui?token=<WEBUI_TOKEN>
ssh -L 6099:127.0.0.1:6099 <user>@<cloud-host>
```

或从日志/容器里取二维码：

```sh
docker cp qqbot-napcat:/app/napcat/cache/qrcode.png /tmp/qrcode.png
```

登录成功后，`qqbot` 日志应出现 OneBot 连接建立，`/healthz` 的
`connectors.onebot.connected` 为 `true`。

启动日志里还必须看到：

- `[entrypoint] 沙箱后端有效：…`（若为 degraded，见第 7 节）
- `网关就绪（READY）`（官方接入）或 OneBot 已连接
- `qqbot-dsh 已就绪`

`/healthz` 的 `ok` 必须为 `true`。**NapCat 未登录期间 bot 不健康是预期行为**，
不是进程故障。

---

## 5. 数据备份、恢复与迁移（禁止双跑）

迁移的是六组卷：

| 卷 | 内容 | 是否必需 |
|---|---|---|
| `dsh-home` | DSH 会话日志、profile、凭证 | 是 |
| `workspaces` | 每会话工作区、`AGENTS.md` | 是 |
| `bot-state` | 对话记录、去重、会话映射、人设、后台待投递 | 是 |
| `napcat-qq` | QQ 登录态、设备信息 | 用 NapCat 时必需 |
| `napcat-config` | NapCat 账号与 OneBot 配置（含 token） | 用 NapCat 时必需 |
| `napcat-plugins` | 插件 | 可选 |

### 5.1 停机备份（一次完整批次）

**先从旧实例停掉全部服务，再备份。** 迁移期间旧、新实例绝不能同时在线。
卷集合由源端形态决定：宿主原生 NapCat 只备份 bot 三卷（4.2A）；旧 sidecar
才备份六卷（4.2B）。

```sh
cd qqbot-dsh
COMPOSE() { docker compose -f docker-compose.yml -f docker-compose.cloud.yml -f docker-compose.napcat.yml "$@"; }
COMPOSE stop

# 六组卷 + manifest.txt + SHA256SUMS，一个批次一个目录
bash scripts/volume-bundle.sh backup --project qqbot-dsh --out backups
bash scripts/volume-bundle.sh verify --bundle backups/<批次目录>
```

`manifest.txt` 记录批次号、时间、主机、git commit、镜像标签、卷列表与各卷
大小；`SHA256SUMS` 覆盖所选卷的 `.tgz` 和 manifest 本身。**这组清单就是
"统一批次校验"，恢复前必须 `verify` 通过。** 即使忘了 `stop`，`backup` 也会
检测同项目运行中的容器并拒绝执行；原生 QQ 不在 Compose 里，必须人工确认已停。

- **旧端是宿主原生 NapCat**：只备份 `--volumes "dsh-home workspaces bot-state"`；
  云端 NapCat 三卷留空，最终主机首登。
- **旧端已是 sidecar**：用默认六卷，不传 `--volumes`。

`restore` 必须与 `backup` 使用同一组 `--volumes`，预检会核对 manifest 的卷集合。

备份默认 `umask 077`：批次目录 `700`，`.tgz`、`manifest.txt`、`SHA256SUMS`
都是 `600`；容器内 tar 也显式 `umask 077`。`backups/` 已被 `.gitignore` 忽略，
但归档含 DSH 凭证、QQ 登录态和 OneBot token，传输前仍要加密。

加密传输在脚本外做（脚本不接收口令，避免密钥进入进程参数或日志）。
脚本用 `alpine:3.20` 作为 tar 容器，首次执行需要能拉取该镜像。

```sh
# 示例：age；也可以 gpg --symmetric
tar -C backups -czf - <批次目录> | age -r <接收方公钥> > <批次目录>.tar.age
sha256sum <批次目录>.tar.age > <批次目录>.tar.age.sha256
```

传输前确认：外层 `.tar.age` 的 SHA-256 与 `.sha256` 一致；到达新主机后先校验
外层，再解密展开，最后 `volume-bundle.sh verify` 校验批次内层。任何一层不
一致都停止迁移。

### 5.2 新主机恢复（先恢复，再启动）

把加密包、`.env`、`napcat.env`、`config/local/`（以及手工改过的 `qqbot.yml` /
`config/` / `interests.yml`）拷到新主机。`napcat.env` 是 NapCat 专用口令，单独保管。**先建卷、再解包、校验、启动**：

```sh
# 1) 解密并校验外层（先建目录；私钥不入库，按 -i 指定）
mkdir -p backups
sha256sum -c <批次目录>.tar.age.sha256
age -d -i <identity-file> <批次目录>.tar.age | tar -C backups -xzf -
bash scripts/volume-bundle.sh verify --bundle backups/<批次目录>

# 2) 固定标签并构建镜像（create 需要镜像存在；2C4G 建议改在 CI 构建后 pull）
COMPOSE() { docker compose -f docker-compose.yml -f docker-compose.cloud.yml -f docker-compose.napcat.yml "$@"; }
export QQBOT_IMAGE_TAG="$(date +%Y%m%d)-$(git rev-parse --short HEAD)"
COMPOSE build

# 3) 只创建容器与卷，不启动
COMPOSE create

# 4) 覆盖恢复所选卷：先清空目标卷再解包，且要求项目没有运行中的容器
#    若 backup 用了 --volumes（如原生 NapCat 的三卷），这里必须传同一组
bash scripts/volume-bundle.sh restore --bundle backups/<批次目录> --yes

# 5) 数据就位后才启动
COMPOSE up -d
```

要点：

- `restore` 是**覆盖恢复**：先清空目标卷，再解包并统一
  `chown -R 10001:10001`，不会留下旧卷里多出来的文件；
- **整批预检**在清卷前核对 manifest 的项目名、卷集合、每个必需 `.tgz`
  是否存在且列入 `SHA256SUMS`；缺一个归档就整体失败，不会先清前面的卷；
- 六卷恢复**不是原子操作**：中途失败必须禁止启动，修复原因后从头执行整批恢复；
- 先在旧实例停机后备份，再在新实例启动前恢复，**中间任何时刻只有一个实例**；
- 卷里的 `workspaces/*/AGENTS.md` 是管理员的会话规则，属于数据不是配置，别丢；
- 会话记忆靠 `/data/bot/conversations/*.jsonl` 回放，`sessions.json` 会重建；
- 观察滚窗与在途任务在内存里，重启会丢，需纳入停机公告；
- 不要复制 `node_modules`、`dist`，它们由镜像构建产生。

### 5.3 回滚（含云端已接收新消息）

- **切流前失败**：新实例从未接收消息，直接重新起旧部署即可；旧主机的卷和
  本地镜像都还在，不需要从云端反向同步。
- **云端已接收新消息**：不能直接起旧实例，否则会丢这段时间的对话。顺序是：
  **停云端 → 云端做新批次备份 → 加密传输 → 旧主机覆盖恢复 → 再启动旧实例**，
  全程禁止双跑。
- **旧主机必须使用它原来的 Compose 组合和本地已有镜像**。镜像标签是主机本地
  状态，`export` 云端的标签不会把镜像传过去；没有 OCI 仓库时，旧主机就用
  迁移前那份镜像，必要时从同一 commit 重新构建，不要指望云端已构建的镜像。
- 原生 NapCat 回滚只恢复 bot 三卷，然后按原方式重启原生 QQ；sidecar 回滚才
  恢复六卷。

```sh
# --- 云端主机：停服务并打新批次（按源端形态选 --volumes）---
COMPOSE_CLOUD() { docker compose -f docker-compose.yml -f docker-compose.cloud.yml -f docker-compose.napcat.yml "$@"; }
COMPOSE_CLOUD stop
# 原生回滚：只备份 bot 三卷
bash scripts/volume-bundle.sh backup --project qqbot-dsh --out backups \
  --volumes "dsh-home workspaces bot-state"
# sidecar 回滚：不传 --volumes，默认六卷
# bash scripts/volume-bundle.sh backup --project qqbot-dsh --out backups

# 加密传输到旧主机（私钥不入库）
tar -C backups -czf - <新批次> | age -r <接收方公钥> > <新批次>.tar.age
```

```sh
# --- 旧主机：原生 NapCat 回滚（只恢复 bot 三卷）---
COMPOSE_OLD() { docker compose -f docker-compose.yml "$@"; }  # 用旧主机原来的文件组合
# 不要 export 云端标签；直接用旧主机本地镜像
mkdir -p backups
age -d -i <identity-file> <新批次>.tar.age | tar -C backups -xzf -
COMPOSE_OLD create
bash scripts/volume-bundle.sh verify  --bundle backups/<新批次> --project qqbot-dsh \
  --volumes "dsh-home workspaces bot-state"
bash scripts/volume-bundle.sh restore --bundle backups/<新批次> --yes --project qqbot-dsh \
  --volumes "dsh-home workspaces bot-state"
COMPOSE_OLD up -d qqbot
# 再按原方式（systemd / LaunchAgent / 手工）启动原生 QQ
```

```sh
# --- 旧主机：sidecar 回滚（恢复六卷）---
COMPOSE_OLD() { docker compose -f docker-compose.yml -f docker-compose.cloud.yml -f docker-compose.napcat.yml "$@"; }
# 用旧主机迁移前的本地镜像标签；不要复用云端标签
mkdir -p backups
age -d -i <identity-file> <新批次>.tar.age | tar -C backups -xzf -
COMPOSE_OLD create
bash scripts/volume-bundle.sh verify  --bundle backups/<新批次>
bash scripts/volume-bundle.sh restore --bundle backups/<新批次> --yes
COMPOSE_OLD up -d
```

- `restore` 是**覆盖恢复**：会先清空旧主机的目标卷再解包，避免新旧状态混合；
  执行前确认这些卷可以被覆盖。
- 六卷恢复不是原子操作；中途失败必须禁止启动，修复原因后从头执行整批恢复。
- 回滚完成后核对 `/healthz`、NapCat 登录态、最近一条对话是否还在。

---

## 6. 上线验证清单

1. `scripts/cloud-preflight.sh --with-napcat` 无 FAIL；
2. 启动日志无 `配置错误`、无 `缺少必需环境变量`，沙箱结论为 effective；
3. `/healthz` `ok=true`，目标 connector `connected=true`；
4. NapCat 日志显示已登录（不是停在二维码/掉线重连）；
5. 群里 @ 一次，确认能回复；发一张图/一个文件，确认附件链路；
6. 重启一次全部容器，确认登录态复用、能自动重连、不重复回复；
7. `docker compose stop` 后 `/healthz` 不可达、无残留 DSH 子进程；
8. 如需联网抓正文：`docker compose exec qqbot node scripts/smoke-web-fetch.mjs`
   （会消耗一次真实模型调用）；
9. 确认 `6700`/`8080`/`6099` 在公网与同 VPC 均不可达（只回环）；
10. 迁移场景额外检查：**所选卷集合**（原生 3 组 / sidecar 6 组）都在、
    `volume-bundle.sh verify` 通过、`docker volume inspect` 的卷名与批次
    manifest 一致、最近一条对话/工作区 `AGENTS.md`/NapCat 登录态都能对上；
11. qqbot 的合并环境里**没有** `WEBUI_TOKEN`（用
    `docker compose config` 或 `docker inspect` 核对）；它只应出现在 NapCat
    容器的 `env_file` 结果里。

### 6.1 未实测项（必须在云主机完成，不能标为已通过）

以下项目在本机没有 Docker daemon，**尚未实测**：

- `docker build`（`npm ci` 之后的完整镜像构建）；`npm ci --dry-run` 只验证了
  锁文件一致，不等于构建通过；
- `docker compose build` / `pull` 两个镜像；
- NapCat 首次启动、扫码登录、登录态复用；
- qqbot 与 NapCat 的反向 WS 握手、收发消息、图片/文件链路；
- `volume-bundle.sh backup/restore` 的真实 Docker 卷读写（脚本的
  `verify`、`--dry-run`、篡改检测已在本地验证）；
- 4GB 主机上的实际内存峰值与 `docker stats` 校正。

在云主机上按第 4、5 节执行并记录结果后，才能把对应项改为"已通过"。

---

## 7. 已知风险与待确认项

| 风险 | 影响 | 处理 |
|---|---|---|
| 内核不支持 Landlock / 禁止非特权 user namespace | `workspace-write` 退化为完全访问，安全边界只剩容器 | 选内核 ≥5.13 的镜像；Ubuntu 24.04 注意 `kernel.apparmor_restrict_unprivileged_userns=1`；启动日志看沙箱结论 |
| NapCat 登录态/设备指纹变化 | 掉线、要求重新验证，严重时封号 | 持久化 `napcat-qq`，固定镜像/MAC/hostname，稳定出口 IP，单实例，减少重启 |
| 跨云换 IP | 迁移即一次环境跳变 | 先定平台再迁，迁一次到位；首登在最终主机完成 |
| 4GB 内存 | QQ + DSH 子进程峰值可能 OOM | 2GB swap；`QQ_MAX_RUNTIMES=4`、`QQ_MAX_CONCURRENT_TURNS=2`（覆盖层默认）；监控内存 |
| 2 vCPU 构建 | `npm ci + tsc` 与运行抢 CPU/内存 | 先 build 再 up；2C4G 建议 CI 构建后 pull |
| 第三方 NapCat 镜像供应链 | 镜像被替换/带后门 | 固定版本或 digest；升级前看 Release；不挂 docker.sock |
| 数据迁移窗口 | 迁移期间消息漏回 | 低峰期停机；先停旧、备份、恢复、再起新；禁止双跑 |
| 磁盘增长 | 工作区、inbox、DSH 日志、QQ 缓存持续增长 | 配 `BOT_ATTACHMENT_INBOX_RETENTION_DAYS` / `MAX_MB`，定期看卷占用 |
| 镜像无仓库历史 | 回滚只能靠重建 | 用 `QQBOT_IMAGE_TAG` / `NAPCAT_IMAGE_TAG`，或推 OCI 仓库 |
| 密钥落盘 | `.env` 与 NapCat 卷含敏感信息 | `chmod 600`、加密备份、不进镜像、不进 git |
| 目标平台未定 | 网络策略/地域未知 | 官方 WSS 与 NapCat 反向 WS 都不需要公网入站；选定后用 preflight 实测 |

待用户确认：最终云厂商与地域（影响出口 IP 与迁移次数）、是否保留官方接入
作为 NapCat 的降级通道、QQ 小号的设备验证要求、数据量/维护窗口、备份保留与
RPO/RTO。
