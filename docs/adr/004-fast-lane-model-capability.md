# ADR-004：快 lane 模型能力与初始化失败回收

状态：已实施并通过离线验收（2026-11-03）。新增验收使用注入进程、DSH、连接器与时钟的离线 mock；部署机与真实模型复验另列，本次未操作部署机。

## 问题与证据

部署排查报告指出，`arc-code/ark-code-latest` 未声明 `reasoningEfforts`，快 lane 固定请求 `off`，每个 Task 的 initialize 都返回 JSON-RPC `-32603`；慢 lane 不带 effort，正常完成。持续失败消息来自不同 Task 的失败产物，不是队列重试。报告中的真实模型探针为部署机已有证据，本次仓库排查不重复调用模型。

本地核对 DSH 0.1.5-rc.2：未声明能力且无目录基础项的模型按非思考模型处理，显式 `off` 被拒绝；`reasoningEfforts: false` 同样不能接受显式 effort。`off: null` 表示支持 off、请求省略 reasoning 参数，不能保证网关的默认思考策略。只声明 off 的字典也被 DSH 拒绝，必须包含至少一个真实支持的非 off 档位。

## 决策

- 保留快 lane 固定关闭思考的请求。不给所有模型自动补能力、不在失败后自动换提供商，也不隐藏真实失败产物。
- 在配置合并环境变量后，检查快 lane 最终 provider/model。显式 `models` 目录必须包含所选模型，且该模型明确声明 off 与至少一个非 off 档位。显式覆写能力为 false、缺 off 或只含 off 时启动失败，提示准确路径及修复方式。
- 对 `modelOverrides` 中未覆写的能力，以及仅继承 DSH 目录或带外路由，不复制或猜测目录，保留 DSH 初始化校验。这是启动期静态检查的覆盖边界。
- 未就绪 runtime 直接 SIGTERM，随后按既有 shutdownTimeoutMs 等待信号退出，必要时 SIGKILL；就绪 runtime 保留既有优雅关闭流程。初始化根因在清理前记录，避免被清理期间的进程退出覆盖。
- 当前代码已有 DshRuntime 根因日志和 DshLaneRunner 的 errorId 关联，沿用 ADR-002 的元数据纪律，不把原始错误文本或协议帧写入应用日志。

## 配置修复与兼容

部署报告已验证当前 Ark 路由可声明 `{ off: null, high: high }`。该配置只适用于已验证的模型；不能给其他非思考模型编造 high 档位。另一选择是显式配置 `tasks.fastProvider: deepseek-official` 和 `tasks.fastModel: deepseek-flash`，需对应凭证并使用对应计费。

静态检查会要求原来显式列在 `models` 中、但依赖目录继承能力的快 lane 模型也明确声明能力；只需容量覆写时可改用 `modelOverrides`。慢 lane 不受 off 要求约束。公共契约只增加校验入口，既有签名与状态所有权不变。仓库不含部署机的真实 models.yml，实际配置修复和重启需要在部署机完成。

## 验收

- 原始 Ark 配置、false、缺 off、仅 off 及所选模型不存在均在启动期拒绝；off 为 null 或线上拼写且含非 off 档位通过。
- 验证环境变量覆盖和快慢路由独立；默认原生 DeepSeek、DSH 目录继承和未覆写能力的 modelOverrides 保持可用。
- 注入进程及虚拟时钟复现 `-32603`，根因先记录，立即 SIGTERM，无初始 15 秒空等；SIGTERM 被忽略时升级 SIGKILL，就绪关闭仍使用 shutdown。
- `npm run check` 通过：类型、契约边界/兼容/生成文档、lint、格式、构建与 Docker 包解析全部通过；53 个测试文件、1038 项通过，40 项独立 WebSocket 用例按离线模式跳过，36 个契约冒烟通过。新增配置/回收回归共 14 项；ESLint 存量抑制减少 2 项，未新增抑制。真实 WebSocket 本次未重跑。
