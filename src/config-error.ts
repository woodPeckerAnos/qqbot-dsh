/**
 * 配置错误的统一类型。
 *
 * 单独成一个模块是为了断开循环依赖：`config.ts`（合并 env + 配置文件）与
 * `config-file.ts`（解析 qqbot.yml）都要抛它，而 config.ts 又要 import
 * config-file.ts 的类型。`ConfigError` 从 `config.ts` 重新导出，
 * 调用方仍然写 `import { ConfigError } from './config.js'`。
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}
