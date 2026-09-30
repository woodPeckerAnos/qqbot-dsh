# 介入规则编写指南

一条规则 = 一个文件夹（`NN-name/`），内含固定三件：

| 文件 | 作用 |
|---|---|
| `REQUIREMENT.md` | **自然语言需求（真相源）**：原始需求、需求描述、判定、参数、验收标准、背景 |
| `rule.ts` | 实现：`export const rule: InterventionRule`（契约见 `../contract.ts`） |
| `rule.test.ts` | 单测：验收标准逐条覆盖，测试名带「验收N」编号 |

## 硬性纪律（生成器的静态校验同样据此）

1. **需求即真相源**：改行为先改 `REQUIREMENT.md`，再改实现（或用
   `npm run gen:rule -- --from-requirement <dir>` 重新生成）；
2. **规则是纯的**：`rule.ts` 只 import `../../contract.js`（必要时加纯类型），
   禁止 `Date.now` / `Math.random` / `fs` / 网络 / 定时器——时间用 `ctx.now`，
   LLM 能力用 `ctx.gate`（evaluate 链注入）；
3. **一条规则只做一层判定**：裁决四选一——`pass`（放行）/ `mark`（标注后继续）/
   `defer`（延迟重查）/ `halt`（拦截短路，必须带可读 reason）；
4. **编号即顺序**：文件夹编号前缀 = `order` = frontmatter 的 order，三者一致
   （链冒烟测试校验）；同 stage 内按编号升序触发；
5. **fail-closed**：判定失败 / 输入缺失一律 halt，永不放行出消息。

## 参数

在 `REQUIREMENT.md` frontmatter 声明默认值（`params`），`rule.ts` 的
`paramsSpec` 与之保持一致；运行期生效值 = paramsSpec ∪
`qqbot.yml` 的 `intervention.rules.<name>.params` 覆盖 ∪ 全局注入
（env 来源值优先级最高，见 watcher.resolveParams）。

## 规则清单

| 文件夹 | stage | 一句话需求 | 期数 |
|---|---|---|---|
| [01-master-switch](01-master-switch/REQUIREMENT.md) | intake | 总开关或本群开关关闭时什么都不听 | P0 |
| [02-group-whitelist](02-group-whitelist/REQUIREMENT.md) | intake | 群不在允许集内不听 | P0 |
| [03-offpeak-window](03-offpeak-window/REQUIREMENT.md) | intake | 非谷时段不评估介入（正价不花闲钱） | P2 |
| [04-duplicate-event](04-duplicate-event/REQUIREMENT.md) | intake | 框架重连重放的重复事件丢弃 | P0 |
| [05-at-others](05-at-others/REQUIREMENT.md) | intake | @ 了别人的消息不评估 | P2 |
| [06-no-text](06-no-text/REQUIREMENT.md) | intake | 无文本内容的消息不评估 | P2 |
| [07-rate-limit-precheck](07-rate-limit-precheck/REQUIREMENT.md) | intake | 已达硬限流不再评估（省 Gate 成本） | P2 |
| [08-strong-quick-reply](08-strong-quick-reply/REQUIREMENT.md) | intake | bot 发言后 30s 内的文本标强信号 | P2 |
| [09-strong-quote-bot](09-strong-quote-bot/REQUIREMENT.md) | intake | 引用 bot 消息标强信号 | P2 |
| [10-strong-open-question](10-strong-open-question/REQUIREMENT.md) | intake | 问句 90s 无人应答标强信号 | P2 |
| [11-strong-keyword-echo](11-strong-keyword-echo/REQUIREMENT.md) | intake | 命中 bot 上次发言关键词标强信号 | P2 |
| [12-eval-cooldown](12-eval-cooldown/REQUIREMENT.md) | intake | Gate 冷却期内不重复评估（强信号短冷却） | P2 |
| [13-sampling-debounce](13-sampling-debounce/REQUIREMENT.md) | intake | 终局：攒够 6 条或静默 20s 才评估 | P2 |
| [20-semantic-gate](20-semantic-gate/REQUIREMENT.md) | evaluate | 这个话题值不值得插话（需求正文即 prompt 来源） | P2 |
| [30-rate-limit-veto](30-rate-limit-veto/REQUIREMENT.md) | speak | 硬限流终检：10min ≤3 且 1h ≤8 | P2 |
| [31-focus-budget](31-focus-budget/REQUIREMENT.md) | speak | FOCUS 相位内主动发言 ≤2 次 | P2 |
| [32-admission-try](32-admission-try/REQUIREMENT.md) | speak | 并发无名额或会话锁被占则放弃 | P2 |
| [40-promotion-window](40-promotion-window/REQUIREMENT.md) | continuation | @ 后 120s 内同发送者的非 @ 文本晋升为提问 | P1 |
| [41-inflight-merge](41-inflight-merge/REQUIREMENT.md) | continuation | turn 在途时晋升消息合并（≤5 条/60s） | P1 |

新增规则：复制任意现有文件夹改名改编号，或走生成口
`npm run gen:rule -- "<自然语言需求>"`（见 `../codegen/`）。
