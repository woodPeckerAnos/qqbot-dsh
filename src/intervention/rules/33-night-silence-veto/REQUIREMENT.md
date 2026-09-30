---
rule: night-silence-veto
stage: speak
order: 33
params:
  - name: startHour
    default: 23
    meaning: 夜间窗口起始小时（含），按 timezoneOffset 指定的本地时间计，0-23 整数
  - name: endHour
    default: 8
    meaning: 夜间窗口结束小时（不含），按 timezoneOffset 指定的本地时间计，0-23 整数
  - name: timezoneOffset
    default: 8
    meaning: 本地时间相对 UTC 的偏移小时数，北京时间为 8
stats: halt_night_silence
---

# 原始需求

speak 链加一条否决规则：夜里 23 点到次日早上 8 点（北京时间，UTC+8）bot 不主动插话，防止深夜打扰群成员。时段判定用 ctx.now 换算北京时间的当前小时；起止小时与时区偏移做成参数可配。

# 需求描述

在 speak 链中增加一条夜间静默否决规则。规则只读取 `ctx.now` 与参数 `startHour`、`endHour`、`timezoneOffset`，把 `ctx.now` 换算为指定时区的本地小时，并判断该小时是否落在夜间窗口内。若落在窗口内，则否决主动插话，返回 `halt`，reason 为 `night-silence`；若不在窗口内，则返回 `pass`。规则不持有状态，也不读写相位、限流窗口、预算等共享状态；`ctx.now` 由调用方注入或提供，规则只读不修改。窗口起止小时可配，默认北京时间 23:00（含）到次日 08:00（不含）。

# 判定

输入：
- `ctx.now`：Date 或 Unix epoch 毫秒数，测试中必须可注入固定值。
- `startHour`、`endHour`、`timezoneOffset`：来自规则参数。

计算本地小时：

```text
nowMs = ctx.now 为 Date 时取 getTime()，否则取 ctx.now 本身
localMs = (((nowMs + timezoneOffset * 3600000) % 86400000) + 86400000) % 86400000
localHour = floor(localMs / 3600000)
```

夜间窗口命中条件：
- 若 `startHour < endHour`：命中当且仅当 `startHour <= localHour < endHour`。
- 若 `startHour > endHour`：命中当且仅当 `localHour >= startHour` 或 `localHour < endHour`。
- 若 `startHour == endHour`：视为空窗口，不命中。

动作：
- 命中夜间窗口：`halt`，reason 为 `night-silence`。
- 未命中夜间窗口：`pass`。

| 输入 | 条件 | 动作 |
| --- | --- | --- |
| `ctx.now`、`startHour`、`endHour`、`timezoneOffset` | 换算后的 `localHour` 命中夜间窗口 | `halt` + `night-silence` |
| `ctx.now`、`startHour`、`endHour`、`timezoneOffset` | 换算后的 `localHour` 未命中夜间窗口 | `pass` |

# 参数

| 名字 | 默认值 | 含义 |
| --- | --- | --- |
| startHour | 23 | 夜间窗口起始小时（含），按 timezoneOffset 指定的本地时间计，0-23 整数 |
| endHour | 8 | 夜间窗口结束小时（不含），按 timezoneOffset 指定的本地时间计，0-23 整数 |
| timezoneOffset | 8 | 本地时间相对 UTC 的偏移小时数，北京时间为 8 |

# 验收标准

1. 使用默认参数 `startHour=23`、`endHour=8`、`timezoneOffset=8`，注入 `ctx.now=1704121200000`（北京时间 2024-01-01 23:00），规则返回 `{ action: 'halt', reason: 'night-silence' }`。
2. 使用默认参数，注入 `ctx.now=1704153540000`（北京时间 2024-01-01 07:59），规则返回 `{ action: 'halt', reason: 'night-silence' }`。
3. 使用默认参数，注入 `ctx.now=1704153600000`（北京时间 2024-01-01 08:00），规则返回 `{ action: 'pass' }`，证明 `endHour` 为不含边界。
4. 使用默认参数，注入 `ctx.now=1704121140000`（北京时间 2024-01-01 22:59），规则返回 `{ action: 'pass' }`，证明 23:00 前不进入夜间窗口。
5. 使用默认参数，注入 `ctx.now=1704124800000`（北京时间 2024-01-02 00:00），规则返回 `{ action: 'halt', reason: 'night-silence' }`，证明跨日窗口生效。
6. 使用默认参数，注入 `ctx.now=1704081600000`（北京时间 2024-01-01 12:00），规则返回 `{ action: 'pass' }`。
7. 参数可配：设置 `startHour=1`、`endHour=5`、`timezoneOffset=8`，注入 `ctx.now=1704132000000`（北京时间 02:00）返回 `{ action: 'halt', reason: 'night-silence' }`；注入 `ctx.now=1704146400000`（北京时间 06:00）返回 `{ action: 'pass' }`。
8. 起止相等视为空窗口：设置 `startHour=8`、`endHour=8`、`timezoneOffset=8`，注入 `ctx.now=1704153600000`（北京时间 08:00）返回 `{ action: 'pass' }`；注入 `ctx.now=1704121200000`（北京时间 23:00）也返回 `{ action: 'pass' }`。
9. 时区偏移可配：设置 `startHour=23`、`endHour=8`，注入 `ctx.now=1704124800000`（UTC 2024-01-01 16:00），当 `timezoneOffset=8` 时返回 `{ action: 'halt', reason: 'night-silence' }`，当 `timezoneOffset=0` 时返回 `{ action: 'pass' }`。
10. 规则元数据可离线断言：`stage` 为 `speak`，`order` 为 `33`，`stats` 为 `halt_night_silence`；命中时 reason 必须为小写 kebab-case 的 `night-silence`，未命中时不返回 `halt` reason。
11. 纯函数性：同一 `ctx.now` 与同一参数重复调用，返回值完全一致；规则不修改传入的 `ctx.now`，也不读写任何共享状态。

# 背景与调研来源

深夜主动插话容易打扰群成员休息，因此需要在 speak 链消耗预算、发送消息前增加一道否决规则。需求指定使用北京时间 UTC+8，并要求时段起止小时与时区偏移均可配置，便于后续按群或部署环境调整静默时段。现有 speak 链已注册 30、31、32，因此本规则占用 33，作为独立的静默否决层。
