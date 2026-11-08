# ADR-015：裁判流式传输与网络错误分类

状态：接受；日期：2026-11-08。

## 问题与证据

ADR-014 的单次门禁通过，随后三次严格回归中 L13 第二次运行断言通过，但裁判请求约 64 秒后发生 judge-network-error。该未定结论阻断发布。旧错误未保留底层代码，不能据此确认连接复用或代理空闲超时是根因；原样本不重判、不重试。

## benchmark 内部契约

JudgeConfig 增加可选 stream:boolean，默认 false 保持原 JSON 响应协议。stream=true 使用标准 chat/completions SSE，并以 Connection: close 隔离请求连接。仍要求 response_format=json_object，评分 v6、校准 v3 和原句校验不变；不增加自动重试。

仅收集 delta.content 作为待解析判定，忽略 reasoning_content，原始 SSE 帧、思考正文及异常文本不保存。支持跨字节和 CRLF 帧边界；可见正文及单帧缓冲有上限。必须收到 finish_reason=stop 及 [DONE] 才接受响应；畸形帧、非 SSE、缺少结束标记、截断或超时均为 inconclusive，不修补或猜测 JSON。取消与结束后释放 reader、监听器和定时器。

网络异常只记录预定义系统代码（如 ECONNRESET、UND_ERR_SOCKET），未知代码仍为 judge-network-error；不保存底层 message、URL、凭证或原始响应。新的 live 配置为 stream=true、300 秒请求时限，并随报告保存；原失败轮完整保留。

## 验证

注入 HTTP 流验证 UTF-8/CRLF 分片、校准标签、忽略思考正文、缺结束标记、畸形帧、非 SSE、超时释放和网络错误隐私。完整检查通过后，对新传输执行真实校准和完整六场景各三次严格回归；传输变化不拼接旧样本，不改变失败门禁。生产 Task、Session、投递与配置接口不变。

离线实现完成后的 `npm run check` 已通过：62 个文件、1371 项离线测试、39 个契约冒烟；44 项 WebSocket 按离线模式跳过。新增传输回归还验证累计正文超限、错误 UTF-8、非 SSE 正文取消、读流网络失败及超时后 reader/监听器释放。真实模型三重复回归使用独立目录 `tmp/session-context-stream-strict`，实际结果记入 [Phase 1 验收](../SESSION-CONTEXT-ACCEPTANCE.md)，完成前不标记发布通过。

该流式轮次已完成：校准 14/14、运行 18/18，语义 16 pass、2 fail/severe、0 inconclusive，关闭资源全部为零。没有传输请求错误，但旧生产进度提示的 LC02 第一次、第三次因完成范围未限定，被判 trust=fail/severe，严格门禁未通过。旧提示轮次不代表 [ADR-016](016-progress-completion-qualification.md) 修复后的行为；修复后的独立完整回归继续使用相同 SSE 传输。摘要见 [SessionContextView 证据摘要](../SESSION-CONTEXT-EVIDENCE.md)，原始报告按需重新生成。

ADR-016 修复后的独立完整回归已通过：真实校准 14/14、六场景各三次运行与语义 18/18，零失败、零 inconclusive、零关闭资源。该轮使用本 ADR 的 SSE 传输与 300 秒时限；无个别重试或旧样本合并，传输与生产修复的联合发布前门禁完成。摘要与源码指纹见 [SessionContextView 证据摘要](../SESSION-CONTEXT-EVIDENCE.md)。
