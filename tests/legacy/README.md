# 历史运行路径测试夹具

这里保存重构前的 TurnRunner、AdmissionGate、ReplyLedger、周期进度和后台投递协调，仅用于已有回归用例。生产代码不得导入此目录。旧编排测试验证通用解析、转发和文件能力在迁移中没有退化；双 lane、Task 状态与新出口的验收以 `tests/task-system.test.ts` 为准。

`runtime-entry.ts` 保存历史可写 runtime 条目形状。生产 RuntimePool 只返回只读身份租约；此夹具不得进入生产边界。历史统计夹具通过记录接口保持测试行为。
