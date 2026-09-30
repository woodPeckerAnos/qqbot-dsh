---
rule: eval-cooldown
stage: intake
order: 12
params:
  - name: cooldownMs
    default: 60000
    meaning: 常规冷却期（毫秒）：距上次评估不足此时长不再评估
  - name: strongSignalCooldownMs
    default: 15000
    meaning: 强信号冷却期（毫秒）：带强信号的消息用更短的冷却
stats: halt_cooldown
---

# 原始需求

（手写规则，模板定稿传统；对应方案 §5.2 清单。）

# 需求描述

Gate 评估是花钱的，不能每条消息都评。距上次评估不足冷却期（常规 60s）
的消息不再评估；但带强信号（08–11 号规则标注）的消息时效性高，用更短的
冷却（15s）。冷却期的原点 = 上次**进入评估**的时刻（不管判定结果如何），
由 runner 在进 evaluate 链时记账。

链位说明：本规则排在强信号标注（08–11）**之后**——「强信号用短冷却」
要求先标注后冷却，这是编排序的硬约束（v2 实施时发现 08 在 09–12 之前
读不到 marks，故将本规则从 08 移到 12）。冷却拦截的消息仍是上下文，
**拦截但入缓冲**（halt + buffer）。

# 判定

- 输入：一条 observed 消息；marks 里可能已有上游强信号标注
- 条件 A：`state.lastEvaluateAt` 为空（从未评估）→ pass
- 条件 B：`now - lastEvaluateAt < cooldown`（冷却取强信号版或常规版，
  取决于 marks.strongSignal 是否存在）→ `halt('cooldown', buffer: true)`
- 否则 → pass

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `cooldownMs` | 60000 | 常规冷却期 |
| `strongSignalCooldownMs` | 15000 | 强信号冷却期 |

# 验收标准

1. 从未评估 → pass；
2. 无强信号且距上次评估 30s（< 60s）→ halt('cooldown')；
3. 无强信号且距上次评估 70s → pass；
4. 有强信号且距上次评估 20s（> 15s）→ pass；
5. 有强信号且距上次评估 10s（< 15s）→ halt('cooldown')。

# 背景与调研来源

bl-chat-plugin 的 Gate 频率控制；强信号降冷却是 R1–R4 的时效性兑现
（方案 §9.1）。
