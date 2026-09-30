---
rule: semantic-gate
stage: evaluate
order: 20
params:
  - name: contextMessages
    default: 30
    meaning: 送给 Gate 的转录条数上限（runner 渲染 transcript 时取最近 N 条）
  - name: waitRetryMs
    default: 30000
    meaning: Gate 判 wait 后的重查延迟（毫秒；最多重查一次）
  - name: criteria
    default: "speak 的必要条件（宁缺勿滥）：存在无人回答且 bot 能答的问题；需要事实性纠错；与 bot 近期任务或明确专长直接相关且有信息增量。silent：闲聊、情绪话题、已被群友充分回答、bot 无信息增量、信息不足。wait：话题正在展开、再等一会更合适（仅此一种情形给 wait）。"
    meaning: Gate 判定标准正文（需求即 prompt 的投影；可在 qqbot.yml 覆盖调优）
stats: halt_gate_silent
---

# 原始需求

（手写规则，模板定稿传统；对应方案 §5.6——本规则是「规则首先是自然语言」
最彻底的体现：本文件的「需求描述」正文就是 Gate 判定标准的来源，
params.criteria 是它的逐字投影。）

# 需求描述

这个话题值不值得 bot 主动插话？你是 QQ 群里一个**任务型助手**（能查资料、
跑代码、执行多步任务）的发言守门人：

- **speak 的必要条件**（宁缺勿滥）：存在无人回答且 bot 能答的问题 /
  需要事实性纠错 / 与 bot 近期任务或明确专长直接相关且有信息增量；
- **silent**：闲聊、情绪话题、已被群友充分回答、bot 无信息增量、信息不足；
- **wait**：话题正在展开、再等一会更合适（仅此一种情形给 wait）。

输入是边界标记包裹的近期群聊转录（默认 30 条）+ bot 状态块（距上次发言、
近 10 分钟介入次数、相位、群活跃度），由 runner 渲染后经 ctx.gate 注入。
输出契约为严格 JSON（由 gate-client 固定拼接，不在本文件）；解析失败/
超时/HTTP 错误一律按 silent（fail-closed，gate-client 实现）。

wait 最多重查一次：重查（trigger='gate-wait-recheck'）时再判 wait 直接
按 silent 拦掉，不无限推迟。

# 判定

- 条件 A：`ctx.gate` 未注入（未配置 LLM 密钥）→ `halt('gate-unavailable')`
- 调用 `ctx.gate.judge({ transcript, stateSummary, criteria })`：
  - silent → `halt('gate-silent')`
  - speak → `mark({ gateDecision: 'speak' })`
  - wait 且 trigger ≠ 'gate-wait-recheck' → `defer(waitRetryMs, 'gate-wait')`
  - wait 且 trigger = 'gate-wait-recheck' → `halt('gate-wait-twice')`

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `contextMessages` | 30 | 转录条数上限（runner 消费） |
| `waitRetryMs` | 30000 | wait 重查延迟（最多重查一次） |
| `criteria` | （见 frontmatter 默认值） | Gate 判定标准正文 |

# 验收标准

1. Gate 判 silent → halt('gate-silent')；
2. Gate 判 speak → mark({ gateDecision: 'speak' })；
3. Gate 判 wait（首查）→ defer(waitRetryMs, 'gate-wait')；
4. Gate 判 wait（重查，trigger='gate-wait-recheck'）→ halt('gate-wait-twice')；
5. ctx.gate 未注入 → halt('gate-unavailable')。

# 背景与调研来源

混合守门的语义层（方案 §6.2）：本地规则预筛 + 小模型三选一。LLM 永不握
最终决定权——speak 之后还有 speak 链三道否决（§5.4 ④）。
