---
rule: offpeak-window
stage: intake
order: 3
params:
  - name: respectOffpeak
    default: true
    meaning: 是否让介入判定尊重谷时段（true = 正价时段不评估，省 API 钱）
stats: halt_peak_hours
---

# 原始需求

（手写规则，模板定稿传统；对应方案 docs/TOPIC-INTERVENTION-PLAN.md §9.5：
谷时段闸由本规则在 intake 层执行。）

# 需求描述

介入评估要花 LLM API 的钱（20 号规则的 Gate 判定）。当谷时段闸启用且当前
处于正价时段时，旁听消息不参与介入评估，只入缓冲攒上下文；谷时段恢复后
照常评估。@ 提问路径不受影响（它由既有的 offpeak-gate stage 拦截提示）。

「当前是否谷时段」由 runner 经注入探针计算（`ctx.offpeakNow`），规则本身
不读时钟、不碰配置；探针缺位（undefined）时按不拦处理——关掉介入只是
少说话，@ 路径的成本闸还在。

# 判定

- 输入：一条 observed 消息
- 条件 A：`params.respectOffpeak === false` → pass（管理员显式放行正价评估）
- 条件 B：`ctx.offpeakNow === false`（探针确认当前正价）→ `halt('peak-hours')`
- 否则（谷时段，或探针缺位 undefined）→ pass

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `respectOffpeak` | true | 是否尊重谷时段；false = 正价时段也评估介入 |

# 验收标准

1. respectOffpeak=true 且 offpeakNow=false（正价）→ halt('peak-hours')；
2. respectOffpeak=true 且 offpeakNow=true（谷时段）→ pass；
3. respectOffpeak=false 时无论正价谷价 → pass；
4. offpeakNow=undefined（无探针）→ pass。

# 背景与调研来源

本仓库既有 offpeak 闸（src/offpeak/）只覆盖 @ 提问；介入是增量成本，
正价时段不花闲钱（方案 §9.5）。
