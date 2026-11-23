# 前台/worker V3 离线 benchmark v1

架构版本 3，报告 schemaVersion 1。9/9 场景通过，34 项检查。

使用生产 TaskSystem、调度器和消息队列，注入 runner、连接器和时钟，真实本地文件保存状态。正文与业务结果由脚本给定；真实模型及独立语义裁判未评测，API 请求为 0。历史 V2 benchmark 与报告保持独立。

| 场景 | 行为                       | 状态   | 前台/worker/整理次数 | 检查 | 耗时 ms |
| ---- | -------------------------- | ------ | -------------------- | ---- | ------- |
| F01  | 普通请求 worker 为零       | passed | 1/0/0                | 4/4  | 17.69   |
| F02  | 长任务与前台新输入交错     | passed | 3/1/1                | 5/5  | 18.17   |
| F03  | 两次整理失败保留结果       | passed | 1/1/2                | 4/4  | 9.49    |
| F04  | 多会话容量上限             | passed | 10/10/10             | 4/4  | 85.13   |
| F05  | 跨会话公平与会话内串行     | passed | 4/4/4                | 3/3  | 31.08   |
| F06  | 执行 worker 取消           | passed | 1/1/0                | 3/3  | 4.68    |
| F07  | stop 保留首次前台排队任务  | passed | 2/0/0                | 3/3  | 4.78    |
| F08  | 首次前台与结果整理交替     | passed | 4/2/2                | 4/4  | 20.87   |
| F09  | 固定回复与独立附件持久交付 | passed | 1/1/1                | 4/4  | 14.24   |

### F01 普通请求 worker 为零

- 通过：普通请求仅运行一次前台；证据：{"frontend":1,"worker":0,"summary":0}
- 通过：最终回复保存并确认入队；证据：{"status":"completed","replyEnqueued":true,"replyId":"db7df1d5-cce3-46a5-bc36-cb4385a9a5af:reply:1","deliveryGroups":["db7df1d5-cce3-46a5-bc36-cb4385a9a5af:reply:1:delivery"]}
- 通过：正文引用原消息且只送达一次；证据：[{"text":"答复：你好","reference":"m1"}]
- 通过：关闭后执行、排队和计时器全部释放；证据：{"frontendRunning":0,"frontendQueued":0,"workerRunning":0,"workerQueued":0,"timers":0}

### F02 长任务与前台新输入交错

- 通过：worker 未结束时新普通请求已完成；证据：{"worker":"running","ordinary":"completed"}
- 通过：进度关联原 Task 且不创建新 worker；证据：{"progressOnly":true,"followUpMatches":true,"workers":1}
- 通过：结果交回前台整理一次；证据：{"frontend":3,"worker":1,"summary":1}
- 通过：业务内部正文未直接发送；证据：["已接下这项工作，完成后回复。","任务仍在执行，送达状态将在结果准备后更新。","答复：你好","整理后的结果：20"]
- 通过：关闭后执行、排队和计时器全部释放；证据：{"frontendRunning":0,"frontendQueued":0,"workerRunning":0,"workerQueued":0,"timers":0}

### F03 两次整理失败保留结果

- 通过：整理最多两次且 worker 只运行一次；证据：{"attempts":2,"counts":{"frontend":1,"worker":1,"summary":2}}
- 通过：失败终态保留完整业务结果；证据：{"status":"failed","workerText":"完整业务结果：20"}
- 通过：整理失败说明送达，原业务正文不直接发出；证据：["已接下这项工作，完成后回复。","业务执行已完成，但结果整理失败。结果和附件已保存，可稍后查询。"]
- 通过：关闭后执行、排队和计时器全部释放；证据：{"frontendRunning":0,"frontendQueued":0,"workerRunning":0,"workerQueued":0,"timers":0}

### F04 多会话容量上限

- 通过：最多四个 worker 执行，其余六个排队；证据：{"active":4,"peak":4,"scheduler":{"running":4,"queued":6}}
- 通过：运行总量不超过八个，全部首次前台已保存结束状态；证据：{"frontendRunning":1,"workerRunning":4,"frontends":10,"initialEnded":true}
- 通过：十个任务均完成且峰值始终不超限；证据：{"completed":10,"peak":4,"active":0}
- 通过：关闭后执行、排队和计时器全部释放；证据：{"frontendRunning":0,"frontendQueued":0,"workerRunning":0,"workerQueued":0,"timers":0}

### F05 跨会话公平与会话内串行

- 通过：忙会话只运行一个 worker，其他会话先完成；证据：{"started":["busy","free"],"otherStatus":"completed"}
- 通过：被阻塞会话仍按顺序完成全部 worker；证据：{"started":["busy","free","busy","busy"],"workers":4}
- 通过：关闭后执行、排队和计时器全部释放；证据：{"frontendRunning":0,"frontendQueued":0,"workerRunning":0,"workerQueued":0,"timers":0}

### F06 执行 worker 取消

- 通过：取消已开始 worker 被接受；证据：{"taskId":"072ec6e5-3242-49e8-81e2-8e63abbb1aba"}
- 通过：取消终态不启动整理或再次执行 worker；证据：{"status":"cancelled","cancelAccepted":true,"counts":{"frontend":1,"worker":1,"summary":0}}
- 通过：关闭后执行、排队和计时器全部释放；证据：{"frontendRunning":0,"frontendQueued":0,"workerRunning":0,"workerQueued":0,"timers":0}

### F07 stop 保留首次前台排队任务

- 通过：stop 只取消已经开始的 Task；证据：{"cancelled":1,"first":"cancelled"}
- 通过：未开始首次前台的输入保留并完成；证据：{"queued":"completed","workers":0}
- 通过：关闭后执行、排队和计时器全部释放；证据：{"frontendRunning":0,"frontendQueued":0,"workerRunning":0,"workerQueued":0,"timers":0}

### F08 首次前台与结果整理交替

- 通过：首次输入与结果整理同时排队；证据：{"queued":3}
- 通过：首次前台、整理、首次前台按顺序交替；证据：{"order":["frontend:普通甲","summary:长任务乙","frontend:普通乙"]}
- 通过：排队的普通请求和结果全部完成，无额外 worker；证据：{"counts":{"frontend":4,"worker":2,"summary":2},"statuses":["completed","completed","completed","completed"]}
- 通过：关闭后执行、排队和计时器全部释放；证据：{"frontendRunning":0,"frontendQueued":0,"workerRunning":0,"workerQueued":0,"timers":0}

### F09 固定回复与独立附件持久交付

- 通过：执行完成与等待送达状态分开，附件已保存独立副本；证据：{"execution":"completed","deliveryPending":true,"independentCopy":true,"copied":"name,total\nA,20\n"}
- 通过：任务清理保留固定消息，不再次调用 worker 或整理；证据：{"taskRemoved":true,"counts":{"frontend":1,"worker":1,"summary":1}}
- 通过：原文件删除后附件完整送达一次；证据：{"attachments":[{"fileName":"report.csv","text":"name,total\nA,20\n","sha256":"59b7c4d6b7efc883a78e70e0b42bb6aef103520c261a4b05f8da85070e2905e6"}],"pending":false}
- 通过：关闭后执行、排队和计时器全部释放；证据：{"frontendRunning":0,"frontendQueued":0,"workerRunning":0,"workerQueued":0,"timers":0}
