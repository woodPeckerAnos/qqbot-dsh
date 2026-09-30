---
rule: master-switch
stage: intake
order: 1
params:
  - name: enabled
    default: true
    meaning: 总开关生效值（intervention.enabled 全局注入，优先级最高，不可被文件覆盖回 true）
stats: halt_master_switch
---

# 原始需求

（首批手写规则，模板定稿件，无生成口输入。）

# 需求描述

话题介入必须是可一键全关的。当全局总开关（`intervention.enabled`）关闭时，
任何群消息都不进入旁听缓冲与后续判定；管理员在本群用 `/listen off` 关闭后，
本群同样完全不听。开关重新打开后，消息立即恢复进入旁听缓冲。

# 判定

- 输入：一条 observed 消息（或任何触发）
- 条件 A：`params.enabled === false` → `halt('master-disabled')`
- 条件 B：`state.runtimeEnabled === false`（本群被 /listen off）→ `halt('group-disabled')`
- 否则 → pass

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `enabled` | true | 总开关生效值；由 `intervention.enabled`（env/file）全局注入，注入值优先级最高 |

# 验收标准

1. 总开关关闭（enabled=false）→ halt('master-disabled')，消息不进入后续层；
2. 总开关开、本群被 /listen off（runtimeEnabled=false）→ halt('group-disabled')；
3. 总开关开、本群运行期开关未设置（runtimeEnabled=undefined）→ pass；
4. 总开关开、本群被 /listen on（runtimeEnabled=true）→ pass。

# 背景与调研来源

生态共识：白名单 + 默认关 + 可热切换（bl-chat-plugin 的群白名单、
astrbot_plugin_proactive_chat 的 enable 开关）。本 bot 的纪律是 fail-closed：
见 docs/TOPIC-INTERVENTION-PLAN.md §13。
