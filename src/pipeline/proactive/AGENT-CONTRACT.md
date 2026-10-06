# AGENT-CONTRACT —— 主动发言模块的扩展契约

> **读者是另一个 agent（或另一个会话里的我）**。假设你只看到这份文件、
> 没有看过本项目的历史讨论：照本文做，你的改动就能被接受。
> 人读版本见 [README.md](README.md)；完整架构讨论见
> [docs/PROACTIVE-INTERVENTION-ARCH.md](../../../docs/PROACTIVE-INTERVENTION-ARCH.md)。

---

## 0. 先读这五条，否则不要动手

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
5. **顺序唯一来源**：场景顺序只有 `SCENE_ORDER` 一处定义。新增/调整场景必须
   同时改 `scenes.ts` 与 `SCENES` 的自然语言描述（若已拆分），并跑契约测试。

---

## 1. 三条改动路径：先判断你要做哪一种

| 你想做的事 | 走哪条路 | 需要改代码吗 |
|---|---|---|
| 让 bot 在**新的条件下**主动说话（新的判定条件 / 新的场景） | ① 新增**介入规则** | 是（一个规则文件夹 + 一行注册） |
| 让 bot 在**新的平台上**能主动发言 | ② 实现适配器的 `proactive()` | 是（一个方法） |
| 调整"什么算命中场景"的**顺序或门槛** | ③ 改场景表 | 是（`scenes.ts` + 契约测试） |
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

## 5. 路径 ③：改场景表（`scenes.ts`）

必须同时满足：

1. `SCENE_ORDER` 与 `SCENE_DEFINITIONS` 里的 `order` 一致
   （`order = SCENE_ORDER.indexOf(id)`），契约测试会校验；
2. 每个场景声明 `triggers`：**弱信号场景（2/5 这类）只能绑 `topic-roll`**，
   绝不能绑 `message`——否则"每条消息都判一次兴趣话题"从类型层面就破防了；
3. `precheck` 必须是纯函数、返回 `undefined` 表示"本次不参与"，**不得否决别人**；
4. 全局保险（如"没人理我就停"）放在 `collectSceneHits()` 里，不放进任何场景；
5. 跑 `npx vitest run tests/scenes.test.ts`（12 条契约用例）。

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
- [ ] 新增了场景 → `SCENE_ORDER`、criteria、测试三处同步
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
- `SCENE_ORDER` / 场景集合 / 触发面 → §5
- 介入规则的三件套格式或注册位置 → §2
- 已知坑被修掉 → §7（把该行删掉，并说明修在哪）
