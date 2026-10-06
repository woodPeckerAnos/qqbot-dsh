# AGENT-CONTRACT —— 主动发言模块的扩展契约

> **读者是另一个 agent（或另一个会话里的我）**。假设你只看到这份文件、
> 没有看过本项目的历史讨论：照本文做，你的改动就能被接受。
> **先读 [SCENES.md](SCENES.md)**——当前生效场景的自然语言说明书。
> 其余人读版本见 [README.md](README.md)；完整架构讨论见
> [docs/PROACTIVE-INTERVENTION-ARCH.md](../../../docs/PROACTIVE-INTERVENTION-ARCH.md)。

## 目录

```
src/pipeline/proactive/
  SCENES.md            当前生效场景的自然语言真相源（**新增场景第一步**）
  contract.ts          三层共享契约：SceneId / SCENE_ORDER / 触发面 / 判定 / 终局
  scene/collect.ts     ① 搜集层    judge/judge.ts  ② LLM 层
  veto/veto.ts         ③ 否决层    deliver/speaker.ts  投递层
  README.md / AGENT-CONTRACT.md
```

---

## 0. 先读这七条，否则不要动手

1. **一个概念只有一个家**：主动发言的所有代码在 `src/pipeline/proactive/`；
   平台能力在 `src/core/connector.ts` 的 `BotConnector.proactive?`。
   不要在别处新增第二个"发送"入口。
2. **永不抛错、绝不重试、禁排队**：所有失败都用返回值表达
   （`ProactiveOutcome`），调用方不写 try/catch，也不做补投。
3. **能力缺失不是错误**：平台不支持 → `{ ok: false, reason: 'unsupported' }`，
   **不是**抛异常、**不是** warn 刷日志（外层已按原因计数）。
4. **不新增第二本账**：节流、预算、限流属于会话层（介入规则的 speak 链）。
   适配器与本模块都不做额度判断，只如实报告结果。
   同理**不要新增并列的开关**：`ProactiveSpeaker.enabled` 应当直接来自
   `intervention.enabled`，另立一个会让人无法回答"为什么它不说话"。
5. **顺序唯一来源**：场景顺序只有 `contract.ts` 的 `SCENE_ORDER` 一处定义。
   判据清单、候选排序、裁决、trace 全部由它派生；只在 `VetoContext.order`
   允许为回放对比**覆盖裁决顺序**。新增/调整场景必须同步三处并跑契约测试。
6. **判定分三层，不许越层**：搜集（`scene/collect.ts`，本地、零 LLM）→ 判据
   （`judge/judge.ts`，逐场景"成立不成立"）→ 否决（`veto/veto.ts`，顺序与额度的唯一实现）。
   越层的典型错误：把"取第一个"写进 prompt、让 veto 读消息文本、
   在 collect 里调 LLM。
7. **改行为 = 先改人话**：任何"bot 会在什么情况下开口"的变化，先在
   [SCENES.md](SCENES.md) 里用自然语言写清楚（什么情况下出现 / 什么算命中 /
   典型对话 / 误报的代价），再去改代码。**先写人话，再写代码**——
   文档与代码不一致时契约测试会红（「验收20–22」），这是刻意的。

---

## 1. 五条改动路径：先判断你要做哪一种

| 你想做的事 | 走哪条路 | 需要改代码吗 |
|---|---|---|
| 让 bot 在**新的条件下**主动说话（新的判定条件 / 新的场景） | ① 新增**介入规则** | 是（一个规则文件夹 + 一行注册） |
| 让 bot 在**新的平台上**能主动发言 | ② 实现适配器的 `proactive()` | 是（一个方法） |
| **新增一个介入场景** | ③0 **先改 `SCENES.md`**（自然语言），再改三层 | 是（见 §5.1） |
| 调整"什么算命中场景"的**本地门槛** | ③a 改搜集层 | 是（`scene/collect.ts` 的 `precheck` + 契约测试） |
| 调整**判据文案 / 输出契约** | ③b 改 LLM 层 | 是（`judge/judge.ts`） |
| 调整**顺序 / 额度 / 预算 / wait 策略** | ③c 改否决层 | 是（`veto/veto.ts`，纯函数、可穷举测试） |
| 只想改文案 / 阈值 | 配置（`qqbot.yml` / env） | 否 |

---

## 2. 路径 ①：新增一条**介入规则**（最常用）

规则是"要不要说话"的判定单元。一条规则 = 一个文件夹，三件套：

```
src/intervention/rules/<NN-name>/
  REQUIREMENT.md   自然语言需求（真相源，frontmatter 含 rule/stage/order/params/stats）
  rule.ts          export const rule: InterventionRule
  rule.test.ts     单测，测试名必须带「验收N」编号，逐条覆盖 REQUIREMENT 的验收标准
```

### 2.1 硬性纪律（生成器的静态校验同样据此，违反会被拒）

1. **需求即真相源**：先改 `REQUIREMENT.md`，再改实现。
2. **规则必须是纯函数**：`rule.ts` 只允许 `import type ... from '../../contract.js'`
   （必要时加纯类型）。**禁止**：`Date.now` / `new Date` / `Math.random` /
   `setTimeout` / `setInterval` / `fetch` / `require` / `process.*` / `globalThis.*` /
   `fs` / 任何网络调用。需要时间用 `ctx.now`，需要 LLM 用 `ctx.gate`，
   需要状态用 `ctx.state`（只读视图）。
3. **一条规则只做一层判定**，裁决只有四种：
   - `pass`：放行，进下一层；
   - `mark`：标注后继续（`marks` 里的位给下游用）；
   - `defer(ms, reason)`：延迟重查（定时器由 runner 排）；
   - `halt(reason, buffer?)`：拦截短路，`reason` 必须可读（会进 trace 与统计）。
4. **fail-closed**：判定失败、输入缺失、参数非法 → 一律 `halt`，永不放行出消息。
5. **编号即顺序**：文件夹编号前缀 = `order` = frontmatter 的 `order`，三者一致；
   同 stage 内按编号升序触发；同一 stage 内 order 不得重复。
6. **参数只允许标量**（`number | string | boolean`）：在 frontmatter 声明默认值，
   `rule.ts` 的 `paramsSpec` 必须与之逐字一致。
   ⚠️ **未知 params 键会被静默忽略**——写错键名不会报错，只会"改了没用"，
   因此新增参数时务必同步 frontmatter、`paramsSpec` 与文档示例。

### 2.2 挂到哪条链（stage 的语义）

| stage | 干什么 | 典型规则 |
|---|---|---|
| `continuation` | @ 之后的续聊晋升（这条链的 halt **不是拒绝**，只是不晋升） | 40/41 |
| `intake` | 每条旁听消息的逐层预筛；强信号只 `mark`，终局决定评估时机 | 01–13 |
| `evaluate` | 语义仲裁（全链唯一 LLM 判定点）；`silent` → halt，`wait` → defer，`speak` → 放行 | 20 |
| `speak` | 发言前的否决式复审（限流、预算、准入）；**任何一层否决都直接放弃** | 30–33 |

新增场景相关的判定，**默认挂 `intake`**（廉价、可短路）；只有当你要引入
一次新的 LLM 调用时才碰 `evaluate`——先读第 3 节的成本纪律。

### 2.3 注册（唯一允许 import 规则文件夹的地方）

`src/intervention/rules/index.ts` 加两行（import + 按 order 放进对应 stage 数组），
并同步 `src/intervention/rules/README.md` 的清单表与 `CHAIN.md` 的成员行
（一致性由链冒烟测试校验）。**不要在别处注册规则。**

### 2.4 生成口（可选，但有硬约束）

```bash
npm run gen:rule -- "<一句自然语言需求>"
```

它跑五步：① 结构化需求 → ② **人工确认草稿**（唯一人工闸）→ ③ 生成三件套 →
④ 机器校验（静态纪律 → `tsc` → `vitest` → 链冒烟，失败最多 3 轮自我修复）→
⑤ 生成注册 diff（**不提交**）。

agent 必须知道的三个副作用：

- 生成器**直接写进 `src/`**（不是临时目录）；
- 校验失败会把整个规则夹 `rename` 到 `rules/_rejected/<ISO>/`；
- 它**不会**替你提交，也不会改 `qqbot.yml`；提交前请自己 `git diff` 复核。

---

## 3. 成本纪律（新增判定前必须回答的问题）

**一次评估最多一次 LLM 调用。** 主动发言的评估已经有一次
（`evaluate` 链的场景仲裁），所以：

- 不要在 `intake` 里新增 LLM 调用——那里只能做本地判定；
- 不要为每个场景各加一次调用（成本 ×N，且并发完成顺序会让"取第一个"不可复现）；
- 需要新的语义判据时，**并入同一次仲裁的 criteria**（加一段自然语言），
  而不是新开一次调用；
- 需要新状态时，先问"这是**会话级事实**还是**场景判据**"：
  会话级事实（如"没人理我就停"）必须做成全局前置，不能写进某个场景，
  否则场景之间会互相绕过。

---

## 4. 路径 ②：新增一个平台的主动发言能力

```ts
// src/adapters/<platform>/connector.ts
async proactive(target: ConversationTarget, out: OutgoingMessage): Promise<ProactiveResult> {
  // 1) 平台不支持 → do nothing
  //    return { ok: false, reason: 'unsupported', detail: '<为什么>', retryable: false };
  // 2) 平台有额度概念 → 如实报告，不自己算账
  //    return { ok: false, reason: 'quota', retryable: false };
  // 3) 发送
  //    await this.api.sendXxx(...); return { ok: true };
}
```

- 方法名与签名**必须**是 `proactive(target, out)`（可选方法）；
- **不实现 = 不支持**，这是安全缺省，不要为了"完整"而写假实现；
- 失败用返回值；真故障（网络）可以抛，`ProactiveSpeaker` 会兜住并记 `error`；
- 发送前请复用本平台既有的编码/清洗路径（如 OneBot 的
  `normalizeWhitespace` + `stripControlChars`），不要另写一套；
- 加单测：至少覆盖 `ok: true`、`unsupported`、抛错三条。

**验收**：`tests/proactive-speaker.test.ts` 的契约不能被改坏——
它断言"平台差异只体现在返回值，外层一条路径"。

---

## 5. 路径 ③：改场景（三层各改各的）

三层文件与职责（**先定位你改的是哪一层，再动手**）：

| 层 | 文件 | 你在这里能改什么 | 不该出现在这里的东西 |
|---|---|---|---|
| ① 搜集 | `scene/collect.ts` | `SCENE_DEFINITIONS` 的 `precheck` / `triggers`；`collectCandidates()` 的保险 | LLM 调用、额度判断、"谁赢" |
| ② LLM | `judge/judge.ts` | `SCENE_1..5_CRITERIA` 文案、`renderJudgeCriteria()`、`parseSceneVerdicts()` 容错 | 优先级/预算、候选之外的场景 |
| ③ 否决 | `veto/veto.ts` | `VetoPolicy` 默认值、否决顺序、`selectByQuantileBudget()` | 读消息文本、调 LLM、语义判断 |

### 5.1 加一个场景（**先写人话，再写代码**）

**第 0 步（不可跳过）：在 [SCENES.md](SCENES.md) 里新增一节自然语言描述**，
按现有五节的格式交代四件事——① 什么情况下出现；② 什么算命中 / 什么不算（含反例）；
③ 至少一个**典型对话**例子；④ 误报的代价（这条决定它的优先级与门槛高低）。
**顺序也是产品决策**：章节顺序 = `SCENE_ORDER` 顺序，先想清楚它排第几。

然后才是代码三处：

1. **`contract.ts`**：`SceneId` 加 `'scene-6'`，并决定它在 `SCENE_ORDER` 里的位置
   （不要随手放最后——放最后等于它几乎永远轮不到）；
2. **`scene/collect.ts`**：加一条 `SCENE_DEFINITIONS`（`name` / `triggers` / `precheck`）。
   ⚠️ `name` 必须与 SCENES.md 章节标题里的名字**逐字一致**（契约测试校验）；
   **弱信号场景只能绑 `topic-roll`**，绝不绑 `message`；
3. **`judge/judge.ts`**：加 `SCENE_6_CRITERIA` 并登记进 `CRITERIA_TEXT`
   （`SCENE_CRITERIA` 按 `SCENE_ORDER` 构造，忘了登记契约测试立刻失败）；
4. **`veto/veto.ts`**：通常**不用改**——顺序与额度是全场景共用的。
   只有"这个场景允许突破话题预算"这类特殊策略才动，且必须写成显式策略；
5. 跑 `npx vitest run tests/scenes-layers.test.ts`（22 条契约用例，其中
   「验收20–22」专门校验 SCENES.md 与代码一致）。

### 5.2 只改本地门槛（最常见）

只动 `collect.ts` 的 `precheck`。纪律：

- **纯函数**：返回 `undefined` 表示"本次不参与"，**不得否决别人**；
- 宁漏不误报：预筛放宽的代价只是多一次 LLM 调用（还有判据复核），
  预筛收紧的代价是**永久漏掉**真实机会；
- 全局保险（"没人理我就停"）放在 `collectCandidates()` 的入口，
  **不放进任何场景**——没人理是会话级事实，写进某个场景别的场景就能绕过它。

### 5.3 只改判据文案

只动 `judge.ts` 的 criteria 常量。纪律：

- 改动要能回答"这条新判据在回放数据上会怎么表现"（所以先有 §4 的回放再调文案）；
- **不要把顺序/预算写进 prompt**——那是 §5.4 的事；
- 输出契约（`JUDGE_OUTPUT_CONTRACT`）改动要同步 `parseSceneVerdicts()` 的容错；
- 未知场景标签一律**丢弃该项**，不要整条降级为 silent（一个幻觉标签不该毁掉
  其余正确判定）；整条不可解析才返回 `undefined`。

### 5.4 改顺序 / 额度 / 预算

只动 `veto.ts`（纯函数，可以穷举测试）：

- 「取第一个」就是 `evaluateVeto()` 里按 `SCENE_ORDER` 排序后取首个——
  换顺序只需要改 `contract.ts` 的 `SCENE_ORDER`，或为回放对比传
  `VetoContext.order`；
- 新增额度约束时，**只收紧不放宽**，并加进 `VETO_REASON_ORDER`（排查顺序）
  与对应单测；
- 分位数预算默认关闭（`quantileBudget: false`）：它依赖 `sceneRates`
  回放统计，没数据时开启等于用先验值赌运气。

---

## 6. 提交前自检清单（照抄执行）

```bash
npx tsc -p tsconfig.json --noEmit          # 必须 0 错误
npx vitest run                             # 必须全绿（含 tests/scenes.test.ts、tests/proactive-speaker.test.ts）
git diff                                   # 复核：有没有偷偷改到别人的链/规则/适配器
```

逐条确认：

- [ ] 我改的东西落在正确的家（规则在 `rules/`，发送在 `proactive/`，平台在 `adapters/`）
- [ ] 我没有新增第二个发送入口，也没有在适配器里做额度判断
- [ ] 我的规则是纯函数（没有 `Date.now` / 随机 / IO / 定时器）
- [ ] 我的判定失败时是 `halt`（fail-closed），不是放行
- [ ] 我没有新增 LLM 调用；需要的语义判据并入了既有 criteria
- [ ] 新增/修改了参数 → frontmatter、`paramsSpec`、文档三处同步
- [ ] 新增了场景 → **`SCENES.md` 先写人话** + `contract.ts` / `scene/collect.ts` /
      `judge/judge.ts` 三处同步 + 测试（「验收20」会检查文档）
- [ ] 我的改动没有越层（collect 无 LLM、judge 无裁决、veto 无语义）
- [ ] `REQUIREMENT.md` 的验收标准与 `rule.test.ts` 的「验收N」逐条对应
- [ ] 我更新的文档：本文 / `README.md` / `docs/PROACTIVE-INTERVENTION-ARCH.md`（按改动范围）

---

## 7. 已知坑（踩过的，别重踩）

| 坑 | 事实 | 正确做法 |
|---|---|---|
| 以为"speak 链全过"就迁相位 | 相位与限流记账发生在**投递成功之后**；准入被拒时两者都不动 | 新的记账也要挂在"成功点"上 |
| 以为 `defer` 只是等一等 | 消息在 `defer` 时**已经进缓冲** | 不要重复入缓冲（`pushEntry` 有幂等保护，但别依赖它兜错） |
| 以为 FADING = 停止评估 | FADING 的真实语义是**采样阈值减半** | 要停就用限流/开关，别指望相位 |
| 以为 `@` 路径不受限可以直接类比 | `spokeAt` 只记主动介入，@ 回复本来就不进这本账 | 不要用"@ 不受限"当放宽介入限流的理由 |
| 拿 `interventionsDroppedInFlight` 做统计 | 该字段不存在 | 用 `interventionsDroppedBusy` + 规则 32 的 halt 计数 |
| 照 P0 方案文档配 `inflight-merge.maxMessages` | 实际参数名是 `maxPending` / `maxAgeMs`，写错**静默无效** | 以代码为准；新增参数时三处同步 |
| 以为 `/listen` 命令存在 | 控制面完全没做（`setRuntimeEnabled()` 无调用点） | 需要控制面就先实现，不要假设 |
| 在转录里找不到 bot 自己刚说的话 | 旁听缓冲只收非 @ 消息，bot 的 @ 回复不进缓冲 | 场景 1 的判定需要 `<bot最近发言>` 块（见架构方案 §3.6） |

---

## 8. 与本文件的同步义务

改以下任何一处，必须在**同一次提交**里更新本文件对应小节：

- `BotConnector.proactive` 签名或 `ProactiveResult` 形状 → §4
- `ProactiveSpeaker` 的降级链或原因枚举 → §1、§6
- `SCENE_ORDER` / 场景集合 / 触发面 / **某个场景的生效条件** → §5.1 **且必须同步 SCENES.md**
- 目录结构（层与文件的对应） → §0 的目录树、README §4
- 三层的文件划分或职责边界 → §1、§5
- `VetoPolicy` 字段或默认值 → §5.4
- 介入规则的三件套格式或注册位置 → §2
- 已知坑被修掉 → §7（把该行删掉，并说明修在哪）
