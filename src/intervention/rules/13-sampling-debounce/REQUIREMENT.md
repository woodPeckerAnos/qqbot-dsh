---
rule: sampling-debounce
stage: intake
order: 13
params:
  - name: evaluateEvery
    default: 6
    meaning: 距上次评估累计多少条缓冲消息即触发采样评估
  - name: silenceDebounceMs
    default: 20000
    meaning: 静默去抖时长（毫秒；runner 用——无新消息达此时长即评估存量）
stats: mark_sampling_hit
---

# 原始需求

（手写规则，模板定稿传统；对应方案 §5.2 清单与 §5.4 ② 的终局语义。）

# 需求描述

intake 链的终局：决定这条消息之后**要不要立刻进评估**。

- 上游已标强信号 → 立刻评估（pass，marks 里已有 strongSignal）；
- 距上次评估累计的缓冲条数达标（默认 ≥6 条）→ 标 `samplingHit`，
  立刻评估；FADING 相位内阈值减半（降级期少评估，方案 §9.3）；
- 否则只入缓冲——静默去抖由 runner 执行：无新消息达 silenceDebounceMs
  后以 trigger='debounce' 直接进 evaluate 链（不经本规则）。

本规则只标注、不拦截（它是链尾，pass 后的动作由 runner 按 marks 决定）。

# 判定

- 条件 A：`marks.strongSignal` 已存在 → pass（立即评估）
- 条件 B：`state.unevaluatedCount >= 阈值`（阈值 = params.evaluateEvery，
  FADING 相位减半取整，最小 1）→ `mark({ samplingHit: true })`（立即评估）
- 否则 → pass（只入缓冲 + runner 挂去抖）

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `evaluateEvery` | 6 | 采样计数阈值 |
| `silenceDebounceMs` | 20000 | 静默去抖时长（runner 消费） |

# 验收标准

1. 已有强信号标注 → pass（不覆盖 marks）；
2. unevaluatedCount=6（达阈值）→ mark(samplingHit)；
3. unevaluatedCount=3（未达阈值）→ pass 且无 samplingHit；
4. FADING 相位内阈值减半：unevaluatedCount=3、阈值 6→3 → mark(samplingHit)；
5. 非消息触发（debounce 直接进 evaluate，不经本规则；防御路径）→
   按同样计数逻辑判定。

# 背景与调研来源

koishi-plugin-dialogue 的概率采样与 bl-chat-plugin 的频率采样；静默去抖
对齐「回复去抖」共识（方案 §5.4）。
