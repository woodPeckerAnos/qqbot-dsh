---
rule: focus-budget
stage: speak
order: 31
params:
  - name: focusMs
    default: 120000
    meaning: FOCUS 相位窗口（毫秒；相位迁移由 runner 按此时长执行）
  - name: fadingMs
    default: 120000
    meaning: FADING 相位窗口（毫秒）
  - name: focusMaxReplies
    default: 2
    meaning: FOCUS 相位内允许的主动发言次数（满额自动降级 FADING）
stats: halt_focus_exhausted
---

# 原始需求

（手写规则，模板定稿传统；对应方案 §5.2 清单与 §9.3 相位状态机。）

# 需求描述

主动插话要有「焦点预算」：FOCUS 相位（插话后的关注窗口）内最多主动发言
2 次，满额自动降级 FADING；FADING 相位内**不再主动插话**（只保留减半的
采样评估，等相位期满回 COLD）。插话连发是对群氛围最大的伤害，这一层
是「宁缺勿滥」的兜底。相位迁移本身由 runner 按迁移表执行（state.ts），
本规则只读取当前相位做否决判定。

# 判定

- 输入：共享状态的当前相位（`state.phaseAt(now)`）与 FOCUS 内已发言计数
- 条件 A：相位为 fading → `halt('fading-no-speak')`
- 条件 B：相位为 focus 且 `focusSpokeCountAt(now) >= params.focusMaxReplies`
  → `halt('focus-exhausted')`（防御路径：迁移表在满额时已自动降 fading，
  正常流程不可达；保留以防迁移参数漂移造成的非法状态被放行）
- 否则（cold，或 focus 预算未用完）→ pass

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `focusMs` | 120000 | FOCUS 相位窗口 |
| `fadingMs` | 120000 | FADING 相位窗口 |
| `focusMaxReplies` | 2 | FOCUS 内主动发言上限 |

# 验收标准

1. 相位 fading（含「满 2 次发言自动降级」的联动）→ halt('fading-no-speak')；
2. 相位 focus 且已发言 1 次（预算未满）→ pass；
3. 相位 cold → pass；
4. focus 相位期满（超 focusMs）自动回 cold → pass。

# 背景与调研来源

bl-chat-plugin 的 FOCUS/FADING/COLD 状态机（方案 §9.3）；迁移表集中在
state.ts，本规则是其在 speak 链上的读取点。
