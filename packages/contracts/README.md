# @qqbot/contracts

私有 npm workspace，版本 `1.0.0`，Owner 为项目维护者。跨生产模块的值类型、常量、错误、接口、元数据与可执行示例以本包为唯一来源，包不依赖生产实现。

生产消费者从 `src/<模块>/index.ts` 获取工厂和函数，从本包获取接口与值定义。工厂签名及实现函数签名是类型；它们不在契约包中提供运行时函数。常量、稳定错误及深快照等共享基础函数提供真实运行值。

## 变更与验证

先修改契约、示例和 ADR，再迁移实现与消费者。每个模块的职责、文件、依赖、能力、状态 owner 和十段语义在 `src/metadata.ts` 中声明；normal/edge/failure 数据夹具在 `src/examples.ts` 中声明，由消费者测试和独立冒烟执行。

在仓库根运行：

```sh
npm run contracts:generate # 独立编译并生成 docs/MODULE-CONTRACTS.md
npm run contracts:check    # 边界、写入权、兼容、覆盖、文档漂移
npm run smoke:contracts   # 编译后执行 12 模块的公共入口示例
npm run check             # 完整离线门槛和 Docker 运行目录解析
npm run test:integration  # 独立 localhost WebSocket 检查
```

`compatibility/v1` 保存首次建立的完整编译声明图，日常构建和文档生成不更新它。新增接口必须兼容已保存的消费者；破坏性签名应先提供新版本入口，迁移消费者，最后移除无消费者的旧入口。基线变更必须由维护者审阅，禁止为绕过兼容失败而重新复制当前声明。

构建顺序为契约包再应用。Docker 安装前需要 workspace manifest，运行阶段需要契约 `dist` 及 manifest，以保留 `node_modules/@qqbot/contracts` 的相对链接。
