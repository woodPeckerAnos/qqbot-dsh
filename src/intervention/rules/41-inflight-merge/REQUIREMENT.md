---
rule: inflight-merge
stage: continuation
order: 41
params:
  - name: maxPending
    default: 5
    meaning: pending 合并队列容量上限（超限丢最旧并计数，runner 执行）
  - name: maxAgeMs
    default: 60000
    meaning: pending 条目保鲜期（毫秒；入队与冲刷时淘汰过期条目，runner 执行）
stats: mark_merge
---

# 原始需求

（手写规则，模板定稿传统——本仓库开发环境无 LLM 密钥，未走生成口；
对应方案 docs/TOPIC-INTERVENTION-PLAN.md §8.2。）

bot 正在回答的时候，用户连发的跟进消息不要一条条排队等执行，
攒起来等这一轮结束后合并成一条再处理。

# 需求描述

续聊晋升的消息到达时，如果该会话的 turn 正在途中（会话锁被占），
**不排队阻塞**——DSH 没有取消/插入 API，排队等待的旧消息到执行时语境
已过期，逐条执行还会刷屏。改为进入该会话的 pending 合并队列；turn 结束
后若队列非空且条目仍在续聊窗口与保鲜期内，由 runner 合并为一条
（`「用户连发多条，合并处理：\n1. …\n2. …」`，多发送者时每行带发送者名）
再走一次完整管线。容量上限默认 5 条、保鲜期默认 60s，超限丢最旧并计数
（`continuationsDropped`）。

本规则只做一层判定：**当前是否该转入合并队列**。队列的淘汰、合并、冲刷、
回投都是 runner 的事（参数从本规则的 params 生效值读取）。

被 @ 消息本身**永不**进 pending——force 路径直接走管线（在途时照旧被
KeyedMutex 串行，现状语义不改）。

# 判定

- 输入：一条已被上游 40 号规则标注 `promote` 的 observed 消息
- 条件 A：无消息（非消息触发）→ `halt('no-message')`
- 条件 B：`state.inFlight === false`（无在途 turn）→ pass（runner 直接晋升回投）
- 否则 → `mark({ merge: true })`（promote 标注保留，runner 据此入队）

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `maxPending` | 5 | pending 队列容量上限；超限丢最旧并计数（runner 执行） |
| `maxAgeMs` | 60000 | pending 条目保鲜期；入队与冲刷时淘汰过期条目（runner 执行） |

# 验收标准

1. turn 在途（inFlight=true）→ mark({ merge: true })，消息转入 pending 队列；
2. 无在途 turn（inFlight=false）→ pass，runner 直接晋升回投；
3. 非消息触发（ctx.message 为空）→ halt('no-message')。

# 背景与调研来源

对齐生态「回复去抖 + 让步」共识（bl-chat-plugin 的回复去抖），理由与
DSH 无取消 API 的约束见 docs/TOPIC-INTERVENTION-PLAN.md §8.2。
