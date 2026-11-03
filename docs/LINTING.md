# 代码风格与静态检查

## 一次跑全

```sh
npm run check        # 类型、契约、lint、格式、测试、冒烟与 Docker 包解析
```

单项命令：

| 命令                      | 作用                                                         |
| ------------------------- | ------------------------------------------------------------ |
| `npm run lint`            | ESLint（类型感知，读取 `eslint-suppressions.json` 存量基线） |
| `npm run lint:fix`        | ESLint 自动修复                                              |
| `npm run lint:prune`      | 删除已不再命中的存量抑制（修完债后收紧基线）                 |
| `npm run format`          | Prettier 写入                                                |
| `npm run format:check`    | Prettier 只读校验                                            |
| `npm run typecheck`       | 契约独立编译、应用 `tsc --noEmit`、消费者反向类型用例        |
| `npm run contracts:check` | 模块边界、状态写入权、消费者兼容、示例覆盖和文档漂移         |
| `npm run smoke:contracts` | 12 个模块的独立离线消费者示例                                |

## 配置边界

- **Prettier**（`.prettierrc.json`）是唯一的格式真相源。ESLint 的格式类规则由
  `eslint-config-prettier` 关闭；`lint-staged` 先 Prettier 写入，再 `eslint --fix`。
- **ESLint**（`eslint.config.mjs`）对 `src/**`、`packages/contracts/src/**`、`tests/**`、`scripts/**` 和
  `dsh-profile/plugins/**` 生效；`dist/`、`tmp/`、`docs/` 与生成物不检查。
  TS 文件使用 `strictTypeChecked` + `projectService`：
  - `src/**` 用根 `tsconfig.json`；
  - `packages/contracts/src/**` 用独立 workspace 的 `tsconfig.json`；
  - `tests/**` 用 `tests/tsconfig.json`（只做类型信息，不参与 build）。
- `tests/legacy/**` 是旧行为的回归夹具，关闭了复杂度与嵌套三元等结构规则；
  测试文件另外放开 mock 惯用法（非空断言、`any` 泄漏、`async` 无 `await` 等），
  但断言中的类型规则仍然生效。

## 存量基线（`eslint-suppressions.json`）

严格规则是先落地的，存量代码没有一次改完。为了不阻塞 CI、同时不让新代码继续
欠债，当前以 **ESLint 原生 suppressions** 记录存量违规：

- 基线只覆盖 7 类规则：`complexity`、`max-statements`、
  `max-lines-per-function`、`max-depth`、`sonarjs/cognitive-complexity`、
  `@typescript-eslint/no-unnecessary-condition`（外部载荷的防御性判断）、
  `@typescript-eslint/no-deprecated`（旧配置键/旧接口的兼容读取）。
- 抑制按「文件 + 规则 + 次数」记录，**不按行号**。同一文件新增一个复杂度违规会
  使计数超出基线，`npm run lint` 会失败——新代码仍受完整规则约束。
- 修掉存量违规后运行 `npm run lint:prune`，把不再命中的条目删掉，基线只减不增。
- 需要审阅基线里的真实报错时，用空基线跑一次：

  ```sh
  echo '{}' > /tmp/empty-suppressions.json
  npx eslint . --suppressions-location /tmp/empty-suppressions.json
  ```

不要在普通开发中随意 `--suppress-all` 扩充基线；新增抑制应视为一次显式的债务登记。

## 提交前

`npm install` 会执行 `husky`，把 `core.hooksPath` 指向 `.husky/_`；提交时执行
`.husky/pre-commit` 的 `npx lint-staged`：

- `*.{ts,tsx,js,jsx,mjs,cjs}`：Prettier 写入，再 `eslint --fix`
- `*.{json,md,css,yml,yaml}`：Prettier 写入

CI 的 `verify` job 执行完整 `npm run check`，包含 `prettier --check .` 与 `eslint .`。

## Markdown 表格与测试断言

Prettier 会按列宽对齐 Markdown 表格（单元格两侧会补空格）。契约测试如果要断言
某一行表格，请按「行前缀 + 包含的文本」匹配，不要锁死单元格之间的空格，例如
`tests/scenes-layers.test.ts` 的 SCENES.md 检查。

## 模块契约门槛

`npm run contracts:check` 的 TypeScript 边界、公共接口来源与状态写入权检查独立于 ESLint 抑制基线，覆盖所有生产文件，不提供存量违规豁免。独立契约 workspace 使用同一类型和源码 lint 规则；编译产物及版本声明基线作为生成文件排除格式/lint 检查。重构移除的旧 ESLint 抑制项应通过 `lint:prune` 删除，不增加新抑制项。
