# 主动介入模块契约

先读 [SCENES.md](interests/SCENES.md)、[README.md](README.md) 和 [全局模块契约](../../../docs/MODULE-CONTRACTS.md)。旧架构过程文档保留历史推导；生产执行与出口由 ADR-001 定义。

## 职责与接口

模块只决定是否创建主动 Task。`scene/watcher.ts` 是唯一判定调度入口，接收 `observe`、`observeAddressed`，通过注入的 `submitTask(request): Promise<boolean>` 提交。场景搜集、模型判定、纯函数否决保持三层边界。`contract.ts` 定义 SceneId、SCENE_ORDER、触发面、判据结果、wait 目标和裁决；优先级只有 SCENE_ORDER 一处来源。

`ProactiveTaskRequest` 保存 `input`（target、scene、directive、reason、evidence）、原消息或触发摘录 `reference`、不可漂移的预算 `scope`，以及实际成功后的 `onSpoke`。提交通过返回 true 表示 Task 已准入，执行完成由 TaskHandle.done 表示，送达由 DeliveryResult 表示。

`ProactiveTaskAdapter.submit` 冻结触发依据并调用 SessionActor；`delivered` 保存首次成功产物，`settled` 在预算提交时调用 scope.commit/onSpoke，在释放时调用 scope.release。适配器不接受模型提供的角色或 Session 身份。

## 状态所有权

| 状态                                            | 唯一所有者                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| 原始观察窗口                                    | `ObservationWindowStore`，由 main 注入；不受 proactive.enabled 控制 |
| 挂起问题、wait 票据、话题 session、无人回应计数 | `ConversationState` / `ProactiveWatcher`                            |
| Task、两个 lane 与取消状态                      | `TaskLifeCycleManager`                                              |
| 业务预算预留/提交/释放                          | `TaskBudget`；session.budgetLeft 仅为触发时范围的剩余额度投影       |
| 产物去重与一次性提醒                            | `SessionOutputCoordinator`                                          |
| 消息投递与 QQ 序号/条数                         | `MessageQueue`                                                      |

每个主动 Task 预留一个单位。第一次任意产物成功送达只提交一次；正文、附件、提醒、错误与发送失败通知不重复扣费。全静默、取消后无可交付产物、全部消息终结且均未成功时释放。取消后仍有入队产物则等待队列结算。旧 Task 的结果只能结算触发时 scope，不能引用当前新话题的预算。

## 事件顺序与语义边界

1. 窗口记录消息；本地 collect 预筛在占用判定标记之前执行。
2. 有候选才调用 judge，逐候选产生多标签判据；候选之外的场景不得凭空成立。
3. veto 按固定顺序、硬限流、话题 session 闸门和 wait 目标裁决，不读原文、不调用模型。
4. speak 时保存依据、引用和预算范围，预留后原子创建同时进入快慢队列的 Task；准入失败释放预留。
5. 两个 lane 独立串行执行，慢 lane 判断长技能，结束钩子等待同 Task 快执行及原始正文投递终态后按实际送达内容衔接。无增量正常 NO_REPLY（含成功工具执行后），有增量仅交付新增部分，结论反转明确纠正；失败、空结果和需要说明的附件必须反馈。等待计入慢时限，保持 running 并可被 /stop 取消。
6. 产物进入持久队列，第一次成功送达提交预算并记录实际发言。Task 执行终态与投递结果分开。

结果发送前不做“过时”判定。话题后来翻篇、问题已答、bot 已经插过话，不撤销触发时已授权 Task。判定前的 wait 存活检查保留：尚未创建 Task 的无效票据应及时作废，避免多余模型调用。

慢、延迟和主动结果引用原输入。缺少直接消息 ID 时保存触发窗口摘录。QQ 当前合法发送锚点与原引用必须独立；不要把新输入 msg_id 写成旧结果的 message_reference。回复及引用一起记录到对话与观察窗口。

## 错误、取消与释放

judge 失败按本次沉默降级，记录调用失败，持续失败按现有机制暂停判定；这不涉及已经创建的 Task。Task 准入失败返回 false 并计 task-rejected；不创建只进入一个 lane 的半个 Task。

自然语言取消通过输入绑定的 Task 管理工具：普通成员只能取消本人旧 Task，管理员可取消本 Session 其他成员旧 Task，创建序号确定“旧”。`/stop` 取消命令到达时正在执行的 Task 并保留排队 Task；`/new` 取消全部未完成 Task 并推进上下文 generation。取消不撤销已入队消息。

队列尚未尝试的消息等待有效平台出口；一次发送失败或超时后终态失败，不借后续输入重发。失败通知只尝试一次、不递归。存活提醒必须快回复已送达且慢 lane 正在执行，满足两条件后至少 5 分钟、最多一次；无即时出口就放弃。

watcher.stop 释放所有判定定时器和票据；TaskSystem.close 取消未完成执行、关闭具体 runtime 租约并释放输出监听器。终态 Task 到期清理工作区，队列独立文件副本继续保留。重启不重跑执行，未完成 Task 形成一次中断结果，已尝试消息不重发。

## 扩展与验收

改场景先更新 SCENES.md 的自然语言与示例，再更新 collect / judge / veto 及契约测试。场景顺序或集合改动同步 SCENE_ORDER、判据渲染、解析、trace。调整 wait 策略须保持 created = resolved + spent + stale + unchanged；预算耗尽只限制新 Task，不驱动话题关闭。

新增平台接入实现 BotConnector 的单次 reply、原引用及出口可用性；平台额度如实报告，业务预算由 TaskBudget 管理。生产消息不得从 watcher 直接发送。ProactiveSpeaker/compose 旧接缝只用于 dryRun 和历史回归，不作为新功能入口。

验证运行 `npm run typecheck`、`npm test`、`npm run test:integration`、`npm run build`。重点用例：旧主动结果在翻篇后仍送原引用、多产物只提交一次、全静默释放、取消后入队结果继续结算、平台失败不重发、实际执行失败不静默、跨 Session/成员取消拒绝。默认验收注入统一 OneBot 传输、模拟 DSH 和时钟，不需要真实端口或已部署客户端。
