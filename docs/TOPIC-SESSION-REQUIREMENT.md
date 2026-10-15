---
doc: topic-session-requirement
kind: requirement
status: 待实施
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
stats:
  - proactiveSessionOpened
  - proactiveSessionClosed
  - proactiveSessionClosedBy
  - proactiveSpokeInSession
  - proactiveNoSession
  - proactiveBudgetExhausted
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

| 关闭原因 | 触发者 | 机制 |
|---|---|---|
| `budget-exhausted` | 代码 | `budgetLeft` 减到 0 时立即关闭 |
| `llm-closed` | LLM | 每次判定问一句"这个 session 还该继续吗"，答 `session: 'close'` 即关 |
| `idle` | 代码 | 距 `lastSpokeAt`（无则 `openedAt`）超过 `sessionIdleMs` 自动关闭 |
| `conversation-gone` | 代码 | 无关本需求；会话状态被清理时连带关闭 |

**关闭后**：下次唤醒回到流程 ① —— 需要 LLM 重新判"值得"才会再开。
**不做** `topicChange`：话题换了由 LLM 在判定时输出 `session: 'close'` 关闭旧 session，
下一次唤醒再重开。中间的覆盖率损失是**已知且接受的**。

## 六、判定层的输出契约（只加一个字段）

```ts
verdict = { scene, satisfied, confidence, reason, evidence, directive,
            session: 'keep-open' | 'close' }   // 说完了要不要继续跟着这个话题
```

- `session` 字段只在**本次判定有场景成立（要发言）**时才有意义；
- 判据正文（prompt）必须新增一段说清"什么时候该关"：
  - 话题已经收口（问题被答、讨论有结论）→ `close`
  - 话题转向了别的主题、当前内容已无增量 → `close`
  - 话题仍在延续、但这次没什么可补 → `satisfied: false`（不开/不续 session 由
    闸门决定，不需要额外表达）

## 七、与既有闸门的关系

| 闸门 | 现状 | 本需求 |
|---|---|---|
| `rate-limit`（10 分钟 ≤3 / 1 小时 ≤8） | 保留 | **不变**（它是频率约束，与"重不重复"正交） |
| `topic-spent`（每话题 ≤ `maxPerTopic`） | 每话题一次 | **删除**；`maxPerTopic` 参数一并删除，职责由 session 预算 + LLM 关闭接管 |
| `sessionMinGapMs` | 不存在 | **新增**：session 内两次发言的最小间隔 |
| 顺序预算（`quantileBudget`） | 默认关 | 不变 |
| 判定顺序 | rate-limit → topic-spent | rate-limit → **session 闸门**（`topic-spent` 位置由它接替） |

# 参数

| 名字 | 默认值 | 范围 | 含义 |
|---|---|---|---|
| `sessionBudget` | `2` | `1`–`5`（硬上限 5） | 一个 session 内允许的主动发言条数 |
| `sessionIdleMs` | `600000` | `60000`–`3600000` | 静默多久自动关闭 session（默认 10 分钟，与活动窗口同值） |
| `sessionMinGapMs` | `45000` | `10000`–`300000` | 同一 session 内两次发言的最小间隔 |

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
4. 预算减到 0 → **立即关闭 session**（`budget-exhausted`），此后唤醒一律
   `silent('no-session')`，直到 LLM 重新开一个；
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
13. session 关闭后再次唤醒，若 LLM 又判成立 → **重新开启新 session**
    （`openedAt` 更新，预算重置）；
14. session 期间**话题换了**（LLM 未输出 `close`）→ 本次仍按旧 session 走
    （覆盖率损失，**已知并接受**；用例只断言"不崩溃、行为与旧 session 一致"，
    不要求它识别话题切换）。

# 边界与反例

| 情形 | 处理 | 理由 |
|---|---|---|
| 话题换了但 LLM 没输出 `close` | 继续用旧 session，直到预算耗尽或 idle 关闭 | **这是明确接受的覆盖率损失**（维护者决策：不做 topicChange） |
| session 开着，但群里一直没人说话 | `idle` 到点关闭；期间每次唤醒被"转录未增长"挡住，不调 LLM | 零成本兜底，不产生空转调用 |
| bot 说完一句后收到反驳 | 仍在新唤醒里判定（有新消息 → 过本地闸；有 session → 过闸门） | 这正是"闸门开着"的价值 |
| 预算用完，但话题明明显得还该聊 | **不再开口**，直到 LLM 在下一次唤醒重开 session | 预算是防刷屏的主闸；宁可少说 |
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
| `proactiveSessionClosedBy{reason}` | 怎么关的 | `llm-closed` 高 = 判据的关闭指引有效；`budget-exhausted` 高 = 预算偏紧或模型话多 |
| `proactiveSpokeInSession` | 每个 session 里说了几句（分布） | 分布集中在 1 = 预算 2 用不满，可考虑降为 1；集中在 2 = 预算卡着 |
| `proactiveNoSession` | 有多少次唤醒因为"没有 session"被挡 | 高 = session 开得太少（覆盖率低，符合预期但要看得见） |
| `proactiveBudgetExhausted` | 有多少次唤醒因为预算用完被挡 | 高 = 预算该加；低 = 2 条足够 |
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
