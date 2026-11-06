# SessionActor 应答链路 benchmark

决策见 [ADR-005](adr/005-session-response-benchmark.md)。这里描述 benchmark 内部契约与目标验收；生产现状仍以 [架构](ARCHITECTURE.md) 和生成的 [模块契约](MODULE-CONTRACTS.md) 为准。

## 运行与配置

`npm run bench:session` 运行全部离线场景和固定种子混合负载；`npm test` 同样执行离线验收。`npm run bench:session:live` 显式调用真实 DSH 与独立语义裁判。独立 Vitest 配置只匹配 `session.bench.ts`，在线入口不匹配 `*.test.ts`。

公共选项：`--cases ID,ID`（也支持分组名）、`--repeat N`、`--seed N`、`--baseline report.json`、`--strict`、`--output DIR`；在线另支持 `--full`。离线默认各一次；在线轻量集 L01–L09、L11、L14、L15 各三次；完整集 L01–L24 各五次。所有样本计入，不取最佳、不自动重跑。

在线沿用 `QQ_CONFIG_FILE` 对应生产配置入口、模型路由与 profile，凭证由调用进程环境提供；临时路径隔离状态、工作区与 DSH_HOME。裁判使用 `BENCH_JUDGE_CONFIG` 指向 JSON，格式见 `tests/bench/session/judge.example.json`。端点为完整 chat/completions URL，独立指定 model、apiKeyEnv、timeoutMs。缺模型凭证、裁判配置或校准失败都明确失败。

QQ 收发使用内存连接器，配置装载时只覆盖接入平台与 OneBot token 占位，不需要真实 QQ 凭证。DSH 的 bin/profile、快慢模型路由、模型 patch 与思考设置沿用实际配置；调用前检查 bin 可执行和 profile 可读。

默认报告写入 `tmp/session-benchmark`。JSON 保存场景版本、输入步骤、Task/lane 状态、平台尝试和实际送达顺序、分段、附件哈希和可读文本、引用、提醒、断言、裁判原句证据、配置指纹及版本。Markdown 汇总失败、已知问题、通过率、耗时 p50/p95、排队、吞吐和释放。报告只保存选择过的模型配置元数据与哈希，不保存环境、凭证、原始协议帧或思考正文。

`queueAndPreparationMs` 从准入计到模型执行开始，包含排队、媒体准备和初始化；目前不把三者拆成独立耗时。首回复和末条送达取实际收到序列的时间，附件保留独立尝试和送达顺序。离线场景使用模拟时钟，吞吐和 durationMs 使用实际运行时间；裁判耗时单列 judgingMs，不计入执行吞吐。

## 内部记录契约

`BenchmarkCase` 固定 id/version/group、输入步骤、运行函数和语义期望。`RunRecord` 保存 seed/repetition、输入、Task/平台证据、运行断言、JudgeVerdict、时间与资源。`AssertionResult` 的 pass/fail/inconclusive 与 runtime/semantic 分类分别门禁。`JudgeVerdict` 对重复、矛盾、承接和可信度给出 pass/fail/inconclusive、严重度、理由与可在实际回复中逐字核对的引用；失败无引用、输出畸形和缺必要交付均不能通过。

深度推理要求 slow lane 有可观测 reasoning 事件或正数 reasoningTokens。只记录是否出现与计数；缺失标 inconclusive，答案长度与工具调用不能替代。

## 场景与标准

离线 O01–O24 按三项一组覆盖：应答出口；静默与失败；调度与容量；时序与超时；控制与身份；上下文与媒体；投递；持久化与回收。关键完成/超时/取消、父子结束顺序交换运行。M01–M03 分别为单会话积压、多会话满容量、长短任务分批交错，检查容量、FIFO、公平推进、双 lane、预算和关闭释放。

O02 近似重复和 O03 终局否认冲突必须经过真实出口送达并记录语义失败。这两项离线标注只验证已知反例的保留与报告，不能证明真实模型目标已达成。在线每个样本都由独立裁判评测实际收到的回复。

在线固定 24 场景：L01–L06 长证明、约束求解、代码生成、本地文件读取、CSV 计算、资料综合；L07–L12 基础事实、简单算术、寒暄、信息不足澄清、深度推理、简短结论长任务；L13–L18 进度、执行中新短问题、换话题旧结果、同群不同成员、跨群同问题、追加条件上下文归属；L19–L24 文件产物、资料不足、图片降级、引用/转发、工具失败、前台子代理完成后交付。

裁判校准包含两类坏样本、正常承接、增量补充、有解释的结论修正及虚假交付；校准必须全部匹配。运行约束失败默认非零；语义失败默认完整记录。严格模式任一严重失败或必要评测 inconclusive 非零，已知问题不豁免。耗时与资源数值先记录；无任意性能阈值。

## 验收记录

具体执行结果见生成报告，在线未实际运行不得标为通过。原有核心测试保留，完成 typecheck、contracts:check、lint、format:check、完整离线测试及契约冒烟。真实 WebSocket 用 `npm run test:integration` 单列。

2026-11-06：`npm run check` 通过，54 个测试文件、1082 项通过，40 项独立 WebSocket 用例按离线模式跳过，36 个契约冒烟通过。原有 Task 核心 70 项保留，新增 benchmark 验收 44 项。离线 [基线 JSON](../tmp/session-baseline/report.json) / [Markdown](../tmp/session-baseline/report.md) 含 27 个样本、354 个 Task，运行断言全部通过，O02/O03 如实记录严重语义失败，关闭资源计数均为零。带基线比较的 [严格模式报告](../tmp/session-strict/report.md) 对两项已知问题返回非零。

显式 live 单样本命令因缺少 `BENCH_JUDGE_CONFIG` 在调用前失败，[失败报告](../tmp/session-live/report.md) 保存了原因；本次没有完成真实模型或真实裁判语义评测，不宣称线上问题已解决。报告位于忽略的 tmp 目录，可用 `--output` 保存到指定位置。
