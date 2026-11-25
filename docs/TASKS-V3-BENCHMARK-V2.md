# 前台/worker V3 benchmark v2

执行与交付规则以 [ADR-020](adr/020-test-environment-boundaries.md) 和生成的 [模块契约](MODULE-CONTRACTS.md) 为准。本文只定义测试入口及证据格式；旧 `docs/benchmarks/tasks-v3-v1` 保存历史实现结果。

```sh
npm run bench:tasks-v3
npm run bench:tasks-v3 -- --cases F10,F12,F15,F16 --output tmp/benchmarks/v3-selected
npm run bench:tasks-v3:live -- --output tmp/benchmarks/v3-live-prepared
```

离线默认运行 F01–F19。单一 registry 为每组声明必需检查和生产覆盖，报告写 `report.json`、`report.md`。F10–F19 在隔离的 Vitest 子进程中执行真实测试，保存原始断言结果、源文件 SHA-256 和实际采集的数值；不能用导入测试名、文件存在或成功退出替代必需用例执行。各组的未选中测试可跳过，registry 声明的必需用例必须实际通过。`--cases` 只声明选定组完成，报告 `fullCoverage=false`。

| 场景    | 验证范围                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------- |
| F01–F09 | 普通请求、worker交错、有限整理、容量、公平、取消、排队及独立附件副本；runner注入，F09额外运行真实OneBot适配器及ZIP字节检查 |
| F10     | 30份大中文及转义快照、紧凑查询和正文分段/版本；真实manager和bridge通过实际fd3子进程收发，错误大响应仍须拒绝                |
| F11–F12 | 前台五次调用及最终无工具、90秒硬截止、已保存回执丢失；失败后闲聊、明确重试及恶意进度派发                                   |
| F13–F15 | 问题台账与滚动窗口引用、作者区分、完整正文格式转换和历史、正文文件意图、图片/ZIP路由与规范路径副本                         |
| F16–F17 | 搜索月额度和普通429/工具错误、首次错误缓存及并发排队；worker共用40次业务调用加一次根收尾、时间预算、取消和部分材料         |
| F18–F19 | 主动判定请求字段/取消/解析、顶层命令、终态错误字段及日志隐私                                                               |

每组分别记录 `realTaskSystem/runner/channel/plugin/adapter`，只运行独立适配器测试的组不会声称整个TaskSystem已覆盖。`metrics.measured` 由实际测试调用记录器生成，可含UTF-8响应字节、HTTP次数、worker次数、文件哈希和关闭资源。未采集项明确保留缺失，不能依据测试名称填写数字。错误大投影、伪造重试、错误交付和虚假额度分类必须经对应生产判断失败，反向用例参与同一必需断言清单。

脚本启动即把目标报告标为未完成，结束时复核版本、完成状态和成功状态。未知场景、缺少场景、重复结果、必需检查缺失/跳过/失败、运行中断均返回非零。API请求数0仅用于离线模型调用；注入HTTP和真实本地子进程的活动另行记录。

Live入口默认只准备并记录 `status=unrun`、模型与裁判请求0、语义 `unknown`。费用授权后运行：

```sh
BENCH_JUDGE_CONFIG=/absolute/path/judge.json npm run bench:tasks-v3:live -- --run --cases L01,L02,L03 --repeat 3 --output tmp/benchmarks/v3-live-authorized
```

模型读取当前生产配置及环境凭证；独立裁判配置沿用 [配置例](../tests/bench/session/judge.example.json)，裁判模型须与任务模型不同。L01验证实际搜索失败后的闲聊及明确重试，L02验证模型实际调用任务查询且不重做，L03验证聊天正文和明确正文文件请求。只替换QQ传输和搜索HTTP：模型prompt、tool选择、DSH执行、Task保存和交付均使用现行生产路径。报告保存实际prompt/控制调用、收到的回复、工具/搜索次数、文件哈希、独立裁判结论和关闭资源。失败、缺证据及裁判inconclusive均阻止通过。

本轮没有运行付费模型。真实WebSocket与QQ客户端展示仍分别验证；离线字节检查不能代替客户端图片解码或显示检查。

2026-11-25 离线完整运行通过 F01–F19，共173项实际检查和98个固定必需检查，报告位于 `tmp/benchmarks/tasks-v3-v2/`。30份大任务快照合计44,016,003字节，实际紧凑fd3响应为48,943字节，分段正文响应30,179字节；stale与错误大响应分别回传80/129字节失败结果。搜索额度缓存实际只发一次HTTP，普通429后续实际发第二次HTTP；worker超大回执实际回传127字节错误，关闭取消已在真实子进程通道验证。故意送出的错误ZIP和正确ZIP经同一完整性检查分别判false/true，校准复用F09实际交付检查。未知场景F99命令退出1；live准备命令没有调用模型。
