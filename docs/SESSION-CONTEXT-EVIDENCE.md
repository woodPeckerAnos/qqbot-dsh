# SessionContextView 证据摘要（ADR-009 / ADR-011 / ADR-014 / ADR-016）

本文件只保留可审计的**摘要与源码指纹**。完整 benchmark 原始报告（含失败/中断轮次的大 JSON）不再提交到版本库，避免仓库被生成物撑大；需要复核时按下方命令重新生成到 `tmp/` 或 CI artifact。

## 最终状态

- 分支：`feat/session-context-view`
- 决策：ADR-009、ADR-011、ADR-014、ADR-015、ADR-016
- 离线：C01–C10 严格基线 **10/10**，默认 `npm test` 与 `bench:session` 均包含该组。
- 真实模型：最终 v5 严格轮次 **校准 14/14，运行 18/18，语义 18/18**，零失败、零 inconclusive，关闭资源全部为零。
- 场景：L13、L14、L18、LC01、LC02、LC03，各 3 次。
- live 边界：真实 DSH + 真实模型 API + 独立裁判 + **内存 QQ 连接器**；真实 QQ 接入、客户端展示和独立 WebSocket 另行验证。

## 最终源码指纹

最终 v5 严格报告记录并已核对与当前工作区一致：

| 文件                                  | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `src/task/dsh-lane-runner.ts`         | `81d9a320a6ed3bd61d35279f3b2f2a6394496e84b01e7d3256443560e21a3a4c` |
| `src/session/context.ts`              | `48b33e69e65a0a8849114e93ee54fecef15e703991373421697e52c78a651f6c` |
| `dsh-profile/cordis.patch.yml`        | `ac6b1e73eca8edbb3970fe66b206b79b03cc4667f056f8af96e56d56f7369b7b` |
| `dsh-profile/plugins/task-control.js` | `fe1114c54d81b22004c8d92725c566c18156f6c85a9965504cf06f9b41a239fc` |
| `tests/bench/session/judge.ts`        | `0209f29f23dd890f89062deb9c627985c991e1e0c8fc5b6a676100659dca4dca` |
| `tests/bench/session/runner.ts`       | `9626338886fe78dc20878760a919e0fd2a972e37cebba7786cc2452f0f2481fc` |

## 固定离线基线

C01–C10 的场景版本、输入、requiredAssertions 和通过证据保存在：

```text
tests/fixtures/session-context-baseline.json
```

这是**测试夹具**，不是运行报告；它保留完整记录，因为 `tests/session-context-benchmark.test.ts` 要用它做固定基线比较。Markdown 展示可由测试或 `bench:session` 重新生成。

复验：

```sh
npm run bench:session -- --cases 任务衔接基线 --strict --seed 42 \
  --baseline tests/fixtures/session-context-baseline.json \
  --output tmp/session-context-comparison
```

## 真实模型轮次摘要

| 轮次                  | 结果            | 结论                                                            |
| --------------------- | --------------- | --------------------------------------------------------------- |
| v1 initial            | L13/L14/L18 3/3 | 校准 14/14；首次联合验证                                        |
| v1 context-once       | LC01–LC03 3/3   | LC02/LC03 原慢 lane 仍有额外 bash 调用，运行门禁失败            |
| v1 strict-interrupted | 10/18           | 请求失败/超时导致 8 项 inconclusive，未完成                     |
| v2 once               | 6/6             | 运行和语义通过                                                  |
| v2 strict             | 18/18 已运行    | LC01 漏答、LC02 裁判超时，严格失败                              |
| v3 once               | 6/6             | 语义 5 pass、1 fail/minor，严格失败                             |
| v3 strict             | 18/18 已运行    | 语义 15 pass、2 fail、1 inconclusive，严格失败                  |
| v4 strict             | 18/18 已运行    | 语义 16 pass、2 fail/severe，LC02/LC03 完成范围未限定，严格失败 |
| v5 strict             | **18/18**       | 校准 14/14，运行与语义全通过；ADR-014/016 修复后最终门禁        |

历史失败和 minor 判定没有被重判或覆盖；这里只记录结论，原始证据按需重新生成。

## 原始报告的处理

- `docs/benchmarks/` 不再提交；`.gitignore` 已排除该目录。
- 重新生成 live 严格报告：

```sh
npm run bench:session:live -- \
  --cases L13,L14,L18,真实任务衔接 --repeat 3 --strict \
  --output tmp/session-context-qualified-strict
```

- 运行前按 [SESSION-BENCHMARK](SESSION-BENCHMARK.md#运行与配置) 提供 DSH、profile、模型凭证和 `BENCH_JUDGE_CONFIG`。
- 报告写入 `tmp/`（已忽略）或 CI artifact；归档前做凭证扫描。
- 大 JSON 只作为发布证据，不作为源码提交；需要长期保存时上传到 release artifact / 对象存储。
