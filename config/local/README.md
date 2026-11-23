# config/local —— 本机配置（可选）

这个目录放**不属于密钥、但属于本机部署选择**的配置：模型路由、个人别名、
本机资源上限、临时节假日等。它们不适合随仓库提交，但仍然是配置的一部分。

**当前状态**：仓库只提供可选加载机制，不随附真实的 `models.yml` /
`overrides.yml`，也没有 `*.example.yml` 模板。两个文件都不存在时，程序使用
共享任务模型默认（`deepseek-official` + `deepseek-flash`，显式 `high`），启动不受影响。

## 文件约定

| 文件            | 是否提交 | 用途                                  |
| --------------- | -------- | ------------------------------------- |
| `models.yml`    | ❌       | 本机模型路由/模型选择（可选）         |
| `overrides.yml` | ❌       | 本机其他覆盖（可选，如本群 bot 别名） |

`qqbot.yml` 以 `optional: true` 加载这两个文件：

```yaml
include:
  - path: config/local/models.yml
    optional: true
  - path: config/local/overrides.yml
    optional: true
```

需要本机差异时，按 [docs/CONFIG.md](../../docs/CONFIG.md) 的键名自行创建；
不需要就留空目录，不要为了"齐全"创建空文件或假配置。

## git 边界

`.gitignore` 忽略 `config/local/*.yml`。也就是说：

- 真实本机配置不会被 `git status` 看到，也不会误提交；
- 当前仓库没有随附模板；如果以后确实要提交模板，用 `*.example.yml` 命名，
  并确认不含个人信息与凭证；
- 如果确实要提交某个本机文件，用 `git add -f` 前先想清楚它是否含个人信息。

## 注意

- **密钥仍然只放 `.env`**。`models.yml` 里只允许 `apiKeyEnv: <变量名>` 的引用
  形式；内联密钥会在启动期被拒绝。不提交 ≠ 可以放密钥。
- 如果自建 `models.yml` 并引用了额外提供商，按其中的 `apiKeyEnv` 在 `.env`
  里设置对应变量；没有自建文件时不需要额外密钥。
- 容器以非 root 用户（uid 10001）运行。宿主机上新建的文件若权限是 600，
  容器会读不到；需要时执行 `chmod 644 config/local/*.yml`。
- 改完配置执行 `docker compose restart qqbot` 生效；不需要重建镜像。

## 任务模型选择

在本机 `models.yml` 中设置 `tasks.taskProvider / taskModel / reasoningEffort`，前台和 worker 共用该模型。未设置 provider/model 时分别继承旧 `tasks.slowProvider / slowModel`，再继承 `dsh.provider / model`；每项环境变量覆盖对应文件值。`tasks.fastProvider / fastModel` 已弃用，生产路径忽略。

默认思考档位是 `high`。显式模型目录必须提供所选档位的真实 `reasoningEfforts` 拼写；缺能力、禁用思考或不支持该档位会拒绝启动。只覆写 DSH 目录模型容量时可使用 `modelOverrides` 保留目录能力。配置示例与环境变量见 [共享任务模型能力](../../docs/CONFIG.md#共享任务模型能力)。
