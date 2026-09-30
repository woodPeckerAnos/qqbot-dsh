---
rule: duplicate-event
stage: intake
order: 4
params: []
stats: halt_duplicate_event
---

# 原始需求

（首批手写规则，模板定稿件，无生成口输入。）

# 需求描述

社区框架在重连 / 重放时会把同一条消息再推一遍。旁听缓冲是同话题判定的依据，
重复条目会虚增活跃度、干扰采样计数，所以同一条事件（按带平台命名空间的
eventId）只进入旁听缓冲一次，重放的直接丢弃。

去重只做内存级（每群一个 LRU 集合，容量 500）：绝大多数重复是网关重连后的
短时间重放，内存足够；旁听消息**不进** SeenStore 的磁盘层——那里是
「一条消息一个标记文件」，活跃群的全量旁听会刷爆小文件目录。

# 判定

- 输入：一条 observed 消息
- 条件 A：`ctx.trigger !== 'message'`（定时器重入，如 answer-window 答案窗口
  到期的重查）→ pass（重入是 runner 内部行为，不是平台重放，不参与去重）
- 条件 B：`ctx.message` 为空 → `halt('no-message')`（fail-closed）
- 条件 C：`state.hasSeen(message.eventId)` 为真 → `halt('duplicate')`
- 否则 → pass（eventId 的**记录**由 runner 在消息入缓冲时完成，
  规则保持纯函数不写状态）

# 参数

无。

# 验收标准

1. 事件首次到达（eventId 未见过）→ pass；
2. 同一 eventId 再次到达（已被 runner 记录过）→ halt('duplicate')；
3. eventId 为空串的消息不去重（无法判定，按首次处理）→ pass；
4. 无消息上下文 → halt('no-message')；
5. 非 message 触发（trigger='answer-window'）→ 已认领的 eventId 也 pass。

# 背景与调研来源

既有用户消息路径的去重是两层（内存 LRU + 磁盘标记，见 store/seen.ts 头注）；
旁听路径刻意只保留内存层，理由见 docs/TOPIC-INTERVENTION-PLAN.md §7.3。
