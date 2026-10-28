# 配置模块手册

`qqbot.yml` 不再是一份大配置，而是**入口 + 模块清单**。这份文档说明怎么读、
怎么改、怎么加新模块，以及哪些文件该提交、哪些不该。

## 1. 为什么拆

最初的 `.env` 里混着密钥与行为参数，后来把行为参数挪进 `qqbot.yml`。随着功能
增加，单文件又涨到五百多行，改一个参数要先翻半天。拆成模块后：

- `qqbot.yml` 只回答"加载哪些模块、怎么合并"；
- `config/*.yml` 每个文件只管一个领域，详细注释跟着领域走；
- `config/local/*.yml` 放本机差异（模型路由、个人别名等），不污染共享默认值。

## 2. 文件地图

| 文件 | 内容 | 提交到 git |
|---|---|---|
| `qqbot.yml` | 入口：include 清单、加载/合并规则、模块开关说明 | ✅ |
| `config/connectors.yml` | `connectors` / `qq-official`（含 `c2c`）/ `onebot` | ✅ |
| `config/runtime.yml` | `dsh` 进程参数 / `pool` / `paths` / `health` / `logLevel` | ✅ |
| `config/media.yml` | `attachments`（含 `forward`、`files`）/ `media` | ✅ |
| `config/interaction.yml` | `personas` / `hints` / `topic` / `observation` | ✅ |
| `config/proactive.yml` | `proactive` 主动发言全部参数 | ✅ |
| `config/offpeak.yml` | `offpeak` 谷时段闸 | ✅ |
| `config/local/models.yml` | 本机模型路由与 `dsh.provider`/`dsh.model` | ❌ |
| `config/local/overrides.yml` | 其他本机覆盖 | ❌ |
| `config/local/*.example.yml` | 上述两个文件的模板 | ✅ |
| `config/local/README.md` | 本机配置说明 | ✅ |

模型选择放在本机文件里，是因为它不是密钥、但属于"这台机器用哪家/哪个模型"的
部署选择。不创建 `models.yml` 时走代码内置默认（`deepseek-official` +
`deepseek-flash`），行为与不配置一致。

> 历史设计文档（`*PLAN.md` / `*REQUIREMENT.md`）里提到的 `qqbot.yml` 指拆分前的
> 单文件形态；现行配置位置以本表为准。

## 3. 加载规则

入口由 `QQ_CONFIG_FILE` 指定（默认 `./qqbot.yml`）。入口里的 `include`：

```yaml
include:
  - config/connectors.yml
  - path: config/local/models.yml
    optional: true
  - path: config/proactive.yml
    enabled: false
```

- 相对路径以**包含它的文件**所在目录为基准（入口在仓库根目录时就是仓库根目录）；
- 字符串等价于 `{ path, optional: false, enabled: true }`；
- `optional: true`：文件不存在时跳过；文件存在但 YAML/类型错误、是目录、
  不可读时仍然报错；
- `enabled: false`：不读取、不校验、不合并，适合保留清单做开关；
- 模块文件自身也可以再 include；加载器有循环检测与深度上限（16 层）。

## 4. 合并与优先级

按 include 从上到下加载，**后加载覆盖先加载**；入口文件自己的配置项最后合并，
覆盖所有模块。合并语义：

- 映射：递归深合并。只写 `onebot.port` 不会抹掉前面的 `onebot.host`；
- 数组 / 标量：整体替换。`connectors: [onebot]` 就是只剩 onebot；
- 空数组/空对象可以用来显式清空下层（`holidays: []`）。

整体优先级：**环境变量 > 配置文件合并结果 > 代码内置默认**。

每个文件先独立做形状/类型校验，再合并。因此键名拼错、类型写错会指出具体模块
文件，而不是只给一个合并后的 YAML 路径。

## 5. 模块控制

停用一个模块有三种方式，按场景选：

1. **整行注释掉 include**：最直观，适合长期停用；
2. **`enabled: false`**：保留清单，开关更显眼；把原来的字符串条目改成
   `- path: config/xxx.yml` + `enabled: false`，**不要在原条目之外再加一行**
   （同一清单重复引用会报错）；
3. **改模块内的业务开关**（如 `proactive.enabled`）：模块仍加载，只是功能关闭。

注意第 2 与第 3 不同：模块关掉后整段配置不存在，相关参数走代码内置默认
（例如 `proactive` 的内置默认是关闭）；业务开关则保留配置、只关行为。不要为了
"关主动发言"去关模块，除非你确实想把整段配置也移出生效范围。

## 6. 新增一个模块

1. 新建 `config/<领域>.yml`，写顶层 section 和详细注释；
2. 在 `qqbot.yml` 的 `include` 里加一行（需要可选就写 `optional: true`）；
3. 如果引入的是**新的配置键**，还要改代码：
   - `src/config-file.ts` 的 `TOP_SECTIONS` / 嵌套 spec（未知键会启动期报错）；
   - `src/config.ts` 的合并与语义校验；
4. 加单测：`tests/config-includes.test.ts` 覆盖加载/合并，`tests/config*.test.ts`
   覆盖取值；
5. 跑 `npx tsc -p tsconfig.json --noEmit` 与 `npx vitest run`。

只挪动已有 section 到新文件不需要改代码，只需要改 include。

## 7. git 边界

- `config/*.yml`：随仓库提交的默认值，改动走 code review；
- `config/local/*.yml`：被 `.gitignore` 忽略，放本机部署选择；
- `config/local/*.example.yml`：模板，提交；
- 任何配置文件都**不允许**内联密钥：密钥只在 `.env`，模型凭证用 `apiKeyEnv`
  引用；`admins` / `BOT_LISTEN_GROUPS` 等个人标识只认环境变量。
- 个人别名之类"不保密但不适合提交"的部署偏好，建议放
  `config/local/overrides.yml`（模板里有示例）；共享模块里的示例别名可按需替换。

如果确实要提交某个本机文件，先确认它不含个人信息与凭证；`git add -f` 会绕过
忽略规则，因此要格外小心。

## 8. 常见错误

| 报错 | 含义 | 处理 |
|---|---|---|
| `配置模块不存在：...` | 非 optional 的 include 指向了不存在的文件，或升级后 `./config` 挂载没生效 | 改路径、注释该行，或加 `optional: true`；先 `docker compose up -d` 让挂载生效 |
| `配置模块是一个目录，不是文件` | 宿主上文件不存在，Docker bind mount 自动建了同名目录 | 删掉该目录，`git checkout -- config` |
| `配置模块循环引用：a → b → a` | include 互相指回上级 | 去掉环 |
| `... 含 include 的入口文件必须用 loadConfigFile 解析` | 用单文件解析器读了入口 | 正常启动路径不会出现；测试请用 `loadConfigFile` |
| `... 不是可识别的配置项` | 模块里键名拼错 | 按报错列出的可用项改 |
| `没有权限读取配置模块` | 宿主机文件对容器 uid 10001 不可读 | `chmod 644 <文件>` |

## 9. 升级与生效

- 从旧版单文件配置升级：先 `docker compose up -d` 一次，让 `./config` 挂载生效；
  只 `restart` 旧容器不会自动加新挂载。
- 之后改 `qqbot.yml` 或 `config/**`：`docker compose restart qqbot`，不需要重建镜像。
- 不要删掉宿主上的 `config/` 目录；缺模块会在启动期报错，而不是悄悄用默认值。
- 如果旧 `qqbot.yml` 有你自己的改动：把差异挪到 `config/local/overrides.yml`
  （或对应模块），不要让入口重新变成大杂烩。
