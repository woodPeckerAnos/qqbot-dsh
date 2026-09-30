---
rule: no-text
stage: intake
order: 6
params: []
stats: halt_no_text
---

# 原始需求

（手写规则，模板定稿传统；对应方案 §5.2 清单。）

# 需求描述

纯媒体/占位消息（纯图片、语音、视频、文件，扁平化后只剩 `[图片]` 这类
占位符）没有可供 Gate 判定的文本语义——不参与介入评估。但它仍是上下文
（「有人发了张图」这个事实对后续判定有用），所以**拦截但入缓冲**。

# 判定

- 输入：一条 observed 消息
- 条件 A：无消息（非消息触发）→ `halt('no-message')`（不入缓冲）
- 条件 B：全文只由占位符构成（`[xxx]` 一段或多段，无其他文字）→
  `halt('no-text', buffer: true)`
- 否则 → pass

# 参数

无。

# 验收标准

1. 纯占位文本（如 `[图片]`、`[图片][图片]`）→ halt('no-text') 且 buffer=true；
2. 占位符之外还有文字（如 `[图片] 看这个`）→ pass；
3. 普通文本 → pass；
4. 非消息触发 → halt('no-message') 且不带 buffer。

# 背景与调研来源

observed 消息 v1 不下载媒体（方案 §7.1），纯媒体消息对 Gate 没有信息量。
