# 主动发言（proactive）模块

> 一句话：**bot 在没有用户消息可锚定时，主动往会话里说一句**。这是全项目
> 唯一需要"平台能力差异"的出站路径，差异被收敛在一个接口里。

本目录（`src/pipeline/proactive/`）是主动发言相关代码的**唯一聚集地**：
能力契约、投放入口、记账、场景表都在一起。要理解或修改主动发言，只看这里
和 `src/core/connector.ts` 里的那一个方法。

```
src/core/connector.ts        BotConnector.proactive?()   ← 唯一的平台能力接缝
        ▲                                │
        │ 实现（如实返回，不支持就 do nothing）
  ┌─────┴──────────────┐
  │ OneBot: 直接发      │     官方 QQ: return unsupported（定稿的保守行为）
  └────────────────────┘
        ▼  ProactiveResult { ok } | { ok:false, reason, detail?, retryable }
src/pipeline/proactive/
  speaker.ts     ProactiveSpeaker.deliver() ← 主动发言的唯一出口（永不抛错、绝不重试）
  contract.ts    三层共享契约：场景 id / 顺序 / 触发面 / 证据 / 候选 / 判定 / 终局
  collect.ts     ① 搜集层：本地预筛与候选（零 LLM 成本）
  judge.ts       ② LLM 层：逐场景"成立不成立"+ 容错解析
  veto.ts        ③ 否决层：顺序、额度、终局（**「取第一个」在这里落地**）
  README.md      本文（给人读）
  AGENT-CONTRACT.md  给 agent 读的扩展契约（新增规则 / 新增平台）
```

## 1. 两条出站路径的区别（为什么需要这个模块）

| | 被动回复 `reply(ctx, out)` | **主动发言 `proactive(target, out)`** |
|---|---|---|
| 锚点 | 有（用户消息的 `msgId` / `eventId`） | **没有** |
| 官方 QQ | 支持：5 分钟被动窗口内、每条最多回 5 次 | **不支持**：主动推送 2025-04-21 起停用；群聊主动消息每月 4 条；用户可关闭接收 |
| OneBot | 支持 | 支持（无窗口、无平台配额） |
| 外层逻辑 | 一套（Responder + 配额账本） | **一套**（`ProactiveSpeaker`） |

官方通道"不提供"这件事**不是错误**，而是需要被如实表达的**能力缺失**。
所以官方适配器的实现就是 `return { ok: false, reason: 'unsupported', … }`
（do nothing），外层逻辑一行都不用改——这就是本模块的全部设计意图。

## 2. 平台能力层：新增一个平台要做什么

只需实现 `BotConnector.proactive?`，**永不抛错**，用返回值表达三件事：

```ts
async proactive(target: ConversationTarget, out: OutgoingMessage): Promise<ProactiveResult> {
  // 不支持 → 什么都不做
  return { ok: false, reason: 'unsupported', retryable: false };
  // 额度用尽 / 被限频
  return { ok: false, reason: 'quota', detail: '本月主动消息已用尽', retryable: false };
  // 成功
  return { ok: true };
}
```

纪律：

- **不实现该方法 = 不支持**（与"官方层 do nothing"同义，缺省安全）；
- **不在适配器里做预算判断**：额度策略属于会话层（`src/intervention/` 的
  speak 链），适配器只如实报告结果，两处都算账会形成两套账；
- **不抛错表达业务失败**：网络异常等真故障可以抛，`ProactiveSpeaker` 会兜住
  并按 `error` 降级（但仍不重试）。

## 3. 会话层：主动发言怎么被触发

| 触发来源 `trigger` | 谁发起 | 现状 |
|---|---|---|
| `intervention:scene-1` … `scene-5` | 介入层（旁听 → 仲裁 → speak 链） | 见 `docs/PROACTIVE-INTERVENTION-ARCH.md`（方案，未实施） |
| `manual` | 管理员命令 | 预留 |
| `system-event` | 进群问候等平台事件 | 预留 |

`trigger` 只用于**记账与日志**（让 `/metrics` 能回答"哪个场景在说话、
哪个通道在降级"），平台侧看不到它，也不要用它做任何判定。

## 4. 三层架构（`scene/` / `judge/` / `veto/`）

**先读 [SCENES.md](interests/SCENES.md)**：那里用自然语言写着"当前 bot 会在什么情况下
主动开口"。本节讲的是这套东西**怎么实现**。

「要不要说话」的判定被拆成三层，**每层只做一件事，且明确不能做另两件事**：

| 层 | 文件 | 做什么 | **绝不能**做什么 |
|---|---|---|---|
| ① 搜集 | `scene/collect.ts` | 本地、零成本地找出候选场景；执行全局保险（没人理我就停） | 语义判断、调 LLM、决定谁赢 |
| ② LLM | `judge/judge.ts` | 对**每个候选**回答"成立吗"（多标签 + 置信度 + 理由 + 证据） | 做优先级/预算裁决、产生候选外的场景 |
| ③ 否决 | `veto/veto.ts` | 顺序、硬限流、话题预算、wait 采纳 → 唯一的终局 | 读原始消息文本、调 LLM、任何语义判断 |
| 投递 | `deliver/speaker.ts` | 唯一出口 + 降级链 + 记账（§6） | 做额度判断（避免两套账） |

**为什么「取第一个」必须在第三层**：它是资源分配（把有限发言机会给谁），
不是语义判断。写进 prompt 就再也无法参数化顺序、无法离线回放对比不同顺序、
也无法单测"同时命中谁赢"。所以 LLM 只回答"每个场景成立不成立"，
**谁赢由代码算**（`evaluateVeto()` 里的一行 `reduce`）。

这也是介入层四条规则链（intake / evaluate / speak）的自然归位：
intake ≈ 搜集、evaluate ≈ LLM、speak ≈ 否决。新增判定时先问"这属于哪一层"，
再决定加到哪条链——详见 AGENT-CONTRACT.md §2.2。

## 5. 5 个介入场景与优先级（细节见 [SCENES.md](interests/SCENES.md)）

下表是速查；**每个场景的人话描述、反例与典型对话在 [SCENES.md](interests/SCENES.md)**，
那份文件是场景的真相源（与代码的一致性由契约测试强制）：

业务方给出的 5 种主动介入场景，**按顺序取第一个命中**：

| 顺序 | 场景 | 触发时机 | 一句话门槛 |
|---|---|---|---|
| 1 | `scene-4` 指代 | 每条旁听消息 | 没有 @，但确实是在**对 bot 说话**（不是议论 bot） |
| 2 | `scene-1` 续聊追问 | 每条旁听消息 | bot 参与过该话题，追问尚未被任何人解决 |
| 3 | `scene-3` 无人应答 | 问题探针（90s → 10min） | 问题仍无人答 + 在 bot 能力域内 |
| 4 | `scene-2` 持续讨论 | 话题滚动（每 30 条 / 5 分钟） | 能提供能力 / 有可答问题 / 有事实性错误，且有信息增量 |
| 5 | `scene-5` 兴趣话题 | 话题滚动（同上） | 话题停在"没结论、没人动手"，bot 能补一句能立刻用的结果 |

两条全局纪律（不属任何场景，**对所有场景一律生效**）：

- **「没人理我就停」**：连续 2 次介入后群里毫无回应 → 全体沉默
  （任何用户发言归零）。见 `scene/collect.ts` 的 `collectCandidates()` 入口。
- **顺序唯一来源**是 `contract.ts` 的 `SCENE_ORDER`；判据清单按它构造、
  候选按它排序、「取第一个」按它裁决、trace 按它记账——任何地方都不许再写第二份顺序。
  裁决时还可传入 `VetoContext.order` 覆盖它（回放对比用），但覆盖只影响**裁决**，
  不影响任何判据。

场景顺序、criteria 文本、门槛口径的完整讨论见
[docs/PROACTIVE-INTERVENTION-ARCH.md](../../../docs/PROACTIVE-INTERVENTION-ARCH.md)（§1 场景翻译、§4 契约）。

## 6. 投放结果的降级链（`deliver/speaker.ts`）

```
disabled（总开关关）→ empty（内容为空）→ unsupported（平台不支持 / 适配器未实现）
  → quota → rate-limit → error
```

- **先短路，后计数**：每次降级都记一次指标，否则"官方通道静默不发言"
  在现场会表现成"bot 坏了"；
- **既不重试也不排队**：主动发言补投在业务上没有意义（话题已经翻篇）；
- **永不抛错**：`deliver()` 的返回值就是全部信息，调用方不需要 try/catch。

## 7. 配置与观测

| 配置（`qqbot.yml` 的 `proactive:` 段） | 默认 | 说明 |
|---|---|---|
| `intervention.enabled` | `false` | 介入层总开关（默认关、群白名单、谷时段）。**主动发言复用它** |
| `proactive.interestsEnabled` | `true` | 兴趣池总开关（场景 5） |
| `proactive.interestsFile` | `interests.yml` | 兴趣池文件路径（`QQ_INTERESTS_FILE` 可覆盖）。**不存在 = 空池**，格式错 = 启动报错 |
| `proactive.botAliases` | `[]` | bot 在本群的别名（场景 4 指代检测）；至少 2 字、最多 5 个 |
| `proactive.topicRollMessages` / `topicRollMs` | `30` / `300000` | 话题滚动周期（场景 2/5 的入口；消息数或时间先到者） |

**给场景 5 加兴趣条目**：`cp src/pipeline/proactive/interests/interests.yml.example interests.yml`
然后按字段加——完整说明见 [interests/SCENES.md](interests/SCENES.md) 的
「怎么给这个场景加兴趣条目」，样例的注释里有每条规则的由来。

> 兴趣池的**上游是可替换的**：后续会由 role-play 动态设定（维护者已预告），
> 届时只是多了一个条目来源，`scene/` `judge/` `veto/` 三层不做改动。
> 接缝见 `interests/pool.ts` 的 `replaceEntries()`。

⚠️ **不要为主动发言另立一个并列开关**：两个开关会让人无法回答"为什么它不说话"。
`ProactiveSpeaker` 之所以仍持有 `enabled`，只是为了让"关闭"这件事也能被记账
（`disabled` 降级），而不是让每个调用方在外部写 `if (enabled)` 分支。

观测（接到 health / `/metrics` 上）：

- `capability(target)` → `ready` / `unsupported` / `no-connector`：
  **部署后第一件该看的事**——官方通道上它必然是 `unsupported`，这不是故障；
- 按 `trigger` 的送达计数、按 `reason` 的降级计数（顺序见
  `PROACTIVE_DEGRADE_ORDER`，同时是排查顺序）；
- 启动摘要里会显示兴趣池的 `loaded` / `count`（`describeConfig`）：
  **`interestsEnabled: true` + `loaded: false` 就是"路径配错了"**，
  这是场景 5 不触发时第一个该看的地方。

## 8. 边界：这个模块**不**做什么

- 不做节流/预算/限流（属于会话层的 speak 链，两处都做会形成两套账）；
- 不做内容生成（属于 agent turn）；
- 不做"要不要说"的判定（属于介入层的仲裁与场景表）；
- 不因为平台返回 `unsupported` 就改变任何调用方流程。
