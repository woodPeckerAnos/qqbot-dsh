---
rule: promotion-window
stage: continuation
order: 40
params:
  - name: windowMs
    default: 120000
    meaning: 续聊窗口时长（毫秒）；@ turn 派发后开窗，每次晋升后重置
stats: halt_no_window
---

# 原始需求

（手写规则，模板定稿传统——本仓库开发环境无 LLM 密钥，未走生成口；
对应方案 docs/TOPIC-INTERVENTION-PLAN.md §8.1。）

被 @ 破冰之后，同一发送者短时间内的后续消息不要再要求 @——
在窗口期内的跟进消息直接当作对机器人的继续提问。

# 需求描述

被 @ 消息触发的 turn **派发后**，为该（会话, 发送者）打开续聊窗口
（默认 120s，每次晋升后重置；开窗/重置由 runner 执行）。窗口内该发送者的
observed 消息满足全部条件即**晋升**为正常提问：还原成
`NormalizedMessage`（`origin:'continuation'`，eventId 用平台真实 id）回投
Orchestrator，走完整既有 Ingress 管线（去重、命令、谷时段闸、记录、准入
一个不少），与 @ 消息在成本与安全上完全同权。

本规则只判定「是否具备晋升资格」（窗口、内容形态、非重复），不具备资格
不是拒绝——消息落回 intake 链按普通旁听处理。晋升的执行（还原、回投、
窗口重置）由 runner 完成；turn 在途时的去向由下游 41 号规则判定。

# 判定

- 输入：一条 observed 消息（定时器触发时 `ctx.message` 为空）
- 条件 A：无消息（非消息触发）→ `halt('no-message')`
- 条件 B：该发送者无窗口或窗口已过期（`state.continuationWindowUntil(senderId)`
  为空或 `now > until`）→ `halt('no-window')`
- 条件 C：重复事件（`state.hasSeen(eventId)`）→ `halt('duplicate')`
- 条件 D：`message.atOthers === true`（@ 了其他成员）→ `halt('at-others')`
- 条件 E：文本以 `/` 开头（管理员命令形态）→ `halt('command')`
- 条件 F：纯媒体占位（全文形如 `[图片]`/`[语音]`/`[视频]`/`[文件]`，无实际
  文本）→ `halt('no-text')`
- 全过 → `mark({ promote: true })`（不直接 pass：晋升资格必须显式标注，
  防止本规则被配置停用后链放行被误当晋升）

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `windowMs` | 120000 | 续聊窗口时长（毫秒）；runner 用它开窗与晋升后重置 |

# 验收标准

1. 窗口内、有文本、未 @ 他人、非命令、非重复 → mark({ promote: true })；
2. 该发送者无窗口或窗口已过期 → halt('no-window')；
3. 重复 eventId → halt('duplicate')；
4. @ 了其他成员（atOthers=true）→ halt('at-others')；
5. 内容以 / 开头（命令）→ halt('command')；
6. 纯媒体占位文本（如 `[图片]`）→ halt('no-text')；
7. 非消息触发（ctx.message 为空）→ halt('no-message')。

# 背景与调研来源

生态共识：koishi-plugin-dialogue 的「称呼被喊出后短窗口内激活宽松概率」、
QChatGPT/AstrBot 的 lcid（@ 后一段时间视为续聊）。窗口时长与重置语义见
docs/TOPIC-INTERVENTION-PLAN.md §8.1；晋升回投走完整管线是「与 @ 同权」
原则的兑现（方案 §5.4 ①）。
