# 富媒体回复（图片 / 文件）方案规划

> 状态：**已实现**（分支 `feat/rich-media-egress`，步骤 1-4 全部落地，测试通过）。
> 关键决策（已与维护者确认）：检测走 **outbox 目录约定**；配额规则为
> **平时文本保底 1 条、生死二选一时附件优先**；官方按 **media 不可携带文本**
> 假设设计（实测后可升级为图文合并）；实施顺序 **消息模型 + OneBot 先行，官方紧随**。
>
> 实现期对本文档的两处偏差（均已落实到 DESIGN.md §12）：
>   1. OneBot 侧**没有**做"text+image 合并成一条消息"：编排层的账本语义是
>      "一次 reply() = 一条消息"，而附件需要逐个隔离失败；OneBot 配额足够宽
>      （默认 10 条），分条发送没有实际代价；
>   2. §6.3 的 ReplyPolicy 媒体字段未下沉——两个平台的出站限制当前一致，
>      全局 `media` 配置已够（与入站 `attachments` 配置的既有先例一致）；
>      哪天官方与 OneBot 的限制真分化了再下沉。

## 1. 目标与非目标

### 目标

DSH agent 在会话工作区里产出的文件，能作为 QQ 消息送达用户：

- **图片**：agent 生成 / 下载的 png、jpg、gif 等，以图片消息呈现；
- **文件**：可执行脚本、HTML 页面、markdown 报告等任意文件，以文件消息呈现
  （QQ 客户端里可下载、可转发）。

### 非目标

- 接收侧（用户发图给 bot）——另一件事，不在本方案内；
- 语音 / 视频——协议上同构（官方 file_type 2/3，OneBot 有 record/video 段），
  留好扩展点但本期不做；
- 流式输出、markdown 内嵌图（官方 markdown 要求公网 URL，bot 没有图床，走不通）；
- 上传预取（turn 进行中预传文件，见 §10 开放问题，观察实测数据后再定）。

## 2. 现状与差距

当前出链路是纯文本的：

```
TurnAccumulator → TurnOutcome{ text } → Responder.deliver
  → segmentText 分段 → BotConnector.reply(ctx, { text })
```

- `OutgoingMessage` 只有 `text: string`（`src/core/connector.ts`）；
- 官方适配器的 wire 类型已经预留了富媒体字段：`MsgType.MEDIA = 7`、
  `SendMessageRequest.media: { file_info }`（`src/adapters/qq-official/types.ts`），
  但 `render.ts` 只渲染 text/markdown 两种；
- OneBot 适配器把出站消息硬编码为单个 text 段
  （`src/adapters/onebot/connector.ts` 的 `reply()`）；
- agent 的工作区就在本地：`/data/workspaces/<hash>/`（`src/store/paths.ts`），
  文件产物的物理位置是现成的。

差距 = ① 不知道该发哪些文件；② 消息模型没有附件概念；③ 两个适配器没有发送实现。

## 3. 决策一：检测机制 —— outbox 目录约定

**定稿**：persona 里约定"要发给用户的文件，放进工作区的 `outbox/` 子目录"，
turn 结束后由 Responder 扫描该目录，逐个发送，发完归档。

### 为什么不是文本标记（`<<<FILE:path>>>`）

规划初稿主推文本标记，深入讨论后推翻，三条理由按权重排序：

1. **超时/中断路径的健壮性（决定性）**：turn 超时走 `timeoutResult()`，文本是
   部分累积的，标记很可能写了一半或根本没写到——标记方案在最需要兜底的场景
   恰好最脆弱。而文件实打实落在磁盘上，outbox 扫描不受文本完整性影响。
2. **模型遵从度**：写标记是"在文本生成里嵌入特殊语法"，长回复中容易忘、容易
   写歪；"把产物放进指定目录"是文件操作，恰是 coding agent 最可靠的行为。
3. **失败体验**：标记解析失败会在用户屏幕上留下 `<<<FILE:...>>>` 残留；
   outbox 没有可见残留。

### outbox 的状态管理

- 目录：`<workspace>/outbox/`（不存在则视为无附件，不要求 agent 预先创建）；
- 每会话有串行锁（pipeline 准入层保证），不存在并发写 outbox 的竞态；
- **归档策略**：成功发送的文件移入 `outbox/.sent/`（保留便于排障与重发追查），
  定期清理；发送失败（配额/平台错误）的文件留在原地并记 warn 日志——
  下一轮如果用户追问，agent 与 bot 都还能看到它，但**不会自动重发**
  （自动重发需要跨 turn 的账本，复杂度不值，用户说一句"把文件发我"即可）。

### 路径安全（结构性保证）

- 扫描范围被钉死在该会话工作区的 `outbox/` 内，`realpath` 后仍须落在其中
  （防符号链接逃逸）；
- **跨会话隔离**：Responder 只持有本会话的工作区路径，A 群的产物不可能被
  B 群的消息触发发出——不需要额外防线；
- prompt injection 风险（用户诱导 agent 把某文件放进 outbox）可控：可达范围
  只有本会话工作区，而其中的文件本来就是为这位用户服务的产物，用户直接开口
  也能要到。这段论证要留在文档里，避免每次评审重问一遍。

## 4. 决策二：接缝怎么改（`core/connector.ts`）

`OutgoingMessage` 扩展为：

```ts
interface OutgoingAttachment {
  kind: 'image' | 'file';        // audio/video 预留
  absPath: string;               // 已通过包含性校验的绝对路径
  fileName: string;              // 发送时展示的文件名（不含目录）
  sizeBytes: number;
}

interface OutgoingMessage {
  text: string;                  // 可为 ''（纯附件消息）
  attachments?: OutgoingAttachment[];
}
```

原则不变：编排层只说"发什么"，**怎么发**（官方两步上传、OneBot 消息段）
全部留在适配器内。编排层不 import 任何 adapters/* 的现状维持不动。

### 图片/文件的分类：显式白名单

按扩展名分类，但图片侧用**保守白名单**：`png / jpg / jpeg / gif` 走 image，
其余一律按 file 发。理由：svg 是图片但 QQ 客户端基本不当图片渲染，走
file_type=1 可能被平台拒绝——"以文件形式收到的 svg"用户能打开，"以图片形式
发被平台拒掉的 svg"用户什么都看不到。白名单做成配置项，实测后扩充
（webp/bmp 待定）。

## 5. 决策三：配额与发送顺序

官方每条消息最多回 5（群）/4（单聊）条，富媒体消息**同样占额度**，且上传耗时
也在 5 分钟窗口内。OneBot 无此约束，且消息段数组天然支持 `[text, image]`
混合（零额外配额、阅读顺序正确）——**能合并的平台必须合并**。

### 官方平台的分条规则（按"media 不可携带文本"设计）

定稿的分配规则（实现进 Responder / ReplyLedger，理由写进注释防误改）：

1. **平时：文本保底 1 条**。`附件预算 = 剩余额度 - 1`。
   附件超预算时，超出的文件降级为文本里的一行说明
   （"还有 2 个文件未发出：b.png、c.html"），不静默丢弃——
   最差情况下用户也知道"发生了什么、还有什么没拿到"。
2. **生死二选一（只剩 1 条额度且有附件）时反转：给附件**。
   超时场景下文本只是"中断了"的告知，可以并入后续回复；文件不发就丢了。
3. 发送顺序：**附件先、文本后**。先保证稀缺额度用在不可再生的内容上。

### OneBot 平台

text 段 + image 段合并为一条消息；文件走独立的 upload 动作（不占消息条数
概念，但仍计 stats）。

## 6. 两个适配器的发送实现

### 6.1 官方开放平台（qq-official）

两步走（`srv_send_msg=false`），保持 msg_id/msg_seq 被动回复语义：

1. **上传**：`POST /v2/groups/{group_openid}/files`（单聊换 `/v2/users/{openid}/files`），
   请求体 `{ file_type, file_data, srv_send_msg: false }`：
   - `file_type`：`1` 图片 / `4` 文件（2 视频、3 语音预留）；
   - `file_data`：本地文件 base64。不用 `url` 形式——bot 没有公网可下载的地址；
   - 返回 `file_info`（有时效，拿到就立刻用，不缓存）。
2. **发送**：`POST .../messages`，`msg_type: 7`，`media: { file_info }`，
   照常带 `msg_id` + `msg_seq`。

新增 `api.uploadGroupFile / uploadUserFile`，`render.ts` 增加 `renderMediaMessage()`。
上传复用 `QqApi.request`（token 鉴权与 401 重试白拿）。体积上限与
file_type=4 是否对机器人开放都未实测——上限写进配置不写死，开放性列入待实测。

### 6.2 OneBot（NapCat / LLOneBot / Lagrange）

- **图片**：`send_group_msg / send_private_msg` 消息段数组：
  `[{ type: 'text', ... }, { type: 'image', data: { file: 'base64://...' } }]`；
- **文件**：`upload_group_file`（群）/ `upload_private_file`（单聊）动作，
  参数 `file`、`name`。

**部署注意（写进 RUNBOOK）**：`file` 给本地路径只在 bot 与框架**同机同文件系统**
时有效；跨容器必须用 `base64://`。默认 base64，配置 `onebot.fileTransport: base64 | path`
留给同机部署优化。base64 体积 +33%，配合全局体积上限控制；ws 库的 maxPayload
要同步调大（默认 100MiB，一般不会触顶，但要在配置注释里写明联动关系）。

### 6.3 能力差异显式化

`ReplyPolicy` 增加媒体字段（默认值按平台给）：

```ts
interface ReplyPolicy {
  // ...现有字段
  mediaEnabled: boolean;        // 该平台是否允许发附件
  maxAttachmentMB: number;      // 单附件体积上限
  maxAttachmentsPerMsg: number; // 单次回复附件数上限
}
```

## 7. 配置（qqbot.yml）

```yaml
# 顶层：富媒体总开关与全局约束
media:
  enabled: true
  maxFileMB: 20          # 超出的附件降级为文本说明
  imageExtensions: [png, jpg, jpeg, gif]  # 图片白名单，其余按文件发
  outboxDir: outbox      # 工作区内的约定目录名

onebot:
  fileTransport: base64  # 同机部署可改 path
```

密钥体系不动；本节的改动只是行为参数。

## 8. 对 agent 的指令（dsh-profile）

在 `cordis.patch.yml` 的 personaPrefix 里追加一条回复纪律（注意该文件
`!!js` 值不能含字面换行等坑，见文件头注释）：

> 想把文件（图片、脚本、页面等）发给用户时，把它放进工作区的 outbox/ 目录，
> 并在回复里用一句话说明每个文件是什么。不要把文件内容粘贴到回复里。

失败体验：agent 没放文件就是没放（用户在文本里仍能读到"我生成了 report.html"），
无残留、不报错。

## 9. 实施步骤（按定稿顺序，每步可独立合并）

1. **消息模型 + outbox 扫描 + 配额规则**（平台无关）：
   `OutgoingAttachment`、outbox 扫描器（包含性校验、stat、白名单分类、归档）、
   Responder 的附件预算与"文本保底 / 二选一反转"规则。单测覆盖。
2. **OneBot 适配器**：image 段合并 + upload_group_file/private_file。
   端到端可验证（本地起 NapCat 即可）。`onebot.fileTransport` 配置。
3. **官方适配器**：`uploadGroupFile/uploadUserFile` + `renderMediaMessage`。
4. **profile 指令 + 文档**：persona 约定、RUNBOOK 部署注意、DESIGN.md 补一节。

## 10. 待实测清单与开放问题

**待实测**（本环境外网不可达，官方接口细节按既有认知设计，实现前须核实）：

1. 官方 `/files` 上传：file_type=4（文件）是否对机器人开放、大小上限、
   `file_info` 时效；
2. 官方 msg_type=7 是否允许同时携带 `content` 文本——**当前按"不允许"设计**，
   若实测允许则升级为图文合并（减少配额占用，纯优化不阻塞）；
3. OneBot 各实现对 `upload_group_file` 的 base64 支持一致性（NapCat 支持，待核）；
4. webp/bmp 走 file_type=1 的平台接受度，决定图片白名单是否扩充。

**开放问题**：

- **上传预取**：官方"上传（慢）→ file_info → 发消息"链路中上传也吃 5 分钟
  窗口；若实测发现窗口紧张，退路是 turn 进行中监听 assistant/message 事件
  提前解析标记并预传文件。与 outbox 方案不兼容（turn 结束前无法确定文件
  是否还会被改），故一期不做，仅记录。

## 11. 测试计划

- 纯函数：outbox 扫描（多附件、符号链接逃逸、不存在/超体积文件、白名单分类）；
- Responder：文本保底规则、二选一反转、附件超预算时的文本降级、
  单附件失败不阻塞其余、归档动作（成功搬走 / 失败留下）；
- OneBot：text+image 混合消息段构造、upload 动作参数、base64/path 两种 transport；
- 官方：files 上传请求体、media 消息体（msg_id/msg_seq 照带）、401 重试复用；
- 集成：fake connector 断言一轮 turn 里"附件×2 + 文本×1"的调用序列与顺序。

## 12. 风险

| 风险 | 缓解 |
|---|---|
| agent 不把产物放进 outbox | persona 指令写清；无残留降级；用户追问一句即可补救 |
| 官方 file_info 时效与上限未实测 | 列入待实测清单；上限配置化不写死 |
| base64 大文件撑爆 OneBot WS 帧 | maxFileMB 上限；ws maxPayload 联动调大（注释写明） |
| 附件发送拖长占用被动窗口 | 上传与发送都在 turnTimeoutMs 预算内；超时回收路径已存在 |
| 越界路径 / 符号链接逃逸 | realpath 包含性校验，见 §3 |
| prompt injection 诱导发文件 | 可达范围仅本会话工作区，论证见 §3 |
