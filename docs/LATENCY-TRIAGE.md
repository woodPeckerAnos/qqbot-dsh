# 模型调用变慢 / 长任务超时：日志排查流程

> **生产形态**：云主机，`docker-compose.yml` + `docker-compose.cloud.yml` +
> `docker-compose.napcat.yml` 三层叠加；通道按 `BOT_CONNECTORS`（当前配置是
> OneBot + NapCat sidecar，官方通道的差异在文中单独标注）；主模型按
> `config/local/models.yml`（当前是 `qwen-token-plan` / `qwen3.8-flash`）。
> **本文所有命令都在云主机的仓库根目录执行**（不是本地 Mac）。
>
> 目标：十分钟内回答三个问题——**慢在哪一层、为什么超时、先改什么**。

---

## 0. 先分清三件事

| 现象 | 判定依据 | 本文对应章节 |
|---|---|---|
| **慢** | 最终回了，但端到端很久 | §3 → §4 |
| **超时** | 日志有 `本轮超时，将回收 runtime 以终止任务` | §5.1 |
| **失败** | `turn/end` reason 为 `error`，或 `发送回复失败` | §5.4 |

三者会互相伪装：**一次超时会让下一条消息更慢**（runtime 被杀 → 下次冷启动 →
回放 12 轮历史 → prompt 更大），所以不要只看单条消息的日志。

---

## 1. 十分钟流程

```
第 0 步  取指标 + 最近日志            → 是超时型 / 容量型 / 冷启动型？
第 1 步  对话记录算端到端            → 慢在"轮内"还是"轮外"？
第 2 步  会话日志拆 turn/step        → 模型慢、工具慢，还是步数太多？
第 3 步  系统 + 供应商对照            → CPU 限流 / 网络 / 限流重试 / 思考模式
第 4 步  按 §6 判据表处置             → 先止血，再调参
```

前两步只用现成日志，不需要改代码、不需要重启。

---

## 2. 第 0 步：取指标与最近日志

```sh
# 每个新 shell 先定义一次（与 CLOUD-DEPLOY.md 保持一致）
COMPOSE() { docker compose -f docker-compose.yml -f docker-compose.cloud.yml -f docker-compose.napcat.yml "$@"; }

COMPOSE ps
```

### 2.1 指标快照

云上 8080 只绑回环，宿主上直接 curl：

```sh
curl -s http://127.0.0.1:8080/metrics \
  | python3 -c 'import json,sys; m=json.load(sys.stdin); print(json.dumps({"runtime":m["runtime"],"dispatcher":m["dispatcher"],"connectors":m["connectors"]},ensure_ascii=False,indent=2))'
```

（宿主没有 python3 时用 `COMPOSE exec -T qqbot node -e 'fetch("http://127.0.0.1:8080/metrics").then(r=>r.json()).then(m=>console.log(JSON.stringify(m.runtime)))'`。）

只看这几个字段：

| 字段 | 含义 | 异常信号 |
|---|---|---|
| `dispatcher.timedOut` | 累计超时轮数 | 近 24h 持续增长 = 超时型 |
| `dispatcher.completed` | 完成轮数 | 与 `timedOut` 的比值决定严重程度 |
| `dispatcher.failed` | 未预期错误 | 增长 = 看 `dsh stderr` |
| `dispatcher.rejectedBusy` | 并发满被拒 | 增长 = 容量型（§5.2） |
| `dispatcher.busyNoticed` | 会话忙提示 | 增长 = 同会话排队（长任务占着会话） |
| `dispatcher.inFlight` / `queued` | 在途 / 排队 | `inFlight` 长期顶满 = 容量型 |
| `runtime.size` | 活跃 DSH 进程数 | 频繁归零再涨 = 冷启动型（§5.3） |
| `runtime.activeSubagents` | 在跑子代理 | 有值说明长任务确实在后台 |
| `connectors.onebot.state` | 连接状态 | 非 `connected` 先修通道，与模型无关 |

### 2.2 把最近日志落成文件

```sh
COMPOSE logs --no-log-prefix --since 24h qqbot > /tmp/qqbot-24h.log
```

> **先落盘再分析**：compose 日志上限是 5×20MB，debug 级别下高峰几小时就会滚掉，
> 出问题时越早抓越好。

云主机默认没有 `jq`，先装一次（后面命令都按 `jq` 写）：`sudo apt install -y jq`。
不能装时，用 `python3` 逐行解析同一份日志即可，例如查超时：

```sh
python3 - <<'PY'
import json
for line in open('/tmp/qqbot-24h.log', encoding='utf-8'):
    try:
        r = json.loads(line)
    except ValueError:
        continue
    if r.get('msg') == '本轮超时，将回收 runtime 以终止任务':
        print(r.get('time'), r.get('conversation'), r.get('timeoutMs'), r.get('toolsInvoked'))
PY
```

```sh
grep -c '' /tmp/qqbot-24h.log                      # 行数
grep -c '本轮超时' /tmp/qqbot-24h.log
grep -c '冷启动回放历史' /tmp/qqbot-24h.log
grep -c 'runtime 不可用，重建' /tmp/qqbot-24h.log
grep -c '并发已满' /tmp/qqbot-24h.log
grep -c 'runtime 池已满' /tmp/qqbot-24h.log
```

### 2.3 一分钟分诊

| 计数组合 | 类型 | 直接跳到 |
|---|---|---|
| `本轮超时` 多，`并发已满` 少 | **超时型**：任务本身太久 | §3、§5.1 |
| `并发已满` / `inFlight` 顶满 | **容量型**：2 个并发名额被长任务占死 | §5.2 |
| `冷启动回放历史` 频繁 + `runtime.size` 归零 | **冷启动型**：超时/回收的正反馈 | §5.3 |
| 以上都不多，但端到端就是慢 | **轮内型**：模型步进或工具 | §3、§4 |

---

## 3. 第 1 步：端到端时长（对话记录）

对话记录是进程自己写的 JSONL，每轮一条 user + 一条 assistant，**带毫秒时间戳**，
不受日志轮转影响：

```
/data/bot/conversations/<hash>.jsonl
```

先用 `sessions.json` 把群号映射成 hash：

```sh
COMPOSE exec -T qqbot node -e '
const m = require("/data/bot/sessions.json");
for (const [k, v] of Object.entries(m.sessions))
  console.log([k, v.logicalId, "g" + v.generation, v.currentSessionId].join("\t"));
'
```

输出形如：

```
onebot:748741932   3f2a9c1d8e4b7a60   g7   qq-3f2a9c1d8e4b7a60-g7-1a2b3c4d
```

第一列是会话键，第二列是 hash（对应 `/data/bot/conversations/<hash>.jsonl`），
第三列 `generation` 每重建一次 runtime 就 +1。

算每轮的端到端耗时（用户消息 ts → bot 回复 ts）：

```sh
COMPOSE exec -T qqbot node -e '
const fs = require("fs");
const rows = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
let lastUser = null; const samples = [];
for (const r of rows) {
  if (r.role === "user") { lastUser = r; continue; }
  if (r.role !== "assistant" || lastUser === null) continue;
  samples.push({ sec: (r.ts - lastUser.ts) / 1000, who: lastUser.speaker, q: String(lastUser.text).slice(0, 60) });
  lastUser = null;
}
samples.sort((a, b) => b.sec - a.sec);
for (const s of samples.slice(0, 10)) console.log(s.sec.toFixed(1) + "s\t" + s.who + "\t" + s.q.replace(/\s+/g, " "));
const sorted = samples.map((s) => s.sec).sort((a, b) => a - b);
console.log("\n轮数=" + samples.length + " 中位=" + (sorted.length ? sorted[Math.floor(sorted.length / 2)].toFixed(1) : "-") + "s 最大=" + (sorted.length ? sorted.at(-1).toFixed(1) : "-") + "s");
' /data/bot/conversations/<hash>.jsonl
```

**怎么读**：

- 中位 < 20s、个别 60–120s：正常波动（长回答会慢），不是故障；
- 大量 > 90s：用户应该看到过"还在处理"的进度回执（`progressAfterMs` 默认 90s）。
  有回执但最终超时，说明任务确实跑满了一轮时限；
- 单条 > `ONEBOT_TURN_TIMEOUT_MS`（默认 600s）：不是单轮慢，而是**排在同一个会话的
  上一条长任务后面**（会话锁串行）。看 `busyNoticed` 是否同步增长；
- 时间戳异常（负数/巨大）：OneBot 上报的 `time` 是平台时间，和本机时钟有偏差，
  用中位数看趋势，别抠单条。

端到端与 §4 的 `turn` 总时长之差，就是"轮外"时间，按顺序由这些组成：

```
话题判定（有历史时每轮一次，超时 10s，失败按"相关"继续）
+ 等待同会话的上一条 turn（会话锁）
+ 冷启动 initialize（2–5s，异常时到 60s）
+ prompt 组装（回放、观察窗口、附件下载）
+ 发送回复（平台 API）
```

差值稳定在 1–3s 属于正常；经常 > 10s 就要查话题判定（`话题判定调用异常` warn）
与冷启动（§5.3）。差值里也包含 NapCat 上报事件的延迟——`lastEventAgeMs` 正常、
连接器没有重连时可以忽略这一项。

---

## 4. 第 2 步：轮内拆解（DSH 会话日志）

`turn` 里的耗时只有 DSH 自己的会话日志有。位置：

```
/data/dsh/sessions/--data-workspaces-<hash>--/<sessionId>/session.v<N>.jsonl.zstd
```

- `<hash>` 与对话记录的 hash 相同；
- `<sessionId>` 就是 `sessions.json` 里的 `currentSessionId`；
- 每轮超时/回收都会换新 sessionId，**旧文件不会被删**，按修改时间找即可。

### 4.1 找文件

```sh
# 最近的几个会话日志（按修改时间；qq-* 是本桥接层铸的 sessionId）
COMPOSE exec -T qqbot sh -lc 'ls -lt /data/dsh/sessions/*/qq-*/session.v*.jsonl* | head -5'

# qq-* 没匹配到（版本差异）时，退化成任意会话目录
COMPOSE exec -T qqbot sh -lc 'ls -lt /data/dsh/sessions/*/*/session.v*.jsonl* | head -5'

# 已知 sessionId 时
COMPOSE exec -T qqbot sh -lc 'ls -d /data/dsh/sessions/*/<sessionId>'
```

哪个群对应哪个 sessionId，从 debug 日志里拿（`QQ_LOG_LEVEL=debug` 时才会出现；
被改成 `info` 就先临时调回来）：

```sh
jq -c 'select(.msg=="已派发 prompt") | {time, conversation, sessionId, generation, images}' \
  /tmp/qqbot-24h.log | tail -20
```

`conversation` 就是 OneBot 的群号；`sessionId` 直接对应上面的目录名。

已知会话键（如 `ob11:g748741932`）也可以直接算 hash，不用查 `sessions.json`：

```sh
python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16])' 'ob11:g748741932'
```

session 目录名里就带这个 hash：`qq-<hash>-g<N>-<uuid>`，所以一次 `ls` 就能
把某个群的所有历史 runtime 列出来：

```sh
COMPOSE exec -T qqbot sh -lc 'ls -lt /data/dsh/sessions/*/qq-<hash>-g*'
```

### 4.2 跑拆解脚本

仓库里带了一个脚本（只用 Node 标准库，容器内有 Node 24，不需要装 zstd）：

```sh
COMPOSE cp scripts/analyze-turn-timing.mjs qqbot:/tmp/
COMPOSE exec -T qqbot sh -lc \
  'node /tmp/analyze-turn-timing.mjs --prompt=300 /data/dsh/sessions/*/<sessionId>/session.v*.jsonl.zstd'
```

`--prompt` 会额外打印每轮的第一条用户消息（截断到指定字符数），用来确认两件事：
用户到底问了什么、长任务提示有没有真的注入。不加这个参数时只输出耗时。

（`COMPOSE cp` 不可用时：`COMPOSE exec -T qqbot sh -lc 'cat > /tmp/analyze-turn-timing.mjs' < scripts/analyze-turn-timing.mjs`。）

输出（节选，来自一次调试会话，只看格式）：

```
  turn 1  58.5s  completed  ·  13 步  ·  模型 57.4s (98%)  工具 944ms (2%)  ·  prompt 峰值 37610  output 合计 10121
    step  1  model  1377ms  tool   405ms  step  1785ms  prompt   9034  out   196
    ...
    step 13  model   17.2s  tool     0ms  step   17.2s  prompt  37610  out  2931
```

字段含义：

| 字段 | 含义 |
|---|---|
| `turn N / 总时长 / reason` | 一轮的墙钟与 DSH 的结束原因（`completed` / `error` / `aborted`） |
| `步骤数` | 模型被调用了几次；每次调用都要重发整个 prompt |
| `模型 x%` | 所有 `step/start → assistant/message` 之和，即**等模型**的时间 |
| `工具 y%` | 所有 `tool/call → tool/result` 之和 |
| `step` 行 | 该步的模型耗时 / 工具耗时 / 步总时长 / prompt token / 输出 token |
| `附图 N` | 这轮 prompt 里的 image block 数（当前消息 + 上下文切片，长图一块算一个） |
| `慢工具` | ≥3s 或超时的调用；`[超时]` = 命中工具超时（bash 默认 60s，可传 `timeoutMs` 放宽到 600s） |
| `未结束（没有 turn/end）` | runtime 被超时回收/进程被杀，这一轮没有正常收尾 |

### 4.3 五种典型形状

| 形状 | 证据 | 结论 |
|---|---|---|
| **正常但慢** | 模型占比高，单步 `model` 与 `out` 大致成比例（≈6–10ms/token），没有 60s+ 毛刺 | provider 正常，是任务粒度/回答长度问题 → §5.4 |
| **思考过量** | `prompt` 不大、单步 `out` 也不大，`model` 却 10–20s，且每步都如此 | 思考模式/输出预算 → §5.4、§7.4 |
| **原地打转** | 步数 > 15，`prompt` 每步都在涨，工具里反复出现同一命令/报错 | agent 在试错 → 看工具结果，修任务或收紧提示 |
| **工具卡死** | 工具占比高，`慢工具` 里有 `bash 60.0s [超时]` / `web_fetch` 长尾 | 命令没带 `timeoutMs`，按默认 60s 被杀 → §5.5 |
| **模型单步异常** | 某步 `model` 60s+，但 `out` 很小 | 限流/重试/网络 → §5.6 |

另外单看 `step 1` 的 `prompt`：它是"冷启动回放 + 旁听滚窗 + 附件"的总和。首步就
超过 30k token 时，先查 `config/interaction.yml` 的 `observation.injectWindowMs` /
`maxMessages`（滚窗注入宽度与保留条数）与附件配额，而不是怀疑模型——上下文越大，首字越慢。

---

## 5. 第 3 步：系统与供应商对照

### 5.1 先确认"超时"到底发生在哪

先拉一条时间线（`time` 是毫秒时间戳，`date -d @<秒>` 可转本地时间）：

```sh
jq -r 'select(.msg|test("本轮超时|冷启动回放历史|关闭 runtime|runtime 不可用，重建|并发已满|runtime 池已满")) \
  | [(.time|tostring), .msg, (.conversation // "")] | @tsv' /tmp/qqbot-24h.log | tail -40
```

再单看超时那一轮：

```sh
jq -c 'select(.msg=="本轮超时，将回收 runtime 以终止任务") | {time, conversation, timeoutMs, toolsInvoked}' \
  /tmp/qqbot-24h.log | tail -5

# 按群聚合：是个别群的任务形态问题，还是全局问题
jq -r 'select(.msg=="本轮超时，将回收 runtime 以终止任务") | .conversation' \
  /tmp/qqbot-24h.log | sort | uniq -c | sort -rn
```

| 证据 | 含义 |
|---|---|
| `toolsInvoked` 很大（20+） | 一轮里做了很多工具调用：打转或长任务没派后台 |
| `toolsInvoked` 很小但时间到了 | 卡在模型（单步很久）或单个长工具 |
| `conversation` 集中在一两个群 | 特定任务/会话，不是全局变慢 |
| 分散在所有群 | 系统性问题：provider、网络、容量 |

紧接着看这一轮之后有没有冷启动：

```sh
jq -c 'select(.msg=="冷启动回放历史") | {time, conversation, generation, turns}' /tmp/qqbot-24h.log | tail -5
```

超时后 runtime 被 `pool.drop`，下一条消息必然冷启动；`generation` 递增就是证据。

### 5.2 容量：并发与 runtime 池

云上 compose 给 4C4G 的默认值是 **2 个并发 turn / 4 个 runtime**（`.env` 没有覆盖时）：

```sh
COMPOSE config | grep -E 'QQ_MAX_CONCURRENT_TURNS|QQ_MAX_RUNTIMES|ONEBOT_TURN_TIMEOUT_MS|QQ_TURN_TIMEOUT_MS'
```

```sh
jq -c 'select(.msg=="并发已满，礼貌拒绝本次提问") | {time, inUse, max}' /tmp/qqbot-24h.log | tail
jq -c 'select(.msg=="runtime 池已满且全部在忙/承载后台子代理，等待空闲后再回收")' /tmp/qqbot-24h.log | tail
```

- `并发已满` 出现 = 新消息被直接拒绝，不是慢；
- `runtime 池已满…等待` = 新会话要等别人腾进程，表现为首字极慢；
- 两个长任务就能占满 2 个名额，其他群全部被拒——这是"感觉整体效率低"的常见来源；
- 主动发言的生成轮次**不走**全局并发闸，但会占 runtime 池；它超时同样会 `drop` runtime，
  让该会话的下一条消息冷启动。

**能不能加**：先看 §5.6 的 CPU 限流。4C4G + 2 CPU 限额下，拉到 3 并发通常可以、
4 并发要配合降工具负载；每个 DSH 进程空闲约 175MB。

### 5.3 冷启动与回放

每次 runtime 重建（超时回收、LRU、空闲回收、进程退出）都会：

1. 重新起 DSH 进程并 `initialize`（`dsh.startTimeoutMs` 60s 上限，正常 2–5s）；
2. 铸新 sessionId；
3. 冷启动回放最近 `QQ_REPLAY_TURNS`（默认 12）轮对话进 prompt
   （日志里的 `turns` 是**消息条数**，最多约 24 条 = 12 轮往来）。

日志：

```sh
jq -c 'select(.msg=="关闭 runtime" or .msg=="按 LRU 回收 runtime" or .msg=="空闲回收 runtime" or .msg=="runtime 退出" or .msg=="runtime 不可用，重建") | {time, msg, conversation, code, signal}' \
  /tmp/qqbot-24h.log | tail -20
```

| 证据 | 含义 |
|---|---|
| `关闭 runtime` 紧跟 `本轮超时` | 超时回收，正常但会放大下一条的延迟 |
| `runtime 退出` 带 `code`/`signal` | 进程崩了/OOM（`137` = SIGKILL），查 `dmesg` 与内存 |
| `空闲回收 runtime` 频繁 | `QQ_RUNTIME_IDLE_MS` 太短或流量稀疏，每次回来都要回放 |
| `冷启动回放历史` 的 `turns` 接近 24 | 回放把 12 轮全塞进去了，prompt 首步就很大 |

### 5.4 模型侧：输出长度、思考模式、限流

先用会话日志的 `out` 判断：2–3k output token 的步，10–20s 是正常速度（约 6–10ms/token）。
如果**每步都这样**，一轮 10 步就是 2–3 分钟——这不是 provider 故障，是任务粒度问题。

再排除真正的模型侧问题：

```sh
# DSH 的诊断输出（debug 级别才会进 bot 日志）
jq -r 'select(.msg=="dsh stderr") | .line' /tmp/qqbot-24h.log \
  | grep -Ei '429|rate.?limit|timeout|ETIMEDOUT|ECONN|5[0-9][0-9]|retry' | tail -30
```

典型：限流（429）会触发 DSH 默认重试（最多 5 次、指数退避 0.5s→10s），
一步凭空多 20–30s；重试最终失败时 `turn/end` 的 reason 是 `error`。

**旁听判定也在花同一个 provider 的额度**：`proactive.enabled` 打开时，每条非 @ 群消息
都可能触发一次小模型判定。看 `/health` 的 `proactive` 段：

```sh
curl -s http://127.0.0.1:8080/health | python3 -c 'import json,sys; p=json.load(sys.stdin).get("proactive") or {}; print({k:p.get(k) for k in ("judgeCalls","judgeFailures","spoke","wouldSend")})'
```

`judgeCalls` 与群消息量同量级、同时又出现 429/超时，说明判定在跟主链路抢配额。
临时处置：`config/proactive.yml` 设 `enabled: false`，`COMPOSE restart qqbot`，
观察主链路是否恢复（这会同时关掉主动发言，属预期）。

**思考模式**：`qwen3.8-flash` 是混合思考模型，请求不带关闭参数时默认思考，
延迟和 token 都会上去。当前 `config/local/models.yml` 只选了模型，没有钉思考档位。
要验证这个因素，在一台测试实例上把路由的默认档位钉成 `off`（见 §7.4），
对比同一批问题的 `model` 耗时与答案质量——不要直接在生产上改。

### 5.5 工具：bash 默认 60 秒，单次最多 600 秒

`dsh-base` 的 `bash-sandbox` 配置了 `timeoutMs: 60000`（**默认值**），没有覆盖
`maxTimeoutMs`（执行器默认 600000）。于是：

- 调用不带 `timeoutMs` → 60s 被杀，工具结果里是 `[timed out after 60000ms]`；
- 调用带 `timeoutMs` → 按请求值，但被 `maxTimeoutMs` 截到 600s。

模型经常不带这个参数，于是编译/爬取/批量处理这类命令 60s 一次被杀、换个命令重试……
直到整轮超时。会话日志里会以 `慢工具: bash 60.0s [超时]` 出现。

处置：

- 已知长命令在调用时显式传 `timeoutMs`（≤600000）；
- 或后台化（`命令 > .task.log 2>&1 &`，后续轮次轮询日志）/拆步；
- 真要放宽默认值，在 profile 覆盖 `bash-sandbox.timeoutMs`（默认值）与
  `maxTimeoutMs`（上限），但别让单条命令接近一轮 turn 的时限。

```sh
# 把 §4.2 的脚本放进容器后，扫最近 20 个会话，只留超时/慢工具行
COMPOSE exec -T qqbot sh -lc '
for f in $(ls -t /data/dsh/sessions/*/qq-*/session.v*.jsonl* | head -20); do
  node /tmp/analyze-turn-timing.mjs "$f"
done' | grep -E '^===|慢工具|⚠'
```

单个会话看不出规律时，再按群维度看 §3 的端到端分布。

### 5.6 系统：CPU 限流、内存、网络

```sh
COMPOSE exec -T qqbot cat /sys/fs/cgroup/cpu.stat
docker stats --no-stream qqbot
```

`cpu.stat` 里：

- `nr_throttled / nr_periods` > 5%：容器被 CPU 限额压住了，工具命令和 JSON 解析都会变慢；
- `throttled_usec` 持续增长：同上，调参前先解决资源。

内存：

```sh
COMPOSE exec -T qqbot sh -lc 'cat /sys/fs/cgroup/memory.current; cat /sys/fs/cgroup/memory.events'
docker inspect qqbot-dsh --format 'OOMKilled={{.State.OOMKilled}} Restarts={{.RestartCount}}'
```

网络与供应商首字节（用生产同一把 key，走容器内环境变量）：

```sh
COMPOSE exec -T qqbot sh -lc '
  BASE=$(sed -n "s/^ *baseURL: *//p" /data/bot/model-api.patch.yml | tr -d "\"" | head -1)
  echo "baseURL=$BASE"
  curl -sS -o /dev/null -w "dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} http=%{http_code}\n" \
    --max-time 60 "$BASE/chat/completions" \
    -H "Authorization: Bearer $QWEN_TOKEN_PLAN_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"qwen3.8-flash\",\"stream\":true,\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}"
'
```

| 结果 | 结论 |
|---|---|
| dns/tcp/tls 都 < 300ms，TTFB 1–3s | 网络正常，慢在输出长度/步数 |
| TTFB > 20s | 供应商排队或出口问题 |
| `http=429` | 限流：看 §5.4 的重试日志，考虑切 lane 或错峰 |
| `http=401` | key 与 baseURL 不是同一渠道（千问 Token Plan 的常见坑） |
| 超时/连接失败 | 云主机出网、DNS、安全组 |

> key 变量名以 `models.yml` 里该路由的 `apiKeyEnv` 为准（上面按千问路由写死成
> `QWEN_TOKEN_PLAN_API_KEY`；切回方舟要换成 `ARC_CODE_API_KEY`，模型名也要换）。
> 命令里的 key 会以参数形式短暂出现在容器 `ps` 中；介意的话改用
> `COMPOSE exec -T qqbot node -e '...fetch...'`，从 `process.env` 读 key。

### 5.7 图片输入：更慢，也更容易失败

图片不是"多一个附件"，它会改变一轮的耗时结构：

1. **切片放大 prompt**：一张长截图按 64 万像素切块，单张最多 `maxImageTiles`（12）块；
   一条消息最多 4 张图，整条 prompt 的 image block 上限 20。运行时每一步模型调用都
   会带着这些块重新请求 → prompt token 与首字延迟一起涨。
2. **准入失败会丢图**：runtime 拒收时桥接层退回纯文本重试（日志
   `带图片的 prompt 被 runtime 拒绝，退回纯文本重试`），用户看到的是"图片没读进来"，
   不是报错——这是**软失败**。
3. **取图发生在 turn 计时之外**：OneBot 的 URL 过期会走 `get_file` 回查，每张
   `downloadTimeoutMs`（15s），4 张最坏 60s。用户干等，但不计入 600s。
4. **provider 侧**：图片块让单步输入变大，视觉 token 与文本一起排队/计费。

先量化图片侧的失败（宿主机日志）：

```sh
grep -c '带图片的 prompt 被 runtime 拒绝' /tmp/qqbot-24h.log
grep -c '部分图片未能读入' /tmp/qqbot-24h.log
grep -c '上下文里的部分图片未能读入' /tmp/qqbot-24h.log
grep -c '下载图片失败' /tmp/qqbot-24h.log
grep -c '图片无法解码' /tmp/qqbot-24h.log
```

再做 A/B：含图轮的耗时/超时率是否真的比纯文本高（容器内跑，读对话记录）：

```sh
COMPOSE exec -T qqbot python3 - <<'PY'
import glob, json, statistics, time
cutoff = (time.time() - 24 * 3600) * 1000
rows = []
for path in glob.glob('/data/bot/conversations/*.jsonl'):
    last = None
    for line in open(path, encoding='utf-8'):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get('role') == 'user':
            last = r
            continue
        if r.get('role') != 'assistant' or last is None:
            continue
        if (last.get('ts') or 0) < cutoff:
            last = None
            continue
        reply = str(r.get('text') or '')
        rows.append(('[图片' in str(last.get('text') or ''),
                     ((r.get('ts') or 0) - (last.get('ts') or 0)) / 1000,
                     '单轮时限' in reply, '出错了' in reply))
        last = None

for flag, label in [(True, '含图片'), (False, '纯文本')]:
    xs = [r for r in rows if r[0] == flag]
    if not xs:
        print(label, '无数据')
        continue
    secs = sorted(r[1] for r in xs)
    p90 = secs[max(0, int(len(secs) * 0.9) - 1)]
    print(f"{label}: n={len(xs)} 超时={sum(r[2] for r in xs)} 出错={sum(r[3] for r in xs)} "
          f"中位={statistics.median(secs):.1f}s p90={p90:.1f}s")

print('最慢 5 轮:')
for img, sec, timeout, error in sorted(rows, key=lambda x: x[1], reverse=True)[:5]:
    print('图' if img else '文', f'{sec:.1f}s', '超时' if timeout else ('出错' if error else 'ok'))
PY
```

如果含图轮的 p90/超时率明显更高，先动这几个旋钮（改 `.env` 后 `COMPOSE up -d`）：

| 参数 | 默认 | 建议先调到 | 代价 |
|---|---|---|---|
| `BOT_ATTACHMENT_MAX_IMAGE_TILES` | 12 | 6 | 更长的截图会被截断/缩小 |
| `BOT_ATTACHMENT_MAX_IMAGES` | 4 | 2 | 单条消息只读前 2 张 |
| `BOT_ATTACHMENT_MAX_BYTES` | 8MiB | 3MiB | 大图先降采样，清晰度下降 |
| `BOT_OBSERVATION_INJECT_IMAGES` | 2 | 1 或 0 | 上下文里的图不再自动带入 |

如果日志里主要是"runtime 拒绝 → 纯文本重试"，那是准入问题而不是速度问题：
按 `error` 字段（`TOO_MANY_IMAGES` / `IMAGE_DIMENSION_TOO_LARGE` 等）对照
RUNBOOK §4.5；这类图本来就会被切片/降采样救回来，救不回来的说明平台给的字节
本身解不开（`图片无法解码`）。

---

## 6. 判据总表

| 证据（日志/指标） | 结论 | 处置 |
|---|---|---|
| `timedOut` 涨、`toolsInvoked` 大、步数 > 15 | 长任务在本轮同步跑/打转 | 派子代理；`/stop`；收紧提示（§7.5） |
| `慢工具: bash 60.0s [超时]` | 命令没带 `timeoutMs`，按默认 60s 被杀 | 显式传 `timeoutMs`/后台化/拆步（§7.5） |
| 模型步进 60s+、`out` 很小、`dsh stderr` 有 429 | 限流/重试 | 切 lane、降并发、错峰 |
| `prompt` 首步就 3–4 万、`冷启动回放历史` 多 | 回放/上下文膨胀 | 降 `QQ_REPLAY_TURNS`、收紧观察窗口（§7.3） |
| 含图轮 p90 明显高于纯文本、`prompt` 首步很大 | 长截图切片把 prompt 撑大 | 降 `BOT_ATTACHMENT_MAX_IMAGE_TILES`/`MAX_IMAGES`（§5.7） |
| 反复出现 `带图片的 prompt 被 runtime 拒绝` | 图片准入失败，退化成纯文本 | 看 error 字段；调小图片配额（§5.7、RUNBOOK §4.5） |
| `runtime.size` 反复归零、`关闭 runtime` 紧跟超时 | 超时→冷启动正反馈 | 先减少超时（§7.1/7.5） |
| `并发已满` / `inFlight` 顶满 | 容量不足 | 加并发前先看 `cpu.stat`（§7.2） |
| `runtime 池已满…等待` | runtime 上限太小 | 调 `QQ_MAX_RUNTIMES` |
| `runtime 退出` code=137 | OOM/被杀 | 查 `memory.events`、`OOMKilled`，降并发/加内存 |
| `发送回复失败` + 40034105/401 | 通道问题，不是模型 | 看 RUNBOOK §4.2 |
| 端到端慢但会话日志 `turn` 很短 | 慢在轮外：话题判定/排队/冷启动 | 看 §3 的差值与 `busyNoticed` |

---

## 7. 处置手册

### 7.1 先止血

1. 管理员在群里发 `/stop`：立刻中断该会话在途 turn（会回收 runtime，
   连带终止它承载的后台子代理）。
2. 多个群同时卡死：`COMPOSE restart qqbot`（所有 runtime 重建，代价是全部冷启动）。
3. 确认不是通道问题：`connectors.onebot.state` 必须是 `connected`。

### 7.2 容量

```sh
# 当前生效值（env > compose > config 默认）
COMPOSE config | grep -E 'QQ_MAX_CONCURRENT_TURNS|QQ_MAX_RUNTIMES'
```

- 4C4G 建议上限：并发 3、runtime 6；2C4G 保持 2/4；
- 改 `.env` 后 `COMPOSE up -d`（不需要重建镜像）；
- 前提：`cpu.stat` 的限流比例不高、`memory.current` 有余量。

### 7.3 冷启动与上下文

| 参数 | 默认 | 作用 | 风险 |
|---|---|---|---|
| `QQ_REPLAY_TURNS` | 12 | 冷启动回放轮数 | 调太小人设/约定会丢 |
| `QQ_RUNTIME_IDLE_MS` | 1800000 | 空闲回收 | 调大占内存（每进程 ~175MB） |
| `QQ_MAX_RUNTIMES` | 8（云上 4） | runtime 上限 | 调大占内存 |

观察窗口与附件配额在 `config/media.yml` / `config/interaction.yml`，prompt 峰值
（§4 的 `prompt` 列）持续 > 60k 时再动它们，否则收益不大。

### 7.4 模型侧

改 `config/local/models.yml`，`COMPOSE restart qqbot` 生效（配置是挂载的，不用重建镜像）。

```yaml
models:
  providers:
    qwen-token-plan:
      apiKeyEnv: QWEN_TOKEN_PLAN_API_KEY
      baseURL: https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1
      # 关掉默认思考（先在一台测试实例上验证答案质量）
      reasoning: off                 # off | minimal | low | medium | high | xhigh | max
      # 以下按需，不写就沿用 DSH 默认
      timeoutMs: 120000              # 单次请求总超时
      streamIdleTimeoutMs: 60000     # 流长时间没有新字节就失败，避免干等到 turn 超时
      retryPolicy:
        mode: normal
        maxRetries: 2                # 默认 5；限流频繁时降低，快速失败而不是叠加 30s
```

> 只演示要改的键；`baseURL`/`apiKeyEnv` 保留你现有的渠道值（key 与 endpoint 必须同源）。
> 该模型是否支持 `off` 取决于 pi-ai 目录条目：先在测试实例上 `COMPOSE restart` 并跑一轮验证，
> 不要直接改生产。

**切模型**做 A/B 时，一次只改 `dsh.model` 一行，并保留旧值；判断标准是
§3 的中位端到端与 §4 的 `model` 耗时，不是体感。

### 7.5 长任务的正确姿势

1. **派子代理**：`subagent` 后台运行，父轮次立刻结束，会话不再被占住。
   桥接层已经做了两层补强：
   - `dsh-profile` 的人设里写了"复杂/长耗时/多步骤必须后台派发"；
   - `config/interaction.yml` 的 `hints.longTask.patterns` 命中关键词会再注入一次提示。
   如果某类任务总是漏派（例如"整理这份表格"），把词加进 `BOT_HINT_LONG_TASK_PATTERNS`。

2. **bash 默认 60s、最多 600s**：已知长命令在调用时显式传 `timeoutMs`（≤600000），
   或后台化：`命令 > .task.log 2>&1 &`（写工作区，别写 `/tmp`：容器里 `/tmp` 是
   256MB tmpfs），后续轮次 `tail`/`grep` 轮询；或拆成多步。

3. **不要指望 `run_in_background`**：本 profile 关掉了 `tool-jobs`（`dsh-profile/cordis.patch.yml`
   的 `- id: tool-jobs / disabled: true`），而 bash 的 `run_in_background` 依赖
   `job_output` / `job_kill` 收取结果——模型拿到 job id 却读不到输出，会反复尝试。
   会话日志里若出现"未知工具 job_output"/"tool not found"一类结果，就是踩到了这里。
   要么恢复 `tool-jobs`，要么在提示里明确禁止 `run_in_background`。

4. **超时上限**：
   - OneBot：`ONEBOT_TURN_TIMEOUT_MS` 默认 600000，上限 3600000；
   - 官方：`QQ_TURN_TIMEOUT_MS` 默认 240000，上限 295000（必须小于 5 分钟被动窗口）。

   调大只是把"失败"推迟，不解决会话被占住的问题；优先派子代理。

---

## 8. 常见误判

| 直觉 | 实际 |
|---|---|
| "模型 API 变慢了" | 多数是输出长/步数多，或 bash 60s 超时在重试 |
| "网络有问题" | 先看 `prompt` 首步大小与 `冷启动回放历史`，回放也会让首字变慢 |
| "超时是模型失败" | 超时是桥接层到点回收；真正失败看 `turn/end` 的 reason |
| "加并发就好了" | 2 个长任务就能占满默认并发，加并发只是让更多任务一起慢 |
| "重启能解决" | 重启清掉所有 runtime，下一轮全部冷启动，短期更慢 |
| "日志里没有错误就是正常" | 慢不一定有错误日志，必须看对话记录/会话日志的耗时 |

---

## 9. 取证包（上报/复盘用）

```sh
COMPOSE ps > /tmp/qqbot-ps.txt
COMPOSE logs --no-log-prefix --since 6h qqbot > /tmp/qqbot-6h.log
curl -s http://127.0.0.1:8080/metrics > /tmp/qqbot-metrics.json
COMPOSE exec -T qqbot cat /sys/fs/cgroup/cpu.stat > /tmp/qqbot-cpu.stat
COMPOSE exec -T qqbot cat /data/bot/sessions.json > /tmp/qqbot-sessions.json
COMPOSE exec -T qqbot sh -lc 'ls -lt /data/dsh/sessions/*/qq-*/session.v*.jsonl* | head -20' > /tmp/qqbot-session-files.txt
docker stats --no-stream qqbot > /tmp/qqbot-stats.txt
docker inspect qqbot-dsh --format 'Image={{.Config.Image}} OOMKilled={{.State.OOMKilled}} Restarts={{.RestartCount}}' > /tmp/qqbot-inspect.txt
```

`/tmp/qqbot-6h.log` 已脱敏（`access_token`、`sk-`、`QQ_APP_SECRET` 会变成 `<redacted>`），
但 `docker compose config` **不要**直接发——它会把 `.env` 解析进环境变量。

---

## 10. 长期：建议补的观测（可选）

当前只有计数，没有耗时分布。要在下一次故障时少花时间，建议加三处打点
（都要改代码，别在排障时顺手做）：

1. `本轮超时` 日志补 `elapsedMs` 与 `sessionId`；
2. turn 正常结束也打一条 `info`：`elapsedMs` / `steps` / `toolsInvoked` / `generation`；
3. `/metrics` 增加端到端耗时的 p50/p95（滑动窗口），以及 `turnTimeout` 按会话的计数。

在补齐之前，§3/§4 的两份 JSONL 就是最可靠的耗时来源。
