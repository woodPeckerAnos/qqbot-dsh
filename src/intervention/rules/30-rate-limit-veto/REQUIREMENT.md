---
rule: rate-limit-veto
stage: speak
order: 30
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

发言前的**硬限流终检**：每群 10 分钟最多 3 次、1 小时最多 8 次主动介入。
07 号规则在 intake 层做过同样的检查（省评估成本），但从评估到发言之间
窗口可能变化（其他群消息触发的介入先发了），所以 speak 链必须复核——
双闸。命中时 runner 会把相位强制降为 fading 进入冷却；本规则只管判定。

# 判定

- 输入：共享状态的介入发言滑动窗口
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

1. 近 10 分钟已介入 3 次 → halt('rate-limited-10min')；
2. 近 1 小时已介入 8 次（10 分钟未满）→ halt('rate-limited-1h')；
3. 两窗口都未满 → pass；
4. 从未介入 → pass。

# 背景与调研来源

方案 §9.3 硬限流与 §9.5「@ 提问与续聊晋升完全不受本节限制」——
本窗口只记主动介入（runner 记账时区分）。
