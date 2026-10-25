---
doc: wait-convergence-requirement
kind: requirement
status: 已实施
scope: 主动介入的 wait（延迟重查）机制
touches:
  - 场景 3 判据（judge/judge.ts 的 SCENE_3_CRITERIA）
  - 闸门与票据（veto/veto.ts 的 wait 分支）
  - 调度（scene/watcher.ts 的重查定时器）
  - 会话状态（scene/state.ts 的问题台账）
  - 配置（config.ts 的 proactive 段）
params:
  - name: maxWaitPerItem
    default: 1
    meaning: 每个挂起问题最多"让路"几次（硬上限 3）
  - name: waitYieldMs
    default: 45000
    meaning: "让路"理由的等待时长（毫秒；范围 15000–120000）
stats:
  - wait_ticket_created
  - wait_ticket_resolved
  - wait_ticket_spent
  - wait_ticket_stale
  - wait_ticket_unchanged
  - wait_ticket_invalid_target
  - wait_declined
implemented:
  - src/pipeline/proactive/contract.ts（WaitReason 三态 / WaitTarget / WaitTicketTerminal / 硬上限常量）
  - src/pipeline/proactive/judge/judge.ts（场景 3 判据三态 + 对象引用 + prompt 渲染）
  - src/pipeline/proactive/veto/veto.ts（decideWait：wait 的唯一入口）
  - src/pipeline/proactive/scene/watcher.ts（每会话一个唤醒点 + 两道本地检查 + 关闭即取消）
  - src/pipeline/proactive/scene/state.ts（yieldBudgetUsed / lastEvaluatedAt / 关闭通知）
  - tests/proactive-wait.test.ts（验收 1–11 的专项用例）
---

# 原始需求

（维护者原话，逐字保留）

> 先聊聊 wait 的收敛的问题吧，这个我暂时没有思路。

（补充口径，同样逐字保留）

> 第二个 topic-spent 指标太笨了，应该处理为新内容比例，新内容达到一定比例则允许发出。

本文件只解决**前者**；`topic-spent` → 新内容比例 是另一份需求，但它与本需求的
验收 4 共用同一个"变化度量"，见「# 明确不在本需求内」。

# 需求描述

## 问题（实测证据）

生产灰度一周后：

| 指标 | 值 | 说明 |
|---|---|---|
| `judgeCalls` | 3656 | 一周的 LLM 判定调用 |
| `vetoed.wait` | **1682** | 占全部判定的 **46%**，是**最大的单一结果** |
| `wouldSend` | 56 | 真正走到"本应发言"的次数 |
| `wait-exhausted` | **0** | 上限从未生效 |

`wait` 的绝对量随样本线性增长（同一天内 164 → 一周后 1682，判定期 ×14 而
`wait` ×10），**占比虽从 63% 降到 46%，但没有任何收敛迹象**；且产出为零：
一周里它是否曾"熬到成立"过，指标上无从得知。

根因不是"等太久"，而是**它被实现成了一个独立于任何对象的新调度机制**：

1. **不绑定对象**：重查时触发标签写成 `question-probe`，候选集只剩场景 3。
   若等待本来来自场景 1/2/4/5，重查时它们**根本不在候选里**——等于在问一个
   已经被换掉的问题；
2. **没有上限**：`VetoContext.waitRetries` 恒为 `0`（`scene/watcher.ts`），
   `maxWaitRetries` 形同虚设，`wait-exhausted` 从未触发；
3. **不要求新信息**：群里完全安静时也每 30 秒问一次，内容与上一次完全相同；
4. **语义混装**：一个布尔值 `suggestsWait` 同时表达了三件时间尺度完全不同的
   事（见下节），而它们本不该由同一个机制承担。

## 而系统里本来就有一台"等等看"的机器

场景 3 的既有生命周期**不依赖 `wait`**，而且设计是对的：

```
有人提问 → 登记台账 → 90 秒探针到期
    ├ 已被回答 → 关闭台账（本地可判，不花 LLM）
    └ 仍挂着   → 评估
                    ├ 成立   → 说
                    └ 不成立 → 静默，台账 TTL 到期作废
```

延迟、上限、退出条件都有。**`wait` 唯一真正需要表达、而这台机器表达不了的，
只有「现在差不多该说了，但此刻有人在动，再给几十秒」**——这不是一个新的等待，
而是**把下一次唤醒提前一点**。

# 判定

## 一、`suggestsWait` 从布尔值改为带理由的三态

| 理由码 | 模型想说的 | 谁负责下次唤醒 | 是否新建票据 |
|---|---|---|---|
| `yielding` | 有人在答（正在打字、刚接话） | 本机制：`waitYieldMs`（默认 45s）后 | **是** |
| `not-yet` | 还没到时候（问题太新、话题刚起） | 已有的 90 秒问题探针 / 话题滚动 | **否**（按 silent 处理） |
| `watching` | 刚说完，看反应 | 不排唤醒；由下一条人类消息自然唤醒 | **否**（按 silent 处理） |

判据正文（场景 3）同步改写为三句话，不再出现布尔值。

## 二、`wait` 决策的唯一入口（否决层）

判定顺序与既有否决层一致，只替换 `wait` 这一支：

```
候选为空                        → silent('no-candidate')
无 satisfied 且无 waiter        → silent('no-scene')
无 satisfied 且有 waiter：
    ├ waiter 引用无效 / 缺失    → silent（计 wait_ticket_invalid_target）
    ├ waiter.reason ≠ yielding  → silent           ← not-yet / watching 走这里
    ├ 对象已关闭（问题已答/过期）→ silent（计 wait_ticket_stale）
    └ 对象仍挂起：
         ├ 该对象让路预算已用尽 → silent('wait-spent')
         └ 否则 → wait（建票据，计 wait_ticket_created）
```

`satisfied` 非空时的优先级**不变**（顺序 → 硬限流 → 每话题额度）。

## 三、票据的状态与转移

票据**挂在"对象"上**，不是挂在会话上：

- 对象 = 一个挂起问题（本需求只处理这一类；话题类暂不建票据）；
- 每张票据只有一次唤醒机会。

| 起始 | 条件 | 终局 | 是否花 LLM |
|---|---|---|---|
| 建票据 | 理由 = `yielding` 且对象仍挂起 | — | 已花（本次判定） |
| 唤醒 | 对象已关闭 | `stale` | **否** |
| 唤醒 | 转录自上次判定以来**无新增** | `unchanged` | **否** |
| 唤醒 | 通过了上面两道 | 重新判定一次 | 是 |
| 唤醒后 | 模型这次给不出 `yielding`（或判不成立） | `spent`（票据用尽） | 已花 |
| 唤醒后 | 模型又给 `yielding` | `spent`（预算已用尽，静默） | 已花 |

**关键纪律：唤醒前的两道本地检查必须先跑，任何一道不过都不调 LLM。**

## 四、每个会话只有一个唤醒点

同一会话内多张票据合并成一个定时器（取最近的到期时间）。唤醒时逐张票据
按上表判断，互不影响。**不允许**每张票据各排一个定时器。

## 五、对象关闭要能取消唤醒

"问题被回答了"是**本地可判**的（台账状态）。问题一旦关闭，其票据必须
**立即作废并取消唤醒**，而不是等定时器到点再发现。

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `maxWaitPerItem` | `1` | 每个挂起问题最多"让路"几次（硬上限 `3`，超出按 `3` 处理） |
| `waitYieldMs` | `45000` | "让路"理由的等待时长（毫秒；范围 `15000`–`120000`） |

两者的默认值刻意保守：**让路只能让一次**，且不超过 45 秒。

# 验收标准

1. 模型给 `not-yet` 或 `watching` → 判 **silent**，且**不排任何唤醒定时器**；
2. 模型给 `yielding` 且对象仍挂起 → 判 `wait`，排一个 `waitYieldMs` 后的唤醒，
   `wait_ticket_created` +1；
3. 唤醒时对象已关闭（问题被答 / 过期 / 话题翻篇）→ **不调 LLM**，计 `stale`，
   票据消失；
4. 唤醒时转录自上次判定以来无新增 → **不调 LLM**，计 `unchanged`，票据消失；
5. 唤醒后的重新判定，**任何结果都消耗该票据**（同一对象不会再有第二次唤醒）：
   - 仍给 `yielding` → 预算已用尽 → **silent**；
   - 给 `not-yet` / `watching` → **silent**（理由本就不排唤醒）；
   - 判不成立 → **silent**；
   以上三种都计 `spent`——这是"每张票据只有一个终局"的兑现点（对应验收 11 的等式）；
6. 唤醒前问题被回答 → 唤醒被**取消**（不是到点才发现），不产生任何计数之外的副作用；
7. 同一会话内三张票据 → 只有**一个**定时器；唤醒时三张各自按上表判断；
8. **单次等待的重查上限恒为 1**（无论 `maxWaitPerItem` 配成几，同一次等待
   不产生第二次唤醒）；
9. 模型给出的对象引用无效或缺失 → 按 **silent** 处理，计
   `wait_ticket_invalid_target`，**不建票据、不猜测对象、不退化回无限等待**；
10. `not-yet` / `watching` **不得**进入 `vetoed.wait`（它们不是"被否决"，是
    "模型说不用等"），但必须计入独立的 `wait_declined{reason}`——否则模型意图
    在指标里彻底消失，调判据时无从下手；
11. 一周灰度后账目必须闭合：
    `resolved + spent + stale + unchanged == created`（每张票据只有一个终局）；
    而 `invalid_target` 与 `wait_declined` **不产生票据**（前者是引用无效、
    后者是被本层按下），因此**不参与**上面这个等式——它们单独计数。

# 边界与反例

| 情形 | 处理 | 理由 |
|---|---|---|
| 模型对同一问题连续两次给 `yielding` | 第二次静默 | "有人在答"是有时效的理由，让路只能让一次 |
| 群里完全安静，无人说话 | 唤醒后判 `unchanged`，不调 LLM | 杜绝"纯靠沉默累积反复唤醒"（这是本项目明确写过的红线） |
| 问题在唤醒前被群友回答 | 票据立即作废 + 取消唤醒 | 本地可判的事不要花 LLM |
| 模型给了一个不存在的对象 id | 按 silent | 不猜测；`The cap must live below the model` |
| 会话里同时有 3 个挂起问题都在等 | 一个定时器，唤醒时逐个判断 | 避免定时器爆炸 |
| `maxWaitPerItem` 被配成 `5` | 按 3 处理并 warn | 硬上限防止"把收敛改回不收敛" |
| 等待期间 bot 说了别的话 | 不影响票据（票据绑问题，不绑发言） | 让路的对象是"那个人是否还在答" |
| 等待期间话题翻篇（静默 > 10 分钟） | 对象的窗口失效 → `stale` | 与台账 TTL 同口径 |

# 可观测性

新增计数（按理由与终局拆开，才能回答"wait 到底有没有价值"）：

| 计数 | 回答什么 | 期望形态 |
|---|---|---|
| `wait_ticket_created{reason}` | 模型为什么想等 | 按理由分布 → 直接反映判据是否需要调整 |
| `wait_ticket_resolved` | 等待熬到了成立 | **高 = wait 有价值**；长期为 0 = 这个机制应该删掉 |
| `wait_ticket_spent` | 让路预算用尽、静默 | 高 = 模型过度使用"让路" |
| `wait_ticket_stale` | 唤醒时对象已关闭 | **越高越好**（省下了调用） |
| `wait_ticket_unchanged` | 转录无新增，跳过重问 | 同理 |
| `wait_ticket_invalid_target` | 模型引用了不存在的对象 | 持续 > 0 说明判据描述需要更明确 |
| `wait_declined{reason}` | 模型想等、但被否决层按下（`not-yet` / `watching`，以及理由无效） | **必须有这一项**：它们走 silent 分支，否则"模型为什么没让 bot 说话"就完全不可见了 |

同时 `wait` 重查**不再复用 `question-probe` 触发标签**，改用独立的
`wait-wakeup`，于是 `evaluatedByTrigger` 终于能把"探针"与"重查"分开——
这是上一轮缺失的关键数据。

# 明确不在本需求内

| 项 | 为什么不在 | 关联 |
|---|---|---|
| `topic-spent` → 新内容比例 | 是独立议题（用计数近似"有没有新内容"） | **与本需求验收 4 共用"变化度量"**：本需求先用最朴素的实现（转录是否新增），等新内容比例落地后替换 |
| 话题类等待（场景 1/2/5 的 `yielding`） | 本轮只给"挂起问题"建票据 | 话题类等待先按 `not-yet` 处理（交给话题滚动），观察数据后再定 |
| 场景 1 预筛收紧 | 它占 satisfied 的 80% 但预筛最松 | 等本需求落地、拿到干净的 `wouldSend` 样本后再谈 |
| 关闭 `dryRun` | 需先修口径 | 见本文「# 背景」的一段：灰度中 `wouldSend` 也占话题额度，放开后的真实发送量现在无法预估 |

# 背景与调研来源

- **触发本次需求的数据**：一周灰度快照（见「# 需求描述」表格），
  `vetoed.wait = 1682`、`wait-exhausted = 0`；
- **红线来源**：MaiBot 的两道保险明确禁止"纯靠沉默累积反复唤醒回复"
  （`pending_count < 1` 不允许触发、空档折算封顶），本需求的验收 4 与
  边界表第 2 行即由此而来；
- **"上限必须在模型之下"**：openclaw#121914 的封禁复盘原话
  「The cap must live below the model, where the model cannot rationalize past it」
  ——本需求把"让路只能让一次"做成代码里的硬上限，而不是写在 prompt 里的请求；
- **为什么不新增并行状态**：项目既有纪律「状态只按会话/话题/问题/花费窗口记账，
  永不按场景记账」（架构文档 §3.0）。票据挂在**问题**这一行上，
  是这条纪律的直接应用，同时把"等待"从会话级收窄为条目级，多会话互不干扰。

# 实施顺序建议

1. **台账加两个字段**（`waitBudget` / `lastEvaluatedAt`）——其余都依赖它；
2. **判据改写**（场景 3 的三态理由）+ **否决层替换 wait 分支**（验收 1、2、9）；
3. **调度收敛**（每会话一个唤醒点 + 两道本地检查 + 关闭时取消，验收 3–7、10）；
4. **指标与触发标签**（验收 11 的账目闭合 + `wait-wakeup` 独立标签）；
5. 灰度一周后**对着 `wait_ticket_*` 决定这个机制是保留还是删掉**——
   若 `resolved` 长期为 0，正确答案可能是"直接把 `yielding` 也按 silent 处理"。

# 实施记录（落地时的三处补充判断）

需求写完后在实现里补了三个判断，都记在这里，免得下一轮再讨论一遍：

1. **`WaitTarget` 必须有 `exists`，不能只有 `open`**。
   台账在"问题被答/过期"时会把它移出挂起清单，于是"模型幻觉了一个 id"与
   "对象曾存在但刚被关掉"在只看当前清单时长得一模一样。两者必须分开计数
   （`wait_ticket_invalid_target` 说明判据要更明确；`stale` 是**好事**，
   说明本地检查省下了一次调用），所以上下文里显式带 `exists`。

2. **`lastEvaluatedAt` 记的是"跑到判定的那一刻"，不是"建票据那一刻"**。
   用建票据时刻当基准，会让唤醒时的"转录有新增"包含判定自己的触发消息，
   两道本地检查等于白设。`markEvaluated` 因此写在发起判定调用之前，
   且只前进不回退。

3. **唤醒路径上的对象 id 以票据为准**。
   重判发生在对象**仍挂起**时（否则早就按 `stale` 作废了），但模型可能选择
   不回抄 `q:<id>`。此时不能判"引用无效"——那会把一次正常的重查变成静默，
   所以唤醒路径优先用票据自己的 `targetId`（`exists:true`）。

另外两处口径说明：

- **`wait_ticket_stale` 同时覆盖两件事**：到期唤醒时发现对象已关闭，
  以及问题关闭时就地取消唤醒（验收 6）。两者都只能记 `stale`，
  否则验收 11 的等式不成立——"取消"也是这张票据的终局；
- **`resolved` 只在"唤醒后判成立"这一处**计数：那是"等待熬到了成立"，
  也是判断这个机制要不要保留的唯一依据。

## 后续修订（TOPIC-SESSION-REQUIREMENT 落地时补的第三处口径）

需求里写的"该检查应共用同一实现（同一次 `hasNewContentSince`）"已经落地为
**两处消费同一份实现**：

- wait 票据的到期唤醒用**票据自己的** `evaluatedAt`（对象级，见 `wakeWaitTickets`）；
- 话题 session 的**滚动收敛**唤醒用**会话级的** `lastEvaluationAt`（口径修正后这道闸
  只装 `topic-roll`：问题探针是时间触发、且天生有界，免闸——见 TOPIC-SESSION 文档
  §6），入口是
  `ConversationState.hasNewContentSinceLastEvaluation()`——它内部仍然调用本需求引入的
  `hasNewContentSince(since)`，只是额外多加了一条**与时间无关**的判据
  （判定那一刻的转录末尾是否换人）：OneBot 的事件时间是**秒**（`time * 1000`），
  同一秒内到达的新消息其 `ts` 并不大于本机毫秒时钟的判定时刻，只比时间戳会把它
  误判成"没有新增"。时间戳那条的边界仍是**严格大于**，本需求的语义不变。
