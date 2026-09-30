---
rule: admission-try
stage: speak
order: 32
params: []
stats: halt_busy
---

# 原始需求

（手写规则，模板定稿传统；对应方案 §5.2 清单与 §9.5 准入 try 语义。）

# 需求描述

介入**绝不排队**：发言前检查准入可行性——该群会话锁被占（有 turn 在途）
或全局并发无名额，就放弃本次介入（计数离开），不与用户提问抢资源。
本规则是**预检**（读取 runner 注入的状态位）；真正的原子 try
（tryRunExclusive：拿到名额与会话锁才算数）由 runner 在链全过后执行。
预检与原子 try 之间的竞态窗口无害：最坏情况是白跑一次 Gate 判定。

# 判定

- 输入：共享状态的 inFlight 位与 runner 注入的 admissionFree 探测位
- 条件 A：`state.inFlight === true`（会话锁被占）→ `halt('inflight')`
- 条件 B：`ctx.admissionFree === false`（全局并发满）→ `halt('busy')`
- 否则（含 admissionFree=undefined 无探针）→ pass

# 参数

无。

# 验收标准

1. 会话有 turn 在途 → halt('inflight')；
2. 全局并发满（admissionFree=false）→ halt('busy')；
3. 都空闲 → pass；
4. 无探针（admissionFree=undefined）且锁空闲 → pass。

# 背景与调研来源

方案 §9.5：介入绝不排队——排到时话题早已翻篇。
