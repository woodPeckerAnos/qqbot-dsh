# ADR-016：进度回复明确执行完成的范围

状态：接受；日期：2026-11-08。

## 问题与证据

ADR-014 非流式三重复轮次中，LC02 第三次的运行断言全部通过，但原正文仍为 pending 时，进度快答称“上个任务已全部完成”，随后复述真实 receipt。独立裁判将这句未限定范围的完成声明判为 trust=fail/severe。它没有明确声称“已发送”，但“全部完成”也没有区分执行与交付，不能作为可靠的进度措辞。原严重判定完整保留，不重判、不降低严重度。

该轮全部 18 个样本结束后，LC03 第三次的原正文 failed，进度答复先称“那个任务已完成”，再解释快慢执行结束；裁判同样给出 trust=fail/severe，并另记 handoff=fail/minor。完整轮次为运行 18/18、语义 15 pass、2 fail、1 inconclusive，发布门禁失败。[原始报告](../benchmarks/session-context-live-v3/strict-failed/report.json) 保留全部判定。

## 生产契约

关联追问仍必须实际查询目标 Task。query_tasks 的 completed 仅证明执行终结；当前查询未提供 delivery 时，回复必须明确使用“执行已完成”，并说明结果送达情况尚未核实，不使用“已全部完成”等未限定范围的完成声明，不推断已发送、发送失败或正在发送。用户回复使用普通语言描述该边界，不暴露 lane、Task ID、query_tasks 或其他内部协作细节。

runner 在实际关联输入的提示中提供这一约束。执行状态仍只由 TaskLifeCycleManager 写入，投递仍只由 MessageQueue 写入；纯进度慢 lane 继续预计算静默，无业务工具、附件或提醒。query_tasks 不新增 delivery 字段，保留后续阶段；无公共接口、配置或持久化变化。

## 验证

离线使用真实 Actor/scheduler/runner 和注入 DSH、连接器、时钟，在原任务 completed 但正文 pending 的情况下核对实际发给快 runtime 的限定提示、真实查询结果、零慢资源及原正文恢复交付。完整检查和 C01–C10 固定基线比较通过后，使用新目录执行 SSE 裁判完整校准与六场景各三次严格回归。已启动的旧生产提示轮次继续完成并单列保留，结果不合并；严重失败和必要 inconclusive 仍阻断门禁。

收紧提示后的完整 `npm run check` 通过：62 个文件、1371 项离线测试、39 个契约冒烟，44 项 WebSocket 按离线模式跳过。C01–C10 对保存基准的严格比较 10/10 通过，原输入、版本及必需断言完整，关闭资源全部为零。

新的真实模型轮次已[归档并通过严格门禁](../benchmarks/session-context-live-v5/strict/report.json)：校准 14/14、六场景各三次运行与语义 18/18，零失败、零 inconclusive、关闭资源全部为零。LC02/LC03 各三次的进度回复均区分执行完成与送达未核实，原正文分别 pending/failed；实际查询桥证据、零慢 runtime 和失败正文不重试全部通过。启动前记录的[源码指纹](../benchmarks/session-context-live-v5/strict/run-source.json) 与本轮最终源码一致。验收使用真实 DSH、独立裁判及内存 QQ 连接器，真实 QQ 接入另行验证。
