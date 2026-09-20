# 部署手册

面向"在一台 Linux 服务器上把它跑起来"的完整步骤。全部操作为 `docker compose`
命令，**不需要在宿主机上安装 Node.js、pnpm 或任何项目依赖**。

---

## 0. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Linux x86_64 / arm64 | 需要内核支持 Landlock（≥ 5.13）或允许非特权 user namespace |
| Docker | 24+ | 需要 `docker compose` 子命令 |
| 内存 | ≥ 2 GB 可用 | 默认给容器 2 GB 上限；每活跃群一个 DSH 进程 |
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

> ⚠ 群聊被动回复窗口只有 **5 分钟**、每条消息最多回 **5 次**。本程序已按此设计
> （进度回执 + 配额账本），请不要把 `QQ_TURN_TIMEOUT_MS` 调到 300000 以上——
> 配置层会直接拒绝。

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
cp .env.example .env
$EDITOR .env          # 至少填 QQ_APP_ID / QQ_APP_SECRET / DEEPSEEK_API_KEY

# 3) 构建并启动
docker compose up -d --build

# 4) 看日志
docker compose logs -f qqbot
```

启动成功的日志特征（JSON 行，逐行）：

```json
{"level":"info","msg":"存储目录就绪", ...}
{"level":"info","msg":"已获取 access_token","expiresInSec":7200,...}
{"level":"info","msg":"连接 QQ 网关","url":"wss://api.bot.qq.com/websocket/","mode":"identify"}
{"level":"info","msg":"网关就绪（READY）","sessionId":"...","bot":"..."}
{"level":"info","msg":"qqbot-dsh 已就绪，等待群消息"}
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

---

## 4. 验证

```sh
# 健康检查：ok=true 才说明真的连上了 QQ 网关
docker compose exec qqbot node dist/health-probe.js && echo HEALTHY

# 看完整状态与计数
docker compose exec qqbot node -e "
fetch('http://127.0.0.1:8080/metrics').then(r=>r.text()).then(console.log)"
```

在群里 @机器人 发一句：

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

# 查看资源占用（每活跃群一个 DSH 进程）
docker compose exec qqbot ps -ef
docker stats qqbot-dsh
```

---

## 7. 调参建议

编辑 `.env` 后 `docker compose up -d` 生效（无需重建）。

| 场景 | 调整 |
|---|---|
| 模型回答太慢/太贵 | `DSH_MODEL=deepseek-flash`（默认，最快）；需要更强推理换 `deepseek-v4-pro` |
| 群里人多、并发高 | 提高 `QQ_MAX_CONCURRENT_TURNS`，同时提高 compose 里的 `cpus`/`memory` |
| 容器内存紧张 | 降低 `QQ_MAX_RUNTIMES`（更频繁地回收 runtime，代价是更频繁的历史回放） |
| 不想让机器人记很久之前的事 | 降低 `QQ_REPLAY_TURNS`（0 = 完全不回放，重启即失忆） |
| 回答太长被截断 | 提高 `QQ_MAX_CHARS`，但注意平台上限未知（超限会报 40054007 并自动折半重试） |
| 希望代码块渲染更好看 | `QQ_MSG_TYPE=2`（Markdown）。注意部分客户端版本渲染效果不稳定 |
| 日志太吵 | `QQ_LOG_LEVEL=warn` |
| 想给某个群定规矩 | 在该群工作区目录下写 `AGENTS.md`，DSH 会自动加载（改规则不用重建镜像） |

---

## 8. 升级

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

## 9. 卸载

```sh
docker compose down -v          # 删除容器与所有卷（工作区、会话日志、对话记录）
docker rmi qqbot-dsh:0.1.0      # 删除镜像
```
