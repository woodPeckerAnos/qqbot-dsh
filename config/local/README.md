# config/local —— 本机配置（不进 git）

这个目录放**不属于密钥、但属于本机部署选择**的配置：模型路由、个人别名、
本机资源上限、临时节假日等。它们不适合随仓库提交，但仍然是配置的一部分。

## 文件约定

| 文件 | 是否提交 | 用途 |
|---|---|---|
| `models.example.yml` | ✅ | 模型路由/模型选择模板（含完整字段注释） |
| `overrides.example.yml` | ✅ | 通用本机覆盖模板 |
| `models.yml` | ❌ | 实际的模型配置；不存在 = 全走内置默认 |
| `overrides.yml` | ❌ | 实际的本机覆盖；不存在 = 不覆盖 |

`qqbot.yml` 以 `optional: true` 加载后两个文件：

```yaml
include:
  - path: config/local/models.yml
    optional: true
  - path: config/local/overrides.yml
    optional: true
```

所以**不要提前创建空文件**也没关系；只有需要时才复制模板：

```sh
cp config/local/models.example.yml config/local/models.yml
cp config/local/overrides.example.yml config/local/overrides.yml
```

## git 边界

`.gitignore` 忽略 `config/local/*.yml`，但保留 `*.example.yml`。也就是说：

- 真实本机配置不会被 `git status` 看到，也不会误提交；
- 模板仍然随仓库分发，新机器照模板填即可；
- 如果确实要提交某个本机文件，用 `git add -f` 前先想清楚它是否含个人信息。

## 注意

- **密钥仍然只放 `.env`**。`models.yml` 里只允许 `apiKeyEnv: <变量名>` 的引用
  形式；内联密钥会在启动期被拒绝。不提交 ≠ 可以放密钥。
- 容器以非 root 用户（uid 10001）运行。宿主机上新建的文件若权限是 600，
  容器会读不到；需要时执行 `chmod 644 config/local/*.yml`。
- 改完配置执行 `docker compose restart qqbot` 生效；不需要重建镜像。
