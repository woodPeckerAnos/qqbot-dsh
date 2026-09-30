---
rule: group-whitelist
stage: intake
order: 2
params:
  - name: groups
    default: ""
    meaning: 静态白名单（BOT_LISTEN_GROUPS 全局注入，逗号分隔；条目可以是会话键 ob11:g123 或 平台:群号 两种形式）
stats: halt_group_whitelist
---

# 原始需求

（首批手写规则，模板定稿件，无生成口输入。）

# 需求描述

旁听是把「群里所有话」引入系统边界的行为，必须显式授权：只有白名单内的群
（env 的 `BOT_LISTEN_GROUPS`，或管理员在本群 `/listen on` 热开启）才会被旁听。
白名单之外的群，消息连旁听缓冲都不进。群号属于个人标识，所以静态白名单只来自
env，不写进随仓库提交的配置文件。

# 判定

- 输入：一条 observed 消息
- 条件 A：`state.runtimeEnabled === true`（本群被 /listen on 热开启）→ pass
- 条件 B：`ctx.message` 为空（定时器触发等无消息场景）→ `halt('no-message')`
  （fail-closed：无法判定归属就不放行）
- 条件 C：`params.groups`（逗号分隔）包含 `target.key`（如 `ob11:g123`）
  或 `<platform>:<id>`（如 `onebot:123`）→ pass
- 否则 → `halt('not-whitelisted')`

# 参数

| 名字 | 默认值 | 含义 |
|---|---|---|
| `groups` | "" | 静态白名单，逗号分隔；两种条目形式都接受（会话键 / 平台:群号） |

# 验收标准

1. 白名单含会话键形式（`ob11:g123`）且消息来自该群 → pass；
2. 白名单含 `平台:群号` 形式（`onebot:123`）且消息来自该群 → pass；
3. 群不在白名单且未热开启 → halt('not-whitelisted')；
4. 群不在白名单但被 /listen on（runtimeEnabled=true）→ pass；
5. 无消息上下文（ctx.message 为空）→ halt('no-message')。

# 背景与调研来源

生态共识：bl-chat-plugin 的 `enableGroupWhitelist` + `allowedGroups`。
本仓库的「个人标识只进 .env」纪律见 config.ts 的 BOT_ADMINS 注释与
config-file.ts 的 REJECTED_KEYS。
