# SessionActor benchmark

结果：门禁通过；模式：live；严格：true；种子：42。

离线语义标注仅验证已知反例；真实语义结论以显式live报告为准。没有任意毫秒阈值。

| 场景                   | 样本 | 运行通过 | 语义pass/fail/inconclusive | 已知问题 |
| ---------------------- | ---: | -------: | -------------------------- | -------- |
| L13 进度查询           |    1 |      1/1 | 1/0/0                      |          |
| L14 慢执行中新短问题   |    1 |      1/1 | 1/0/0                      |          |
| L18 补充条件上下文归属 |    1 |      1/1 | 1/0/0                      |          |

## 耗时与资源

```json
{
  "samples": 3,
  "tasks": 6,
  "firstReplyMs": {
    "count": 6,
    "p50": 1497,
    "p95": 2629
  },
  "finalDeliveryMs": {
    "count": 6,
    "p50": 2084,
    "p95": 20452
  },
  "queueAndPreparationMs": {
    "count": 11,
    "p50": 366,
    "p95": 18923
  },
  "durationMs": 56939,
  "throughputTasksPerSecond": 0.10537592862537101,
  "runtimePassRate": 1,
  "semanticPassRate": 1,
  "inconclusive": 0,
  "resources": [
    {
      "caseId": "L13",
      "repetition": 1,
      "outputProbeListeners": 0,
      "runtimes": 0,
      "subagents": 0,
      "timers": 0,
      "benchmarkObservers": 0,
      "connectorSubscriptions": 0,
      "schedulerRunning": 0,
      "schedulerQueued": 0
    },
    {
      "caseId": "L14",
      "repetition": 1,
      "outputProbeListeners": 0,
      "runtimes": 0,
      "subagents": 0,
      "timers": 0,
      "benchmarkObservers": 0,
      "connectorSubscriptions": 0,
      "schedulerRunning": 0,
      "schedulerQueued": 0
    },
    {
      "caseId": "L18",
      "repetition": 1,
      "outputProbeListeners": 0,
      "runtimes": 0,
      "subagents": 0,
      "timers": 0,
      "benchmarkObservers": 0,
      "connectorSubscriptions": 0,
      "schedulerRunning": 0,
      "schedulerQueued": 0
    }
  ]
}
```

## 失败与未完成证据

裁判校准：通过；14个样本。
