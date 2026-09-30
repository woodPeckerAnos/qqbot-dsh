# 规则链装配（CHAIN）

四条链按消息生命周期排列，runner（`../chain.ts` + `../watcher.ts`）逐层触发，
任何一层 `halt` 即短路，`defer` 由 runner 排定时器稍后重入对应链。
本文件是链装配的自然语言描述，`index.ts` 的注册表必须与之一致
（一致性由链冒烟测试校验）。

## ① continuation 链（Phase 1）

被 @ 破冰后的续聊判定。命中晋升 → 该消息离开 watcher，还原成
`NormalizedMessage`（`origin:'continuation'`）回投编排层，走完整既有
Ingress 管线（与 @ 消息同权）。

成员（机器维护）：40-promotion-window、41-inflight-merge

## ② intake 链（全量入列）

每条 observed 消息逐层过闸：开关（01）→ 白名单（02）→ 谷时段（03）→
去重（04）→ @别人（05）→ 无文本（06）→ 限流预检（07）→
强信号标注（08–11，只 mark 不拦截）→ 冷却（12，「强信号用短冷却」要求
先标注后冷却）→ 采样终局（13）。
被拦截的消息仍可能入缓冲做上下文（由该规则的 REQUIREMENT.md 声明
`halt(buffer:true)`，runner 执行）；全过则按 marks 决定评估时机：
强信号/采样达标 → 立即进 ③；否则只入缓冲，静默去抖到期后进 ③。

成员（机器维护）：01-master-switch、02-group-whitelist、03-offpeak-window、04-duplicate-event、05-at-others、06-no-text、07-rate-limit-precheck、08-strong-quick-reply、09-strong-quote-bot、10-strong-open-question、11-strong-keyword-echo、12-eval-cooldown、13-sampling-debounce

## ③ evaluate 链（Phase 2）

语义评估，当前唯一成员 `20-semantic-gate`（异步，LLM 小模型）。
silent → halt；wait → defer(30s)（最多重查一次）；speak → 放行进入 ④。

成员（机器维护）：20-semantic-gate

## ④ speak 链（Phase 2）

发言前的否决式复审：硬限流终检（30）→ 焦点预算（31）→ 准入 try（32）。
全过才由 runner 合成介入 turn 投喂 TurnRunner。介入绝不排队：
任何一层否决都直接放弃并计数。

成员（机器维护）：30-rate-limit-veto、31-focus-budget、32-admission-try
