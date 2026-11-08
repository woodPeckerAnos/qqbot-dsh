# SessionContextView Phase 1 验收（2026-11-08）

分支：feat/session-context-view。生产决策：[ADR-009](adr/009-session-context-view.md)、[ADR-014](adr/014-follow-up-result-reuse.md)、[ADR-016](adr/016-progress-completion-qualification.md)；裁判证据与传输分别见 ADR-010、ADR-015。本文件区分最新验收与历次失败、中断证据。

当前结论：Phase 1 发布前验收通过。完整检查通过 1371 项离线测试与 39 个契约冒烟，C01–C10 严格基线比较 10/10；[最终真实模型报告](benchmarks/session-context-live-v5/strict/report.json) 的校准 14/14，六场景各三次运行与语义均 18/18，零失败、零 inconclusive、关闭资源全部为零。

live 使用真实 DSH、DeepSeek 模型 API、独立裁判和内存 QQ 连接器。真实 QQ 接入与客户端展示没有纳入本轮；独立 localhost WebSocket 的此前 108 项通过记录保留，本轮完整检查中 44 项 WebSocket 用例按离线模式跳过。

## 前轮本地验收（加入固定基线之前）

| 验证                     | 状态           | 证据                                                                  |
| ------------------------ | -------------- | --------------------------------------------------------------------- |
| Session 与裁判相关回归   | 已通过，126 项 | session 单元 53、Actor/scheduler/runner 集成 16、benchmark 57 项      |
| 干净构建 npm run check   | 已通过         | 60 个文件、1299 项离线测试、39 个冒烟；44 项 WebSocket 按离线模式跳过 |
| 独立 localhost WebSocket | 已通过，108 项 | npm run test:integration；3 个测试文件全部通过                        |
| 裁判 v5 / 校准 v2 live   | 尚未运行       | 本轮未调用真实模型 API，需要新的校准与严格回归                        |

WebSocket 首次在沙箱内因 `listen EPERM 127.0.0.1` 无法运行；使用已授权的沙箱外集成检查后全部通过。它与离线 mock、真实 DSH 语义验收分别统计。

完整检查前将 dist 与 packages/contracts/dist 移出项目，再从源码重建。类型、模块边界、契约兼容/覆盖/生成漂移、lint、格式和 Docker 包解析全部通过；[本地检查日志](../tmp/session-context-local-20261108/check.log) 保存在忽略的 tmp 目录。

新增裁判回归验证完整快答与慢 lane 静默时的证据判定：无需推理元数据时通过；要求推理且慢 lane 有事件/token 时通过；仅快 lane 有记录或完全缺失时，即使模拟裁判回答 pass，严格门禁也不通过。校准还验证误判、HTTP 失败和畸形响应不能冒充预期的 inconclusive。

## 此前在线报告：裁判 v4

以下为本轮开始前已存在、此前未完整记入文档的报告；本轮仅核对证据，未重判或覆盖旧结果。

| 报告                                                                                                                | 样本               | 结果                                                                                               |
| ------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| [首次启动](../tmp/session-context-live/report.md)                                                                   | 0                  | 宿主机缺少配置中的 /app/dsh-profile/cordis.patch.yml，未进入业务样本                               |
| [本地配置](../tmp/session-context-live-local/report.md)                                                             | 0                  | 裁判校准未通过，未进入业务样本                                                                     |
| [首次联合运行](../tmp/session-context-live-network/report.md)                                                       | L13/L14/L18 各一次 | 运行 2/3；L13 追问被话题判定切换 generation，未命中 guard；后续由 ADR-009 的已验证关联优先规则修复 |
| [三次严格回归](../tmp/session-context-live-final/report.md) / [JSON](../tmp/session-context-live-final/report.json) | L13/L14/L18 各三次 | 运行 9/9，语义 6 pass、3 inconclusive，严格门禁未通过                                              |

三次严格回归报告生成于 2026-11-08 13:20（Asia/Shanghai），校准 6/6。L13 三次均实际查询原 Task、未创建追问的慢 runtime、没有追问附件或提醒；L14 三次的新短问均独立推进且慢 lane 静默；所有并发前提满足，关闭资源计数全部为零。

未定结论为 L13 第一次与 L14 前两次：裁判要求发送正文的快 lane 有推理元数据，但对应原 Task 的慢 lane 已分别记录 4390、4026、4490 个推理 token。ADR-010 明确快 lane 关闭推理、慢 lane 核对后静默的证据规则，并增加校准。此修正不将旧报告改为通过；当时真实裁判对新规则的遵循待验证，后续 v6 结果见下节。报告在忽略的 tmp 目录，跨机器交接时需另行保留。

## 固定任务衔接基线

[ADR-011](adr/011-session-context-benchmark-baseline.md) 将三个主要修复目标固化为 C01–C10，加入默认离线 benchmark 和 npm test。版本库中的 [JSON 基线](benchmarks/session-context-v1/report.json) / [Markdown 证据](benchmarks/session-context-v1/report.md) 记录 10 个场景、21 个 Task、122 条运行断言通过，108 项必需断言无缺失，关闭资源全部为零。

固定 seed=42 的[严格基线比较](../tmp/session-context-baseline-comparison/report.md)全部通过，输入、版本与必需断言清单一致。新增反向测试覆盖关键断言缺失/失败/未定，以及更换输入、seed、repetition、版本或删减断言清单时拒绝比较。完整 `npm run check` 通过：61 个文件、1332 项离线测试、39 个契约冒烟；类型、边界、兼容、覆盖、生成漂移、lint、格式和 Docker 包解析通过，44 项独立 WebSocket 用例按离线模式跳过。

裁判升级为 v6 / 校准 v3，保留前九项并补入四种虚假送达声明和一个正确区分状态的样本。新增基线和校准先使用离线注入验证，后续真实模型结果单列如下。

## 裁判 v6 与真实任务衔接：已有报告

| 报告                                                                                                                                                                | 样本  | 结果                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------- |
| [L13/L14/L18 单次联合](benchmarks/session-context-live-v1/initial/report.md) / [JSON](benchmarks/session-context-live-v1/initial/report.json)                       | 3/3   | 校准 14/14，运行 3/3、语义 3 pass，关闭资源全部为零                                                     |
| [LC01–LC03 v1 单次](benchmarks/session-context-live-v1/context-once-failed/report.md) / [JSON](benchmarks/session-context-live-v1/context-once-failed/report.json)  | 3/3   | 校准通过；LC01 全部通过，LC02/LC03 语义通过但原慢 lane 分别调用三次、两次 bash，运行门禁失败            |
| [六场景三次回归：中断](benchmarks/session-context-live-v1/strict-interrupted/report.md) / [JSON](benchmarks/session-context-live-v1/strict-interrupted/report.json) | 10/18 | 校准通过；10 项运行通过，语义 2 pass、8 inconclusive（请求失败或超时）；余下 8 项未运行，发布门禁未通过 |

以上报告来自前轮执行，保留原始判定；本轮将此前仅在 tmp 中的失败和中断证据归档到版本库。历史裁判请求错误未区分 HTTP、网络或超时，无法仅凭旧报告认定根因。

[ADR-013](adr/013-live-benchmark-evidence-diagnostics.md) 将 LC01–LC03 升级至 v2，明确单次命令并核对实际成功工具输出的 UUID，不放宽额外调用断言；请求诊断细分错误而不保存敏感底层信息。相关离线回归最初通过 88 项及类型检查，之后补入校准逐项保存；新版真实模型结果见下节。

## 本轮 v2 验收

| 验证                               | 结果                 | 证据                                                                                                                                                                                             |
| ---------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 完整 `npm run check`               | 通过                 | 62 个文件、1343 项离线测试、39 个契约冒烟；类型、边界、兼容、覆盖、生成漂移、lint、格式和 Docker 包解析全部通过                                                                                  |
| C01–C10 固定基线严格比较           | 通过，10/10          | [比较报告](../tmp/session-context-evidence-v2-comparison/report.md)；输入、seed、版本及必需断言清单一致，关闭资源全部为零                                                                        |
| L13/L14/L18、LC01–LC03 v2 单次联合 | 通过，6/6            | [Markdown](benchmarks/session-context-live-v2/once/report.md) / [JSON](benchmarks/session-context-live-v2/once/report.json)；校准 14/14，运行及语义全部通过，0 项 inconclusive，关闭资源全部为零 |
| 六场景各三次严格回归               | 未通过，18/18 已运行 | [Markdown](benchmarks/session-context-live-v2/strict-failed/report.md) / [JSON](benchmarks/session-context-live-v2/strict-failed/report.json)；LC01 第一次漏答，LC02 三次裁判超时，原判定保留    |

LC01 的实际工具输出 UUID 与原慢正文一致，B 实际派发的 View 包含该结果，B 沿用同一编号且没有业务工具或附件。LC02/LC03 的 B 实际查询原 completed Task，慢 runtime 为零，原正文分别保持 pending/failed；回答未声称未经核对的送达，失败正文在唤醒后没有重试。

逐项校准保存的新增回归验证中断后保留已写出的证据，部分校准不得通过门禁，观察回调不能改写判定。以上完整检查包含此回归。独立 WebSocket 在本轮按离线模式跳过 44 项；之前单列的 108 项 localhost 检查仍是原验证记录，本轮未重复运行。

## ADR-014 回归与后续修正

[ADR-014](adr/014-follow-up-result-reuse.md) 修复跨 Task 已送达结果导致当前复述漏答的问题，统一 runner、协作插件、默认 profile 与 View 说明；纯进度慢 lane 仍不创建 runtime。新增反向回归保证裁判 pass 不能覆盖当前复述缺失。RunRecord 保留完整查询结果，裁判仅接收 Task 身份、状态、lane 正文和时间；receipt 来源不采集 trace 标识。

修复后的完整 `npm run check` 通过：62 个文件、1344 项离线测试、39 个契约冒烟，44 项 WebSocket 按离线模式跳过。生成契约更新后再次通过兼容、边界、覆盖和漂移检查。C01–C10 的[新一轮严格基线比较](../tmp/session-context-reuse-comparison/report.md) 10/10 通过，关闭资源全部为零。

| ADR-014 真实模型验证 | 状态                   | 证据                                                                                                                                                                                                              |
| -------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 六场景单次联合       | 严格门禁通过，运行 6/6 | [Markdown](benchmarks/session-context-live-v3/once/report.md) / [JSON](benchmarks/session-context-live-v3/once/report.json)；校准 14/14，语义 5 pass、1 fail/minor，0 inconclusive，关闭资源全部为零              |
| 六场景各三次回归     | 未通过，18/18 已运行   | [Markdown](benchmarks/session-context-live-v3/strict-failed/report.md) / [JSON](benchmarks/session-context-live-v3/strict-failed/report.json)；运行 18/18，语义 15 pass、2 fail、1 inconclusive，关闭资源全部为零 |

单次 LC01 实际复述原工具编号且没有重新执行业务工具；LC02 裁判在 119 秒内完成并通过。LC03 原正文被注入发送失败，裁判将原任务未交付完整编号记为 handoff=fail/minor，trust=pass；B 如实说明查询没有 delivery，未宣称已送达。该轻微判定保留，既有严格规则允许 minor，但必需断言失败、严重错误及必要评测 inconclusive 仍阻断。

上述非流式三重复轮次已完整结束。L13 第二次裁判网络错误，旧错误未保留底层代码，不能据此确定根因。LC02/LC03 第三次在原正文分别 pending/failed 时，回复未明确限定完成范围，均被判为 trust=fail/severe；LC03 另有 handoff=fail/minor。运行断言通过不能覆盖严重语义失败，原判定已完整归档。

[ADR-015](adr/015-judge-stream-transport.md) 增加可选 SSE 传输、独立连接与网络代码白名单，不重试请求、不改变评分和门禁。

流式实现的完整 `npm run check` 已通过：62 个文件、1371 项离线测试、39 个契约冒烟；类型、边界、兼容、覆盖、生成漂移、lint、格式和 Docker 包解析全部通过，44 项 WebSocket 按离线模式跳过。实际记录见忽略目录中的[检查日志](../tmp/session-context-stream-check.log)。

[ADR-016](adr/016-progress-completion-qualification.md) 收紧关联进度提示：completed 仅表示执行完成，查询缺 delivery 时明确说“任务执行已完成，结果送达情况尚未核实”，不使用“已全部完成”或推断发送状态。修复后的完整 `npm run check` 同样通过 1371 项离线测试与 39 个契约冒烟；[检查日志](../tmp/session-context-qualified-check.log) 和 [C01–C10 严格基线比较](../tmp/session-context-qualified-comparison/report.md) 已保存，比较 10/10 通过，资源全部为零。

| 后续真实模型轮次                     | 状态                 | 证据与范围                                                                                                                                                                                                                   |
| ------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-015 流式传输、ADR-016 前生产提示 | 未通过，18/18 已运行 | [Markdown](benchmarks/session-context-live-v4/strict-failed/report.md) / [JSON](benchmarks/session-context-live-v4/strict-failed/report.json)；校准 14/14，运行 18/18，语义 16 pass、2 fail/severe、0 inconclusive，资源为零 |
| ADR-016 收紧提示后的流式严格回归     | 严格门禁通过，18/18  | [Markdown](benchmarks/session-context-live-v5/strict/report.md) / [JSON](benchmarks/session-context-live-v5/strict/report.json)；校准 14/14，运行与语义 18/18，零失败、零 inconclusive、资源为零                             |

最终真实模型轮次使用 `stream: true`、300 秒请求时限，评分 v6、校准 v3 保持不变；裁判配置与实际 profile 指纹随报告保存。[源码指纹](benchmarks/session-context-live-v5/strict/run-source.json) 与本轮最终 runner、View、profile、插件和裁判源码一致。各轮目录隔离，报告归档前通过凭证扫描；原失败和 minor 判定保留，不重判、不拼接样本。

最终 LC01 三次均核对实际成功 bash 工具输出、原正文和 B 复述中的同一 receipt，B 不重新执行旧业务或生成附件。LC02/LC03 各三次实际查询原 completed Task，慢 runtime 为零，原正文分别 pending/failed；B 明确表述执行完成与送达未核实，未声称已送达，失败正文没有重试。L13/L14/L18 各三次的查询、短问、补充条件归属断言全部通过。

完整校准与三重复回归命令如下；复验时使用新目录，严重失败、必需断言失败或必要 inconclusive 仍阻止通过：

```sh
npm run bench:session:live -- --cases L13,L14,L18,真实任务衔接 --repeat 3 --strict --output tmp/session-context-qualified-strict
```

运行前按 [benchmark 配置](SESSION-BENCHMARK.md#运行与配置) 提供本机可执行的 DSH、可读 profile、模型凭证和 BENCH_JUDGE_CONFIG。Phase 1 本轮发布前门禁已完成，不代表真实 QQ 部署或客户端验收。

回滚：sessionContext.mode: off 关闭 View、追问关联与纯进度 guard，重启生效，无数据迁移。query_tasks delivery、常驻 runtime、事件日志与压缩插件保留后续阶段。
