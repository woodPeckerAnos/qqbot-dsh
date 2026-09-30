---
rule: at-others
stage: intake
order: 5
params: []
stats: halt_at_others
---

# 原始需求

（手写规则，模板定稿传统；对应方案 §5.2 清单。）

# 需求描述

群里 @ 了其他成员的消息是群员之间的对话，不是在叫 bot——不参与介入评估。
但它仍是话题上下文（bot 若稍后介入，需要知道这段对话发生过），所以
**拦截但入缓冲**（halt + buffer）。

# 判定

- 输入：一条 observed 消息
- 条件 A：无消息（非消息触发）→ `halt('no-message')`（不入缓冲）
- 条件 B：`message.atOthers === true` → `halt('at-others', buffer: true)`
- 否则 → pass

# 参数

无。

# 验收标准

1. atOthers=true → halt('at-others') 且 buffer=true（入缓冲不评估）；
2. atOthers=false → pass；
3. 非消息触发 → halt('no-message') 且不带 buffer。

# 背景与调研来源

bl-chat-plugin 的 R 信号体系把「@ 别人」当负向信号；本仓库把它做成硬拦截
（@ 机器人的消息根本不会成为 observed，由适配器分流保证）。
