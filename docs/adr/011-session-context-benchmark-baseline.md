# ADR-011：任务衔接的三项固定 benchmark 基线

状态：接受；日期：2026-11-08。

## 决策

将 ADR-009 解决的三个问题固定为默认离线 benchmark 的“任务衔接基线”组：纯进度追问不得重复启动旧工作；普通慢 lane 派发时必须取得排队及初始化期间更新的旧结果；执行完成与投递完成必须分别表达。

固定 C01–C10、场景版本 v1。使用现有 Harness 的真实 Actor、scheduler、runner、消息队列及注入 DSH、连接器、时钟和持久化故障，不手写执行或投递终态。时钟从固定时刻起步。连续追问必须实际经过查询桥；View 证据从实际慢 runtime 收到的独立 prompt 块读取，不另造一份正确快照替代生产注入。输入携带补充工作时仍正常执行双 lane。

投递覆盖 pending、sending、部分 failed、unknown 和原始正文记录缺失，并保留正常 sent 对照。正文失败不能被成功的其他分段或通知掩盖；发送超时为未知结果，后续唤醒不能重发。进度查询桥尚无 delivery，必须保留禁止凭执行完成声称送达的提示约束。

## benchmark 内部契约

场景可声明 `requiredAssertions`，报告原样保存。runner 检查每项声明都有实际执行的断言，缺失形成运行失败；失败和 inconclusive 均不可通过运行门禁。默认 npm test 和 bench:session 必须包含整个 C01–C10 组，专门的消费者测试核对固定场景和每项关键断言，避免删掉场景或检查后仍显示通过。

JSON 保存完整 Task、实际查询桥返回值、View、投递快照、原消息引用和平台动作；Markdown 由报告生成器按需生成，不作为源码提交。固定 seed=42 的严格基线作为测试夹具保存在 [`tests/fixtures/session-context-baseline.json`](../../tests/fixtures/session-context-baseline.json)，后续报告写 `tmp/` 或 CI artifact，通过既有 `--baseline` 比较，不能覆盖基线文件冒充回归通过。固定基线比较要求场景版本、seed、repetition、输入及必需断言清单一致；改变输入或删减检查不能借用旧基线通过。

## 验收边界

离线基线验证真实编排、上下文供给和投递事实，以及快 lane 的查询/措辞约束。脚本化的模拟回复不证明真实模型一定不会重复工作或误报送达；真实模型仍由独立 live 裁判评测。裁判 v6 / 校准 v3 保留此前九项，并增加 pending、sending、failed、unknown 四种错误宣称送达的坏样本及正确区分执行完成与待发送的正样本。已完成不能作为已送达证据，事后送达不能追认声明时尚未送达的事实；虚假送达须 trust=fail/severe。

生产模块接口、状态写入所有权、配置默认和运行入口保持 ADR-009。验证执行固定组严格运行、对保存基线的严格比较、关键断言缺失/失败/未定的反向测试，再运行完整 npm run check；真实 WebSocket 不混入本轮离线基线。
