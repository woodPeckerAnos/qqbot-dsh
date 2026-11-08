# SessionContextView Phase 1 验收（2026-11-08）

分支：`feat/session-context-view`。生产决策：[ADR-009](adr/009-session-context-view.md)、[ADR-014](adr/014-follow-up-result-reuse.md)、[ADR-016](adr/016-progress-completion-qualification.md)；裁判证据与传输分别见 ADR-010、ADR-015。

当前结论：Phase 1 发布前验收通过。

- 分支门禁记录：**1371 项离线测试、39 个契约冒烟**；类型、模块边界、契约兼容/覆盖、生成漂移、lint、格式和 Docker 包解析全部通过（干净 CI，无本机 `config/local`）。
- 本机复验时，`config/local/models.yml` 的 `arc-code` 凭证要求会让 `tests/config.test.ts` 出现 **1 项环境性失败**，实际为 1370 项通过；清掉 `dist/` 与 `packages/contracts/dist/` 后，契约、lint、格式、smoke 和 Docker 包检查均通过。
- C01–C10 严格基线比较：**10/10**。
- 最终真实模型轮次：**真实校准 14/14，L13/L14/L18/LC01–LC03 各三次，运行与语义 18/18**，零失败、零 inconclusive、关闭资源全部为零。
- 独立 localhost WebSocket：**108/108**；本轮完整检查中 44 项 WebSocket 用例按离线模式跳过。
- live 使用真实 DSH、真实模型 API、独立裁判和**内存 QQ 连接器**；真实 QQ 接入与客户端展示未纳入本轮。

完整证据摘要、源码指纹和历次失败/中断轮次见 [SESSION-CONTEXT-EVIDENCE](SESSION-CONTEXT-EVIDENCE.md)。原始 benchmark 报告不再提交到版本库，按需生成到 `tmp/` 或 CI artifact。

## 固定任务衔接基线

[C01–C10](SESSION-BENCHMARK.md#任务衔接基线adr-009--adr-011) 已进入默认 `npm test` 与 `bench:session`。固定基线夹具：

```text
tests/fixtures/session-context-baseline.json
```

复验：

```sh
npm run bench:session -- --cases 任务衔接基线 --strict --seed 42 \
  --baseline tests/fixtures/session-context-baseline.json \
  --output tmp/session-context-comparison
```

## 历史轮次结论

| 轮次                  | 结果         | 说明                                                            |
| --------------------- | ------------ | --------------------------------------------------------------- |
| v1 initial            | 3/3          | 校准 14/14；首次联合验证                                        |
| v1 context-once       | 3/3          | LC02/LC03 原慢 lane 仍有额外 bash，运行门禁失败                 |
| v1 strict-interrupted | 10/18        | 请求失败/超时，8 项 inconclusive，未完成                        |
| v2 once               | 6/6          | 运行与语义通过                                                  |
| v2 strict             | 18/18 已运行 | LC01 漏答、LC02 裁判超时，严格失败                              |
| v3 once               | 6/6          | 语义 5 pass、1 fail/minor，严格失败                             |
| v3 strict             | 18/18 已运行 | 语义 15 pass、2 fail、1 inconclusive，严格失败                  |
| v4 strict             | 18/18 已运行 | 语义 16 pass、2 fail/severe，LC02/LC03 完成范围未限定，严格失败 |
| v5 strict             | **18/18**    | 校准 14/14，运行与语义全通过；ADR-014/016 修复后最终门禁        |

历史失败和 minor 判定没有被重判或覆盖；原始 JSON 报告按需重新生成，不作为源码提交。

## 边界

- live 的 QQ 侧是内存连接器，不证明真实 OneBot/NapCat 的记录投递、客户端展示和 WebSocket 回路。
- 真实 QQ、客户端展示和独立 WebSocket 必须单独验证。
- 回滚：`sessionContext.mode: off` 关闭 View、追问关联和纯进度 guard，重启生效，无数据迁移。
- `query_tasks delivery`、常驻 runtime、事件日志与压缩插件保留后续阶段。
