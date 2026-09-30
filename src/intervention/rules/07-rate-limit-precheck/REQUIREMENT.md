---
rule: rate-limit-precheck
stage: intake
order: 7
params:
  - name: maxPer10Min
    default: 3
    meaning: 每群 10 分钟内允许的最大主动介入次数
  - name: maxPerHour
    default: 8
    meaning: 每群 1 小时内允许的最大主动介入次数
stats: halt_rate_limited
---

# 原始需求

（手写规则，模板定稿传统；对应方案 §5.2 清单与 §9.3 硬限流。）

# 需求描述

该群的主动介入已达硬限流（10 分钟 ≤3 次且 1 小时 ≤8 次）时，连 Gate 评估
都不再做——评估本身也花 API 钱，限流期间评估出来也会被 30 号规则否决。
本规则是**省钱的前置检查**；30 号规则在 speak 链做最终复核（双闸）。

窗口计数只含主动介入发言（@ 回复不计）。限流命中时 runner 会把相位强制
降为 fading（冷却），本规则只管判定。

# 判定

- 输入：一条 observed 消息；共享状态的介入发言滑动窗口
- 条件 A：`countSpokeSince(now - 10min) >= params.maxPer10Min` →
  `halt('rate-limited-10min')`
- 条件 B：`countSpokeSince(now - 1h) >= params.maxPerHour` →
  `halt('rate-limited-1h')`
- 否则 → pass

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `maxPer10Min` | 3 | 10 分钟窗口上限 |
| `maxPerHour` | 8 | 1 小时窗口上限 |

# 验收标准

1. 近 10 分钟介入 3 次（达上限）→ halt('rate-limited-10min')；
2. 近 10 分钟 2 次、近 1 小时 8 次 → halt('rate-limited-1h')；
3. 近 10 分钟 2 次、近 1 小时 7 次 → pass；
4. 从未介入 → pass。

# 背景与调研来源

bl-chat-plugin 的 10 分钟硬限流；本仓库加上 1 小时窗防「每小时前 10 分钟
说完 3 次」的节奏漏洞（方案 §9.3）。
