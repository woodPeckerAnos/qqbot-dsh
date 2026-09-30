---
rule: strong-keyword-echo
stage: intake
order: 11
params: []
stats: mark_keyword_echo
---

# 原始需求

（手写规则，模板定稿传统；对应方案 §5.2 清单 R4。）

# 需求描述

群消息命中了 bot 上次发言里的实词关键词——大概率是在接着 bot 的话题
说，标为强信号（`keyword-echo`）。只标注、不拦截。关键词由 runner 在
bot 每次发言交付时从文本提取（≥2 连续 CJK 字符或 ≥3 拉丁字母，去停用词，
上限 20 个；见 state.ts 的 extractKeywords）。

# 判定

- 输入：一条 observed 消息；共享状态的 bot 关键词集
- 条件 A：无消息（非消息触发）→ `halt('no-message')`
- 条件 B：`state.botKeywords` 中任意词出现在消息文本里 →
  `mark({ strongSignal: 'keyword-echo' })`
- 否则 → pass

# 参数

无。

# 验收标准

1. 消息含 bot 关键词（如 bot 说过「用索引优化」后有人说「索引」）→
   mark(keyword-echo)；
2. 消息不含任何关键词 → pass；
3. bot 关键词集为空 → pass；
4. 非消息触发 → halt('no-message')。

# 背景与调研来源

bl-chat-plugin 的 R4 强信号（关键词回声）。朴素关键词匹配的误报代价只是
多一次 Gate 判定。
