---
rule: strong-open-question
stage: intake
order: 10
params:
  - name: answerWindowMs
    default: 90000
    meaning: 问句的答案窗口（毫秒）；窗口内无人应答才标强信号
stats: mark_open_question
---

# 原始需求

（手写规则，模板定稿传统；对应方案 §5.2 清单 R3 与 §9.1 的 defer 机制。）

# 需求描述

「有人问了没人答」是任务型助手最该介入的场景。但问句刚出现时不该立刻
介入——群友可能正在打字。所以问句先挂 90s 答案窗口（`defer`），窗口内
有其他人应答就作罢；无人应答才标强信号（`open-question`）进入评估。

机制分工（本规则纯判定，副作用归 runner）：
  - 首过（trigger='message'）：是问句 → `defer(answerWindowMs)`，runner
    把消息入缓冲并挂定时器；
  - 重查（trigger='answer-window'，message 携带原始问句）：检查缓冲里
    该问句之后是否有**其他发送者**的消息（有 = 有人应答 → halt('answered')；
    没有 → mark 强信号）。

# 判定

- 条件 A：无消息 → `halt('no-message')`
- trigger='answer-window'（答案窗口到期的重查）：
  - B：缓冲里存在 ts 晚于该问句、发送者不同、且非纯占位的条目 →
    `halt('answered')`
  - 否则 → `mark({ strongSignal: 'open-question' })`
- trigger='message'（首过）：
  - C：文本是问句（以 ？/? 结尾，或含「吗/呢/怎么/为什么/哪/谁/啥/如何/
    有没有/能否」等疑问词）→ `defer(answerWindowMs, 'answer-window')`
  - 否则 → pass

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `answerWindowMs` | 90000 | 答案窗口时长 |

# 验收标准

1. 首过问句（「这个怎么部署？」）→ defer(90000, 'answer-window')；
2. 首过非问句 → pass；
3. 重查时问句后有他人应答 → halt('answered')；
4. 重查时无人应答（缓冲里只有问句自己或其后只有本人消息）→ mark(open-question)；
5. 非消息触发且无消息 → halt('no-message')。

# 背景与调研来源

bl-chat-plugin 的 R3 强信号；「先挂窗口再判定」对齐其 waitTool 的延迟
语义（方案 §9.1）。
