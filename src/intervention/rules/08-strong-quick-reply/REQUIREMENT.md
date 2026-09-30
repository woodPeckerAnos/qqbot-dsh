---
rule: strong-quick-reply
stage: intake
order: 8
params:
  - name: quickResponseMs
    default: 30000
    meaning: bot 发言后被视为「快速回应」的窗口（毫秒）
stats: mark_quick_reply
---

# 原始需求

（手写规则，模板定稿传统；对应方案 §5.2 清单 R1。）

# 需求描述

bot 刚说完话的 30 秒内，群里出现的文本消息大概率是在回应 bot——标为
强信号（`quick-reply`），让评估更快发生（08 号冷却更短、13 号直接放行
进评估）。本规则只标注、不拦截。bot 发言时刻由 runner 在每次回复交付
时记账（@ 回复与介入都算）。

# 判定

- 输入：一条 observed 消息；共享状态的 bot 最近发言时刻
- 条件 A：无消息（非消息触发）→ `halt('no-message')`
- 条件 B：`state.botLastSpokeAt` 非空且 `now - botLastSpokeAt <=
  params.quickResponseMs` → `mark({ strongSignal: 'quick-reply' })`
- 否则 → pass

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `quickResponseMs` | 30000 | 快速回应窗口 |

# 验收标准

1. bot 20s 前发言过 → mark({ strongSignal: 'quick-reply' })；
2. bot 40s 前发言过 → pass；
3. bot 从未发言 → pass；
4. 非消息触发 → halt('no-message')。

# 背景与调研来源

bl-chat-plugin 的 R1 强信号（bot 发言后的快速回应）。
