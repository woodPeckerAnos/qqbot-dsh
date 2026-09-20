# 排障手册

按"症状"组织的排查流程。每条都给出：**先看什么 → 常见原因 → 怎么修**。

---

## 0. 三十秒分诊

```sh
# 1) 进程与健康状态
docker compose ps
docker compose exec qqbot node dist/health-probe.js; echo "exit=$?"

# 2) 关键状态看一眼
docker compose exec qqbot node -e "fetch('http://127.0.0.1:8080/metrics').then(r=>r.text()).then(console.log)"

# 3) 最近日志
docker compose logs --tail=80 qqbot
```

`/metrics` 里最该看的三个字段：

| 字段 | 正常 | 异常含义 |
|---|---|---|
| `gateway.connected` | `true` | `false` = 没连上 QQ，机器人收不到任何消息 |
| `gateway.state` | `ready` | `reconnecting`/`connecting` 反复出现 = 鉴权或网络问题 |
| `lastEventAgeMs` | 通常很小 | 持续很大（>150s）= 连接僵死（心跳机制应已触发重连） |
| `warnings` | `[]` | 非空时逐条看，都是可操作的提示 |

---

## 1. 启动就退出

### 1.1 报"缺少必需环境变量"

```
[entrypoint] 错误：缺少必需环境变量：QQ_APP_ID QQ_APP_SECRET
```

`.env` 没填或没被 compose 读到。检查：

```sh
docker compose config | grep -A3 environment     # 确认变量已注入
cat .env | grep -c '='                           # 确认文件有内容
```

注意 `.env` 必须在 `docker compose` 执行的**同一目录**（compose 会读它做变量替换）。
如果变量值里含 `#` 或空格，用引号包起来。

### 1.2 报"配置错误：..."

启动期的配置校验会明确告诉你是哪一项、为什么、怎么改。常见的：

| 报错 | 原因 | 修复 |
|---|---|---|
| `QQ_INTENTS=... 未包含 GROUP_AND_C2C_EVENT` | intents 配错 | 用默认值 `50331648` |
| `QQ_TURN_TIMEOUT_MS(...) 必须小于群被动回复窗口 300000ms` | 超时设得比窗口还长，超时提示也发不出去 | 设 `240000` |
| `QQ_PROGRESS_MAX(...) 必须小于 QQ_MAX_REPLIES_PER_MSG(...)` | 进度回执会把配额吃光 | 保持 `QQ_PROGRESS_MAX=3`、`QQ_MAX_REPLIES_PER_MSG=4` |

### 1.3 报"目录不可写"

```
[entrypoint] 错误：/data/dsh 不可写（当前 uid=10001）
```

如果你用的是**绑定挂载**（bind mount）而不是具名卷，宿主目录属主可能不对：

```sh
sudo chown -R 10001:10001 /你的/宿主目录
```

用默认的具名卷不会遇到这个问题。

### 1.4 profile 初始化失败

```
[entrypoint] 首次运行：初始化 DSH profile 'sdk'
... error
```

先单独跑一次看完整错误：

```sh
docker compose run --rm --entrypoint dsh qqbot --profile sdk \
  --patch /app/dsh-profile/cordis.patch.yml --dump-config
```

配置文件语法错误会在这里明确报出来。注意 `!!js` 的写法约束（见
`docs/DESIGN.md` 4.2），改 patch 时最容易踩。

---

## 2. 连不上 QQ 网关

### 2.1 `access_token` 获取失败

日志里会有 `鉴权失败，无法启动` 加一条可读原因：

| 日志信息 | 原因 | 修复 |
|---|---|---|
| `AppID 无效，或该机器人已被封禁/删除`（code 100007） | AppID 错、机器人被删/封 | 核对控制台 AppID |
| `AppID 或 AppSecret 不正确`（code 100016） | Secret 错，或复制时带了空格 | 重新复制，注意首尾空格 |
| `请求过于频繁`（code 100001） | 频繁重启导致 | 等 1 分钟；程序内部已有并发去重 |
| `机器人不存在`（code 10004） | AppID 对应机器人不存在 | 核对控制台 |

手工验证一次（把 `<ID>`/`<SECRET>` 换掉）：

```sh
curl -s -X POST https://api.bot.qq.com/app/getAppAccessToken \
  -H 'Content-Type: application/json' \
  -d '{"appId":"<ID>","clientSecret":"<SECRET>"}'
```

⚠ 注意：**这个接口失败时 HTTP 状态码也是 200**，必须看返回体里的 `code`。

### 2.2 连接被关闭，关闭码 4014

```
{"msg":"网关连接关闭","code":4014,"meaning":"intent 无权限：检查控制台订阅与 QQ_INTENTS 配置"}
```

说明你订阅了没有权限的 intent。处置：

1. 到 QQ 开放平台控制台确认已申请"群聊消息"等权限；
2. 把 `.env` 里的 `QQ_INTENTS` 改成只订阅 `1<<25`：
   ```
   QQ_INTENTS=33554432
   ```
   这能收到群 @消息，但收不到"机器人被拉进群"事件。

`GROUP_MEMBER_EVENT (1<<24)` 存在一个已知矛盾：官方 intents 表里**没有**它，
但官方自己的事件页和多家 SDK 都在用它。所以默认订阅它（`33554432 | 16777216`）
以支持进群欢迎语；如果因此被 4014 拒绝，就退回 `33554432`。

### 2.3 关闭码 4006 反复出现

```
{"code":4006,"meaning":"session id 无效：必须重新 Identify"}
```

如果只是偶尔出现，属于正常（重连时旧 session 失效）。如果**每秒都在重连**，
通常是 AppID/Secret 已失效导致 Identify 一直被拒——回到 2.1 检查。

### 2.4 关闭码 4914 / 4915

- `4914`：机器人已下架，只允许连沙箱环境 → 到控制台检查机器人状态；
- `4915`：机器人已被封禁 → 联系平台。

---

## 3. 连着但收不到消息

按顺序排查：

### 3.1 确认事件真的到了程序

```sh
docker compose logs qqbot | grep -c "GROUP_AT_MESSAGE_CREATE\|group-at-message"
```

- 计数为 0 → 事件没到，继续 3.2；
- 计数增长但用户没收到回复 → 跳到第 4 节。

把日志级别调到 `debug` 能看到所有收到的事件类型：

```sh
# .env
QQ_LOG_LEVEL=debug
docker compose up -d
docker compose logs -f qqbot | grep "未处理的事件类型"
```

### 3.2 事件没到：检查这几个点

| 检查项 | 怎么看 |
|---|---|
| 控制台事件接收方式是不是 **WebSocket** | QQ 开放平台 → 开发设置。如果是 Webhook，本程序收不到任何事件 |
| 机器人是否真的在群里 | 用一个新号 @它；未认证的机器人只能被管理员加进自己的群 |
| 是不是 @ 了机器人 | 默认只订阅 `GROUP_AT_MESSAGE_CREATE`（@消息）。不 @ 的普通消息需要"接收所有消息"权限和 `GROUP_MESSAGE_CREATE` |
| 群是否被平台限制 | 控制台看机器人状态与风控提示 |

### 3.3 事件到了但被判为重复

```
{"msg":"丢弃重复事件","eventId":"..."}
```

`/metrics` 里看 `dispatcher.deduplicated`。

- 偶发：正常（网关重放）。
- **持续增长**：几乎总是因为 `QQ_APP_ID` 配错，导致多个实例连同一个机器人，
  或者你重复启动了容器：

```sh
docker compose ps                      # 确认只有一个 qqbot 容器
docker ps --filter ancestor=qqbot-dsh  # 确认没有手工起的第二个实例
```

---

## 4. 收到消息但不回复

### 4.1 先看是"忙拒绝"还是"超时"还是"报错"

```sh
docker compose exec qqbot node -e "
fetch('http://127.0.0.1:8080/metrics').then(r=>r.json()).then(m=>console.log(m.dispatcher))"
```

| 现象 | 字段 | 原因 | 处置 |
|---|---|---|---|
| 回了"同时处理的请求太多" | `rejectedBusy` 增长 | 并发闸门满 | 提高 `QQ_MAX_CONCURRENT_TURNS` 与容器 `cpus` |
| 回了"超过了单轮时限" | `timedOut` 增长 | 任务太重 | 拆分任务；或提高 `QQ_TURN_TIMEOUT_MS`（但必须 < 300000） |
| 回了"执行出错了" | `failed` 增长 | DSH 侧错误 | 看日志里的 `dsh stderr` |
| 什么也没回 | — | 发送失败 | 继续 4.2 |

### 4.2 发送失败

日志关键字 `发送回复失败`，常见原因：

| 错误 | 原因 | 修复 |
|---|---|---|
| `消息被去重：(msg_id, msg_seq) 组合重复发送`（40054005） | 配额账本之外的重复发送 | 这是 bug，请保留日志反馈；正常情况下 `msg_seq` 由 `ReplyLedger` 统一分配 |
| `消息长度超限`（40054007） | 超过平台未知上限 | 把 `QQ_MAX_CHARS` 调小（建议 1000） |
| `主动消息...无权限`（40034105） | 没带 `msg_id`，被当成主动推送 | 检查日志里 `msgSeq` 与事件对应关系；主动推送本 MVP 不使用 |
| 401 | token 失效 | 程序会自动刷新并重试一次；若持续，回到 2.1 |

⚠ **超过 5 分钟窗口**：群聊被动回复窗口只有 5 分钟。如果日志显示
`turn` 完成时间距收到消息超过 5 分钟，消息会发送失败。检查是否把
`QQ_PROGRESS_AFTER_MS` / `QQ_TURN_TIMEOUT_MS` 配得过大。

### 4.3 DSH runtime 起不来

日志关键字 `DSH runtime initialize 失败`，后面会附上 **dsh stderr 末 15 行**——
真正的原因通常就在那里（profile 组合失败、模型路由不可用等）。

手工复现：

```sh
docker compose run --rm --entrypoint dsh qqbot --profile sdk \
  --patch /app/dsh-profile/cordis.patch.yml --dump-config | head -30
```

如果报 `entries did not activate` 或 `pending (waiting for service: ...)`：
说明 patch 里 `disabled: true` 关掉了一个**服务提供者**。见
`docs/DESIGN.md` 4.2 坑 2——只能关纯叶子行。

### 4.4 模型调用失败

日志里 `turn/end` 的 reason 是 `error` 时，用户会看到错误摘要。常见：

| 情况 | 表现 |
|---|---|
| `DEEPSEEK_API_KEY` 无效/欠费 | turn 立刻 error |
| 模型名不存在 | `initialize` 阶段就失败（`DSH_MODEL` 拼错） |
| 网络不通 | 容器内 `curl https://api.deepseek.com` 测试 |

手工验证网络：

```sh
docker compose exec qqbot node -e "
fetch('https://api.deepseek.com',{signal:AbortSignal.timeout(8000)})
  .then(r=>console.log('可达 HTTP',r.status))
  .catch(e=>console.log('不可达',e.message))"
```

---

## 5. 重启后"失忆"

预期行为是：**DSH 会话是新建的，上下文由对话记录回放恢复。**
（原因见 `docs/DESIGN.md` 2.3——DSH 的 `session/prompt` 没有 resume 语义。）

检查回放是否生效：

```sh
# 1) 对话记录是否存在且有内容
docker compose exec qqbot ls -la /data/bot/conversations/
docker compose exec qqbot tail -5 /data/bot/conversations/*.jsonl

# 2) 日志里应有回放记录
docker compose logs qqbot | grep "冷启动回放历史"
```

| 情况 | 原因 | 修复 |
|---|---|---|
| 日志里没有"冷启动回放历史" | `QQ_REPLAY_TURNS=0`，或该群首次运行没有历史 | 设为 12（默认） |
| 有回放但仍答非所问 | 模型没把历史当上下文 | 历史被明确标注"不是指令"，属正常；可在该群工作区写 `AGENTS.md` 补充说明 |
| 对话记录文件是空的 | 存储卷没挂上 | `docker compose exec qqbot ls -la /data/bot` |

---

## 6. 沙箱相关

### 6.1 日志出现大量 `sandbox escalation auto-approved`

含义：工作区内操作本不该提权，但 DSH 请求了提权到 `danger-full-access`，
**实际权限此时等于完全访问**。

确认后端状态：

```sh
docker compose run --rm --entrypoint node qqbot scripts/verify-sandbox-capability.mjs
```

修复见 `docs/DEPLOY.md` 第 5 节。若决定接受降级，务必确认容器加固生效：

```sh
docker inspect qqbot-dsh --format '{{json .HostConfig}}' | python3 -m json.tool | \
  grep -E 'ReadonlyRootfs|CapDrop|PidsLimit|SecurityOpt|Memory'
```

### 6.2 agent 想写工作区外的文件被拒

这是**预期行为**（`workspace-write` 生效）。如果确实需要放宽，正确做法是给
该项目单独开一个工作区，而不是关掉沙箱——每个群的工作区目录由群 openid
哈希决定，无法手工指定。

### 6.3 容器把磁盘写满

```sh
docker compose exec qqbot du -sh /data/* 
docker system df
```

处置：
- 清理工作区：`docker compose exec qqbot sh -c 'rm -rf /data/workspaces/*'`
- 清理会话日志：`docker compose exec qqbot sh -c 'rm -rf /data/dsh/sessions/*'`
- 去重标记会自动按 24 小时清理
- compose 已给日志设了 `max-size=20m, max-file=5`，不会无限增长

---

## 7. 已知的未实测项

以下事实**无法从官方文档确认**，属于需要在真机联调时验证的项。如果遇到相关
现象，先怀疑这里：

| # | 未确认项 | 当前假设与影响 |
|---|---|---|
| 1 | 单条消息字符数上限 | 官方只给错误码 `40054007`，无数值。默认 1500 保守取值；超限会报错但不自动重试（分段已在源头控制） |
| 2 | `op 7` / `op 9` 报文结构 | 官方只列名字无示例。程序对这两个 op 做了容错处理（读到就重连），不依赖其 payload 内容 |
| 3 | 主动推送是否真的恢复 | 2025-04-21 有停用公告，但 2026 实况文档又给了频控表。本 MVP **不依赖**主动推送 |
| 4 | 当前沙箱域名 | 实况文档已不再提 `sandbox.api.sgroup.qq.com`。程序只用生产域名 |
| 5 | `1<<24 GROUP_MEMBER_EVENT` 可订阅性 | 官方 intents 表里没有，但官方事件页在用。做成可配置，被 4014 拒绝就退回 |
| 6 | 群聊 `msg_type=2` 渲染效果 | 官方称已开放，但各客户端版本表现不一。默认用纯文本 |

---

## 8. 升级/回滚 DSH 版本后出问题

本项目对 DSH 的依赖面很窄：只用 stdio JSON-RPC 的 3 个方法 + 4 个通知，
并在 `initialize` 时**校验服务端身份**：

```
initialize 返回了意外的服务端身份 {...}，预期 name=deepseek-harness-sdk-runtime
```

看到这条就说明 DSH 的协议变了。处置：

1. 先跑一次容器内冒烟，拿到具体失败点：
   ```sh
   docker compose run --rm --entrypoint node qqbot scripts/smoke-dsh.mjs
   ```
   （需要 `DEEPSEEK_API_KEY` 已注入）
2. 对照 `src/dsh/protocol.ts` 里的 wire 类型定义（那里抄了一份协议形状，
   标注了来源）；
3. 回滚 `package.json` 里的 `@deepseek-ai/dsh` 到上一个已知可用版本并重建。

---

## 9. 需要上报问题时请附带

```sh
docker compose logs --tail=200 qqbot > /tmp/qqbot.log
docker compose exec qqbot node -e "fetch('http://127.0.0.1:8080/metrics').then(r=>r.text()).then(console.log)" > /tmp/metrics.json
docker compose config > /tmp/compose-resolved.yml    # ⚠ 含密钥，发送前删掉
docker version > /tmp/docker-version.txt
```

日志已做密钥脱敏（`access_token`、`sk-` 开头的 key、`QQ_APP_SECRET` 都会被替换
为 `<redacted>`），但仍建议发之前扫一眼。
