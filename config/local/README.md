# config/local —— 本机配置（生产）

这个目录放**不属于密钥、但属于本机部署选择**的配置：模型路由、个人别名、
本机资源上限、临时节假日等。它们不适合随仓库提交，但仍然是配置的一部分。

## 文件约定

| 文件 | 是否提交 | 用途 |
|---|---|---|
| `models.yml` | ❌ | 生产模型路由/模型选择（arc-code） |
| `overrides.yml` | ❌ | 生产本机覆盖（本群 bot 别名） |

`qqbot.yml` 以 `optional: true` 加载这两个文件：

```yaml
include:
  - path: config/local/models.yml
    optional: true
  - path: config/local/overrides.yml
    optional: true
```

本生产包已经带好这两个文件，直接使用即可；新机器也可以参考仓库里的
`*.example.yml` 模板重新生成。

## git 边界

`.gitignore` 忽略 `config/local/*.yml`，但保留 `*.example.yml`。也就是说：

- 真实本机配置不会被 `git status` 看到，也不会误提交；
- 模板仍然随仓库分发，新机器照模板填即可；
- 如果确实要提交某个本机文件，用 `git add -f` 前先想清楚它是否含个人信息。

## 注意

- **密钥仍然只放 `.env`**。`models.yml` 里只允许 `apiKeyEnv: <变量名>` 的引用
  形式；内联密钥会在启动期被拒绝。不提交 ≠ 可以放密钥。
- 本生产包需要 `.env` 里有 `ARC_CODE_API_KEY`（供 `models.yml` 的 arc-code
  路由引用）。
- 容器以非 root 用户（uid 10001）运行。宿主机上新建的文件若权限是 600，
  容器会读不到；需要时执行 `chmod 644 config/local/*.yml`。
- 改完配置执行 `docker compose restart qqbot` 生效；不需要重建镜像。
