---
doc: topic-session-requirement
kind: requirement
status: 已实施
supersedes: NEW-CONTENT-REQUIREMENT.md
scope: 用「话题 session + 发言预算」替代 topic-spent 的每话题一次，并作为主动介入的唯一放行闸门
params:
  - name: sessionBudget
    default: 2
    meaning: 一个 session 内允许的主动发言条数（硬上限 5）
  - name: sessionIdleMs
    default: 600000
    meaning: 静默多久自动关闭 session（毫秒；默认 10 分钟，与活动窗口同值）
  - name: sessionMinGapMs
    default: 45000
    meaning: 同一 session 内两次发言之间的最小间隔（毫秒）
amended:
  - 预算不驱动 session（耗尽只闭嘴、不关会话；new-topic 是唯一的预算重置正门）
  - 唯一的本地闸只装滚动收敛，问题探针免闸
stats:
  - proactiveSessionOpened
  - proactiveSessionClosed
  - proactiveSessionClosedBy
  - proactiveSpokeInSession
  - proactiveNoSession
  - proactiveBudgetExhausted
implemented:
  - src/pipeline/proactive/contract.ts（TopicSession 三字段 / SessionCloseCause / SessionDirective / 三个参数常量与硬上限裁剪）
  - src/pipeline/proactive/scene/state.ts（session 的开关与扣预算 / 会话级 lastEvaluationAt / 关闭通知 / dispose）
  - src/pipeline/proactive/veto/veto.ts（session 闸门接替旧分支：no-session / budget-exhausted / min-gap）
  - src/pipeline/proactive/scene/watcher.ts（开关与扣预算接线 / idle 定时器 / 唯一的本地闸 / 6 个计数）
  - src/pipeline/proactive/judge/judge.ts（判据新增「什么时候该关」+ 输出契约加 session 字段 + 结构化事实带 session）
  - src/config.ts / src/config-file.ts / qqbot.yml（三个 session* 参数）
  - src/pipeline/stats.ts / src/health.ts / src/main.ts（观测接线）
  - tests/proactive-session.test.ts（验收 1–14 的专项用例）、tests/scene-state.test.ts（状态机）
---

# 原始需求

（维护者原话，逐字保留）

> 我们这个设计复杂度过高了。因为话题明显是 llm 后才能明确的一个东西。所以核心是整个执行的结果。
> 我们无需追求对话题介入的高覆盖率，而需要专注做好话题介入的准确度即可。也就是
> 某次唤醒（主动/被动） -> llm 判断 -> 输出，这个流程中，额外产生一个话题session，
> 在这个session下，打开主动发言闸门 -> llm判断 -> 输出，直到消耗完发言预算，
> 或者这个session被闸门/llm关闭。

（参数决策，同样逐字保留）

> 目前先调整配置为两条发言预算吧；静默10分钟关闭session我觉得就可以了；不要做topicChange，
> 我们选择了这个技术方向，就意味着一定放弃了介入话题的覆盖率（不是所有话题我们都介入），
> 而追求介入话题的精度。

# 需求描述

## 被本需求取代的上一版设计

上一版（`NEW-CONTENT-REQUIREMENT.md`）试图用**本地信号集**（`newQuestion` /
`othersEngaged` / `correctionClaim` / `answerArrived` / `windowRolled`）+ **锚点**
来近似"有没有新内容"。它在代码对账中被证伪：

- **话题是 LLM 之后才明确的东西**，本地无法可靠划分——那套信号本质上是用启发式
  去猜只有语义判断才能知道的事（与架构文档 §3.1 拒绝"话题聚簇"的理由自相矛盾）；
- 信号集里至少三项不可判或会产生循环：`answerArrived` 的"被答"没有生产者
  （`markAnswered` 在 `src/` 里零调用），而"被静默"在每次探针否决时都会发生，
  于是"bot 拒答一次 → 本窗口该话题全面禁言（含新问题）"——**正是本需求要修的
  "长话题永久禁言"换了个马甲**；`othersEngaged` 的两个子条件（"在问题上发言"、
  "新发言人"）在本地都没有可判定义。

结论：**放弃本地信号集，改成"由 LLM 开一次会话、之后只数预算"。**

## 技术方向的前提（写在这里，避免以后反复）

> **选择 session 模型 = 放弃介入话题的覆盖率，换取精度。**

具体含义：

- 不是所有值得介入的话题都会介入——LLM 没判"值得"就永远不开 session；
- 话题切换时可能漏掉一轮机会（见「# 边界与反例」的 `topic-switch` 一行）；
- **因此不接受**"为了多覆盖一点"而加回本地启发式的改动。要提覆盖率，唯一被
  认可的方向是改判据 prompt 或调 session 参数，而不是加本地规则。

## 目标

1. **精度优先**：只在该开口时开口，宁可漏；
2. **复杂度塌缩**：状态从"5 个信号 + 锚点 + 台账交互"变成**三个字段**；
3. **复用既有的"话题属于 LLM 判断"的先例**：`pipeline/topic-judge.ts` 已经用
   小模型判定"新消息与既有话题是否相关"，本需求是同一思路在介入层的应用。

# 判定

## 一、状态：一个 session，三个字段

```ts
interface TopicSession {
  openedAt: number;      // LLM 判定"值得聊"的那一刻
  budgetLeft: number;    // 还能主动说几句（= sessionBudget）
  lastSpokeAt?: number;  // 最近一次在这个 session 里发言的时间
}
```

- 存在 `ConversationState` 上，**每会话最多一个**（与既有"一会话一状态"一致）；
- 不做 `topicChange` 字段、不做话题指纹、不做跨会话共享。

## 二、流程

```
① 唤醒（message / question-probe / topic-roll / wait-wakeup）
      │
      ├─ 本地闸：转录自上次评估以来无新增消息 → 直接返回，**不调 LLM**
      │           （唯一的本地闸，见「三」）
      ▼
② LLM 判断（判据与现状一致：五个场景的 satisfied）
      │
      ├─ 判"不值得" → 结束；**不开 session**（下次唤醒重新从 ① 开始）
      │
      └─ 判"值得"   → **开启 session**：budgetLeft = sessionBudget
                        │
                        ▼ 闸门打开
③ 后续每次唤醒 → 闸门检查（有 session 且 budgetLeft > 0 且距上次发言 ≥ sessionMinGapMs）
      │
      ├─ 闸门不过 → silent（原因见「四」）
      └─ 闸门过  → LLM 判断 → 输出
                        ├ 说了        → budgetLeft -= 1；lastSpokeAt = now
                        ├ 判"不用了"  → **关闭 session**（llm-closed）
                        └ 判"仍值得"  → 保持开启，等下次唤醒
```

**关键简化**：session 开启后，后续唤醒**不需要再证明"有新内容"**。闸门开着的期间，
判定权完全交给 LLM，本地不再插一脚。

## 三、唯一的本地闸：转录未增长则不评估

```
hasNewContentSince(lastEvaluationAt) === false  →  直接返回，不调 LLM
```

`lastEvaluationAt` = 该会话上次进入判定的时间（**新增的会话级字段**；注意与既有的
问题级 `PendingQuestion.lastEvaluatedAt` 不是同一个东西）。

**为什么必须保留**：若不检查就重问，wait 机制会退化成"群里完全安静时每 30 秒
问一次同样的问题"——这是上一轮花力气修掉的永动机。它成本只有一次
`buffer.some()`，且**不含任何语义判断**，与本需求否掉的"猜话题"不是一回事。

## 四、闸门的四种不过（穷举）

| 不过的原因 | 条件 | 计入 |
|---|---|---|
| `no-session` | 没有开启中的 session | `proactiveNoSession` |
| `budget-exhausted` | `budgetLeft <= 0` | `proactiveBudgetExhausted` |
| `min-gap` | `now - lastSpokeAt < sessionMinGapMs` | `proactiveMinGap` |
| `no-new-content` | 转录自上次评估无新增 | 不单独计数（属"未进入判定"） |

## 五、session 的关闭条件（四条，穷举）

> ⚠️ 本节已按维护者的口径修正重写（原始版本见文末「实施记录 §6」）：
> **预算不再关闭 session**。

| 关闭原因 | 触发者 | 机制 |
|---|---|---|
| `llm-closed` | LLM | 判定说这个话题**收口了**（`session: 'close'`） |
| `topic-changed` | LLM | 判定说**换话题了**（`session: 'new-topic'`）：旧会话为新话题让位 |
| `idle` | 代码 | 距 `lastSpokeAt`（无则 `openedAt`）超过 `sessionIdleMs` 自动关闭 |
| `conversation-gone` | 代码 | 无关本需求；会话状态被清理时连带关闭 |

**预算不在这个表里**：`budgetLeft` 减到 0 **不关闭** session，只让它在当前话题里
闭嘴（闸门报 `budget-exhausted`）。理由是维护者的口径——
**session 的驱动动机只能是话题，不能是预算**。

**关闭后**：下次唤醒回到流程 ① —— 需要 LLM 重新判"值得"才会再开。

## 六、判定层的输出契约（只加一个字段）

```ts
verdict = { scene, satisfied, confidence, reason, evidence, directive,
            session: 'keep-open' | 'close' | 'new-topic' }
```

- `session` 字段只在**本次判定有场景成立（要发言）**时才有意义；
- 判据正文（prompt）必须新增一段说清三态怎么选：

| 值 | 模型想说的 | 代码做什么 |
|---|---|---|
| `keep-open` | 还是刚才那个话题，会话该继续 | 没有会话就开一个；已有就继续用（**已耗尽时仍然闭嘴**） |
| `close` | 刚才那个话题收口了 | 关掉（`llm-closed`）；本次该说的这句照样说 |
| `new-topic` | 已经换到另一个话题了 | 关旧（`topic-changed`）+ 为新话题开一个（**预算重置**） |

- **冲突时的聚合**：`new-topic` > `close` > `keep-open`（任一判定说了就算），
  唯一实现在 `contract.ts` 的 `aggregateSessionDirective()`，否决层与调度层共用它；
- **`new-topic` 只重置预算，不重置节奏**：最小间隔（`sessionMinGapMs`）照样要过。
  否则模型只要一直说"换话题了"就能连着刷，上限又回到模型手里。
- 为什么必须是三态：`close` 只能说"旧的结束"，说不出"新的开始"；两态时预算重启
  只能靠"关掉旧的 → 下一次唤醒再开"，于是**预算一重置就能接着说**（实测：51 秒内
  说了 3 句，`sessionBudget=2`）。

## 七、与既有闸门的关系

| 闸门 | 现状 | 本需求 |
|---|---|---|
| `rate-limit`（10 分钟 ≤3 / 1 小时 ≤8） | 保留 | **不变**（它是频率约束，与"重不重复"正交） |
| `topic-spent`（每话题 ≤ `maxPerTopic`） | 每话题一次 | **删除**；`maxPerTopic` 参数一并删除，职责由 session 预算 + LLM 关闭接管 |
| `sessionMinGapMs` | 不存在 | **新增**：session 内两次发言的最小间隔（换话题也不例外） |
| `budget-exhausted` | 不存在 | **新增**：本话题预算用尽 → 闭嘴但**不关会话**（`proactiveBudgetExhausted`） |
| 顺序预算（`quantileBudget`） | 默认关 | 不变 |
| 判定顺序 | rate-limit → topic-spent | rate-limit → **session 闸门**（`topic-spent` 位置由它接替） |

# 参数

| 名字 | 默认值 | 范围 | 含义 |
|---|---|---|---|
| `sessionBudget` | `2` | `1`–`5`（硬上限 5） | 一个 session 内允许的主动发言条数 |
| `sessionIdleMs` | `600000` | `60000`–`3600000` | 静默多久自动关闭 session（默认 10 分钟，与活动窗口同值） |
| `sessionMinGapMs` | `45000` | `10000`–`300000` | 同一 session 内两次发言的最小间隔 |

**`sessionBudget` 的语义（口径修正后）**：它是"**一个话题**里还能说几句"的账，
不是会话的寿命。说满之后该话题闭嘴，直到模型说换话题（`new-topic`）或会话结束
（`close` / `idle`）——两条路都由话题驱动，代码里没有"因为预算所以重开"的路径。

**要删掉的参数**：`maxPerTopic`——已核对其真实引用点（实现时逐个清掉）：

| 文件 | 位置 | 处理 |
|---|---|---|
| `pipeline/proactive/contract.ts` | `VetoPolicy.maxPerTopic` 字段 + 默认值 `1` | 删字段与默认值 |
| `pipeline/proactive/veto/veto.ts` | `topic-spent` 分支（`context.topicBotSpeaks >= policy.maxPerTopic`） | 换成 session 闸门 |
| `pipeline/proactive/scene/state.ts` | 文件头注释引用它 | 改注释 |
| `pipeline/proactive/interests/pool.ts` | 文件头注释「预算不在这里」 | 改注释（指向 session 预算） |
| `pipeline/proactive/interests/SCENES.md` / `interests.yml.example` | 维护者文档提到它 | 改文档 |
| `tests/proactive-watcher.test.ts` | 两处 `vetoPolicy: { maxPerTopic: … }` | 改成 session 参数 |

`newContentMinSignals` / `newContentMinMessages` / `semanticNoveltyMin`
**从未实现**（上一版文档只写在纸面），因此无需删除——这也是"配置里不放空转键"
纪律生效的一个例子。

# 验收标准

1. 无 session 时 LLM 判成立 → **开启 session**（`budgetLeft = sessionBudget`），
   计 `proactiveSessionOpened`；该次发言消耗 1 点预算；
2. 无 session 时 LLM 判不成立 → **不开 session**，计 `proactiveNoSession`，
   下次唤醒仍从"需要 LLM 重新判值得"开始；
3. session 开启后再次唤醒 → **不再要求"有新内容"**，直接过闸门进入判定
   （这是本需求的核心行为变化，必须有专门用例）；
4. 预算减到 0 → **不关闭 session**（`sessions.spent` +1），此后同一话题的唤醒
   一律 `silent('budget-exhausted')`，计 `proactiveBudgetExhausted`，
   **不新开 session**、也不消耗预算；要重新开口只能由话题驱动：
   模型说 `new-topic`（关旧开新、预算重置），或会话 `close` / `idle` 结束；
5. LLM 输出 `session: 'close'` → 关闭 session（`llm-closed`），
   且**本次发言照常发出**（关闭不影响这一条）；
6. 距上次发言（无发言则 `openedAt`）超过 `sessionIdleMs` → 自动关闭（`idle`），
   **不调 LLM**；
7. 同一 session 内两次发言间隔 < `sessionMinGapMs` → 闸门不过，计 `proactiveMinGap`，
   **不消耗预算**；
8. 转录自上次评估以来无新增 → **不调 LLM**（与 wait 的闸 4 同一实现）；
9. `sessionBudget` 配成 `9` → 按硬上限 `5` 处理并 warn；
10. 判定顺序不变：`rate-limit` 仍**先于** session 闸门（10 分钟 3 次的上限不受
    session 预算放宽）；
11. `proactiveSessionClosed === Σ proactiveSessionClosedBy{reason}`（账目闭合）；
12. `topic-spent` / `maxPerTopic` 在代码中**不再存在**（用 grep 断言，防止残留）；
13. 因 **`close` / `idle` / `topic-changed`** 而结束的会话，之后唤醒若 LLM 又判成立
    → **重新开启新 session**（`openedAt` 更新，预算重置）；
    但"**因预算耗尽而闭嘴**"的那种状态不算结束——它只有在模型说换话题、
    说收口或静默超时之后才会回到可开启状态；
14. session 期间**话题换了**（LLM 未输出 `close` / `new-topic`）→ 本次仍按旧 session 走
    （覆盖率损失，**已知并接受**；用例只断言"不崩溃、行为与旧 session 一致"，
    不要求它识别话题切换）；
15. 模型输出 `session: 'new-topic'` → 关旧会话（`topic-changed`）+ 为新话题开一个
    （预算重置），且**本次发言照常发出**；但**最小间隔仍然生效**——
    间隔没到时按 `min-gap` 挡下，不关旧也不开新。

# 边界与反例

| 情形 | 处理 | 理由 |
|---|---|---|
| 话题换了但 LLM 没输出 `close` | 继续用旧 session，直到预算耗尽或 idle 关闭 | **这是明确接受的覆盖率损失**（维护者决策：不做 topicChange） |
| session 开着，但群里一直没人说话 | `idle` 到点关闭；期间每次唤醒被"转录未增长"挡住，不调 LLM | 零成本兜底，不产生空转调用 |
| bot 说完一句后收到反驳 | 仍在新唤醒里判定（有新消息 → 过本地闸；有 session → 过闸门） | 这正是"闸门开着"的价值 |
| 预算用完，但话题明明显得还该聊 | **不再开口**（会话仍开着），直到模型说换话题 / 说收口 / 静默超时 | 预算是防刷屏的主闸；宁可少说 |
| 预算用完，同一话题又来一条消息 | 闸门报 `budget-exhausted`，**不新开 session** | 预算不能被"再问一次"重置——那是预算驱动，不是话题驱动 |
| LLM 连续两次判"成立"但 `sessionMinGapMs` 未到 | 第二次被闸门挡下，**不消耗预算** | 预算是"说了几句"的账，不是"想过几次"的账 |
| LLM 输出 `close` 且本次不发言（`satisfied: false`） | 关闭 session，不发言 | `close` 与"要不要说"是两个维度 |
| 判定失败（超时/解析） | 不开、不关 session；计 `proactiveJudgeFailures` | 判定失败不改变 session 状态——它没有表达过任何意见 |
| 被 @ 的被动回复路径 | **不进入本机制**（它走 Ingress 管线，本来就该回） | 本机制只约束"主动开口" |
| 群白名单之外的会话 | 连状态都不入 | 与现状一致 |
| 冷启动/进程重启 | session 不持久化（进程内状态） | 与旁听内容"不落盘"的隐私口径一致 |

# 可观测性

| 计数（代码侧字段名） | 回答什么 | 期望形态 |
|---|---|---|
| `proactiveSessionOpened` | 一天开了几个 session | 与 `proactiveSpoke` 一起看：开得多说得少 = 判据松 |
| `proactiveSessionClosedBy{reason}` | 怎么关的 | `llm-closed` 高 = 判据的关闭指引有效；`topic-changed` 高 = 模型在主动切话题（预算靠它重置）；`idle` 高 = 都是没人接话自然结束的 |
| `proactiveSpokeInSession` | 每个 session 里说了几句（分布） | 分布集中在 1 = 预算 2 用不满，可考虑降为 1；集中在 2 = 预算卡着 |
| `proactiveNoSession` | 有多少次唤醒因为"没有 session"被挡 | 高 = session 开得太少（覆盖率低，符合预期但要看得见） |
| `proactiveBudgetExhausted` | 有多少次唤醒因为**本话题额度用尽**被挡（会话还开着） | 高 = 预算该加；低 = 2 条足够。**注意它不等于"它不说话了"**：会话没关，只是没额度 |
| `proactiveMinGap` | 最小间隔挡了多少次 | 异常高说明 LLM 想说的话被间隔压住了 |

**面板建议**：`sessionOpened × spokeInSession` 的联合分布是本需求的核心指标——
它能一眼回答"预算 2 到底对不对"。

# 与既有需求/机制的关系

| 对象 | 关系 |
|---|---|
| `WAIT-CONVERGENCE-REQUIREMENT.md`（已实现，未提交） | **不冲突**：wait 是"延迟一次再判"，session 是"开了就持续可判"。两者都受"转录未增长不评估"的约束，该检查应共用同一实现（同一次 `hasNewContentSince`） |
| `NEW-CONTENT-REQUIREMENT.md` | **被本需求取代**（`supersedes`）。本地信号集方案作废；该文件保留为"被否掉的方案"记录，状态标为作废 |
| `pipeline/topic-judge.ts` | **不纳入**：它只在被 @ 的轮次里跑（判定"是否延续话题"以决定 DSH 上下文是否重置），纯旁听的群不触发；本需求明确不做 topicChange |
| 问题台账（`pendingQuestions` / `markSilenced`） | 本需求**不依赖**它做放行判断（只作为渲染进 prompt 的【结构化事实】）。它的既有缺陷（`markAnswered` 无生产者、"被静默"过于频繁）**单独立项**，不再是本需求的前提 |
| 架构文档 §3.0（状态不按场景分账） | 遵守：session 挂在会话状态上，与场景无关 |

# 背景与调研来源

- **触发数据**：一周灰度——`satisfiedByScene` 550 次、`topic-spent` 494 次、
  `wouldSend` 56 次（模型意图的 90% 被"每话题一次"拦掉）；
- **上一版方案被否的依据**：代码对账（`markAnswered` 在 `src/` 零调用、
  `markSilenced` 在每次探针否决时触发、`vetoContext` 使 `windowRolled`/无锚点
  恒为假），以及维护者"话题是 LLM 之后才明确的东西"的判断；
- **"话题属于语义判断"的先例**：`pipeline/topic-judge.ts` 的既有注释
  「不是硬时间间隔——话题是否结束是语义判断」，本需求是同一思路；
- **精度优先的取舍**：与生态调研的结论一致（Koala IUI'25：主动版被 72% 用户
  嫌弃"像不肯给别人留空间的说教学生"；本项目的定位是"提供有价值的补充"，
  不是"每条话题都插一句"）。

# 实施顺序建议

1. **状态与参数**：`ConversationState` 加 session 三字段 + `lastEvaluationAt`；
   `config.ts` / `config-file.ts` 加三个 `session*` 参数，**删掉 `maxPerTopic`**
   （`qqbot.yml` 的示例同步，否则未知键会在启动期报错）；
2. **闸门替换**：`veto.ts` 的 `topic-spent` 分支换成 session 闸门（四种不过），
   `VetoContext` 去掉 `topicBotSpeaks`、加 session 状态；
3. **runner 接线**：`watcher.ts` 负责开/关 session、扣预算、idle 定时器，
   并实现"转录未增长不评估"（与 wait 共用）；
4. **判定层**：判据文案加"什么时候该关 session"一段，输出契约加 `session` 字段；
5. **观测**：6 个计数 + `closedBy` 拆分，接进 health 快照；
6. 灰度一周后**只看两个数**：`spokeInSession` 分布（预算 2 对不对）、
   `closedBy` 分布（LLM 会不会关）。

# 实施记录（落地时判定的五处口径）

需求与代码对账后有五处需要**当场定口径**的地方，都记在这里，免得下一轮重开讨论。

### 1. 唯一的本地闸只装在**定时唤醒**上，不装在 `message` 上

需求 §三给了闸门本体（`hasNewContentSince(lastEvaluationAt)`），§二的流程图把
`message` 也列在唤醒源里。实现时**没有**把它装在 `message` 那条路上，理由是可判的：

- 一条旁听消息**到达本身**就是"转录有新增"的证据，再比一次时间戳不增加信息；
- 而它会**引入假阴性**：OneBot 的事件时间是**秒**（`time * 1000`，
  见 `adapters/onebot/normalize.ts`），而 `lastEvaluationAt` 是本机毫秒时钟
  ——同一秒内到达的后续消息其 `ts` 并不更大，于是**最高频的那条触发面会被整体吞掉**
  （表现就是"它从不主动说话"）；
- 需求给的理由也只针对定时唤醒："若不检查就重问，wait 机制会退化成群里完全安静时
  每 30 秒问一次同样的问题"。

另外，为了让"同一秒内的新消息"在**定时唤醒**上也能被认出来，
`ConversationState.hasNewContentSinceLastEvaluation()` 是两条判据取或：
时间戳（与 wait 票据共用 `hasNewContentSince`）+ **转录末尾是否换人**
（判定那一刻的末尾 eventId 变了就说明有新增）。时间戳那条的严格大于边界不变。

**已修正（见 §6）**：初版把探针也闸掉了，实测后果是——只要 bot 刚主动开过口
（活动窗口打开，于是每条消息都触发一次消息面判定，把"上次评估"推到最新），
"有人提问 → 90 秒后把问题接过来"这条链在**整个话题窗口内完全不会发生**；
连"再有人顶一句"都救不了（那句顶话自己就会触发一次判定）。
维护者口径：**探针免闸**，本地闸只装滚动收敛。

### 2. 预算与 session 的关系（**已被维护者修正，见 §6**）

初版按验收 4 实现成"预算减到 0 → 立即关闭"，于是 §四的闸门表与验收 4 互斥：
session 已经没了，后续唤醒只能记 `no-session`，`proactiveBudgetExhausted` 恒为 0。

更要紧的是实测发现：**那样实现的预算根本不是刹车**。会话关掉之后，下一次唤醒
只要模型再判一次"值得"就能开一个新的，而新会话的第一句不受最小间隔约束
（口径是"同一 session 内"）——实测 `sessionBudget=2`、`sessionMinGapMs=45s` 时
**51 秒内说了 3 句**，"预算耗尽"只是换了一本账。

维护者据此定了新口径（§6），本文件已按新口径改写。

### 3. `session` 字段的聚合口径：任一判定说 `close` 就关

`session` 是**会话级**字段，但按 §六的输出契约它挂在每条逐场景判定上，模型重复
五次难免不一致。聚合取**更保守的一侧**（`some(close)`）：误关的代价是"少说一句"，
误留的代价是"接着说"。`close` 与 `satisfied` 无关地生效（边界表：
"`close` 与'要不要说'是两个维度"），但 `wait` 那一支不动 session——模型此刻说的是
"有人在答、过几十秒再看"，真要收口，重判那次会给 `close`。

### 4. `conversation-gone` 有落点，但当前运行期没有生产者

需求 §五把四条关闭原因写成穷举，因此 `ConversationStateStore.dispose(convKey)` 是
第四条原因的唯一落点（关闭 session + 摘监听器 + 移出注册表），并有单测。
但**当前没有任何调用方**：会话状态一旦创建就常驻到进程结束（旁听状态本来就不落盘）。
留着它是为了将来加状态淘汰时不必再想一遍 session 怎么收口——不是为了凑满四条。

### 5. 判定层新增的那段正文放在 system 段，不重复进五个场景

`session` 与会话有关、与"哪个场景成立"无关，所以"什么时候该关"写成
`judge.ts` 的 `SESSION_CRITERIA` 一段（随 `renderJudgeCriteria()` 进 system 段），
而不是抄进五份判据正文——抄五遍只会让口径漂移。结构化事实块里同时给出
"本话题会话已开启 N 秒 / 上次发言 N 秒前 / 预算还剩几句"，模型才有依据回答它。

### 6. 维护者的口径修正（实施后拍板，已回写全文）

原话：

> 口径2我觉得需要禁止耗尽后纯为了预算新开session，session不应该被预算驱动，
> 它的驱动动机应该只是话题。

落地方式（与需求初版的差异，逐条）：

| 项 | 初版 | 修正后 |
|---|---|---|
| 预算减到 0 | 立即关闭 session（`budget-exhausted`） | **不关闭**：会话留着、闸门报 `budget-exhausted`（验收 4 已改写） |
| 重新开口 | 下次唤醒 LLM 再判"值得"就能开新 session | 必须**话题驱动**：模型说 `new-topic`（预算重置），或会话 `close` / `idle` 结束后重开（验收 13 已改写） |
| `session` 字段 | 两态 `keep-open` / `close` | **三态**，加 `new-topic`（"已经换到另一个话题了"）——它是预算重启的唯一正门 |
| 关闭原因 | 四条（含 `budget-exhausted`） | 四条，但预算**不在其中**：`llm-closed` / `topic-changed` / `idle` / `conversation-gone` |
| `new-topic` 的边界 | —— | 只重置**预算**，不重置**节奏**：`min-gap` 照样要过（否则"一直说换话题"就能连刷） |
| 本地闸 | 所有定时唤醒 | 只装滚动收敛（`topic-roll`）；**问题探针免闸**（口径 1，见 §1 的实测） |

两条实测依据（都写进了用例，防回归）：

1. `tests/proactive-session.test.ts` 验收 4：同一话题连发 4 条消息、模型每次都判成立，
   发言数恒为 1（旧口径下每次都能靠"关掉旧的 → 再开一个"绕过去）；
2. 同文件验收 4b：`new-topic` 在间隔没到时照样被 `min-gap` 挡住，
   间隔到了才关旧开新、预算重置。

另外，口径修正顺带解决了 §2 记的那个矛盾：`proactiveBudgetExhausted` 现在是
**活的主路径计数**（预算耗尽不关会话，所以每次被额度挡下都会记一次），
它才真正回答"预算该不该加"；`closedBy` 里不再有预算这一项。
