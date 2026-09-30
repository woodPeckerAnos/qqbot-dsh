---
rule: strong-quote-bot
stage: intake
order: 9
params:
  - name: quoteWindowMs
    default: 600000
    meaning: 启发式判定里「bot 近期发言」的追溯窗口（毫秒）
stats: mark_quote_bot
---

# 原始需求

（手写规则，模板定稿传统；对应方案 §5.2 清单 R2。）

# 需求描述

有人引用（回复）了 bot 说过的消息——这几乎必然是在跟 bot 说话，标为
强信号（`quote-bot`）。只标注、不拦截。

判定的诚实边界：observed 消息只带被引消息的 id、不回查内容（方案 §7.2），
而 bot 自己发的消息不会出现在旁听缓冲里（bot 的消息不经过 watcher）。
所以分两层：
  1. 精确：被引 msgId 命中 runner 记录的 bot 发言 msgId 集（官方通道回传时
     可用）→ 确定是引用 bot；
  2. 启发式：被引 msgId **不在**旁听缓冲（说明引的不是近期群友消息）且 bot
     在追溯窗口内发言过 → 很可能是引用 bot。
引用了缓冲里群友消息的，是群员间对话，不标注。

# 判定

- 输入：一条 observed 消息
- 条件 A：无消息（非消息触发）→ `halt('no-message')`
- 条件 B：`message.quotedMsgId` 为空 → pass
- 条件 C：`state.botHasSpoken(quotedMsgId)`（精确命中）→
  `mark({ strongSignal: 'quote-bot' })`
- 条件 D：quotedMsgId 不在旁听缓冲 且 `state.botLastSpokeAt` 在
  `params.quoteWindowMs` 窗口内（启发式）→ `mark({ strongSignal: 'quote-bot' })`
- 否则（引用了缓冲里的群友消息，或 bot 近期没说过话）→ pass

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `quoteWindowMs` | 600000 | 启发式判定的 bot 发言追溯窗口 |

# 验收标准

1. 引用的 msgId 精确命中 bot 发言集 → mark(quote-bot)；
2. 引用的 msgId 不在缓冲且 bot 5 分钟前发言过 → mark(quote-bot)；
3. 引用的 msgId 在旁听缓冲里（引的是群友）→ pass；
4. 无引用 → pass；
5. 引用不在缓冲但 bot 从未发言 → pass；
6. 非消息触发 → halt('no-message')。

# 背景与调研来源

bl-chat-plugin 的 R2 强信号（引用 bot 消息）。启发式层的误报代价只是
多一次 Gate 判定，可接受；精确层依赖平台回传发送 id（OneBot 拿不到时
自动退化为纯启发式）。
