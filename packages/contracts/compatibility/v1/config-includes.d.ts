/**
 * 配置模块（`include`）展开层。
 *
 * 背景：`qqbot.yml` 从"一份大文件"改成"入口 + 模块清单"。入口只负责声明
 * 要加载哪些模块，真正的参数留在 `config/*.yml` 里，各自带详细注释。
 * 这个模块只做三件事，不碰配置 schema：
 *
 *   1. 校验 `include` 条目的形状（字符串，或 `{ path, optional, enabled }`）；
 *   2. 递归读取模块文件，处理相对路径、optional 缺失、循环引用与深度上限；
 *   3. 把各文件的解析结果按顺序深合并（映射递归，数组/标量替换）。
 *
 * 为什么放在单独文件：`config-file.ts` 已经有"单文件形状校验"的单一职责，
 * 文件图遍历与合并是另一件事；分开后两边都能单独测试，也避免该文件继续膨胀。
 *
 * 报错原则：配置错误必须在启动期炸，并且指出**具体文件**。所以这里所有
 * I/O 异常都会被翻译成带"来源 include 项"的 ConfigError，而不是让 ENOENT /
 * EISDIR 直接冒到日志里。
 */
/** 一条 `include` 声明（已通过形状校验）。 */
export interface IncludeDirective {
    /** 模块路径；相对路径以"包含它的文件"所在目录为基准 */
    path: string;
    /** 文件不存在时是否允许跳过（本机可选配置用） */
    optional: boolean;
    /** false = 不读取、不校验、不合并（用于保留清单做开关） */
    enabled: boolean;
}
/** 单个配置文件解析后的产物：本文件的配置 + 它声明的模块。 */
export interface ParsedConfigDocument<T> {
    config: T;
    includes: IncludeDirective[];
}
/** 解析一份配置文本的回调（由 config-file.ts 提供，避免本模块依赖 schema）。 */
export type ConfigFileParser<T> = (text: string, source: string) => ParsedConfigDocument<T>;
/**
 * 校验并归一化 `include` 段。
 *
 * 两种写法都接受：
 *   - `config/connectors.yml`
 *   - `{ path: config/local/models.yml, optional: true, enabled: true }`
 */
export type parseIncludeDirectives = (raw: unknown, source: string) => IncludeDirective[];
/** 把 include 里的路径解析成实际文件路径（相对路径以包含它的文件为基准）。 */
export type resolveIncludePath = (specPath: string, fromFile: string) => string;
/**
 * 深合并两份配置。
 *
 * 规则与 tsconfig 的直觉一致：映射逐层合并，数组和标量由后者整体替换。
 * 例如后加载的模块只写 `onebot.port` 时，不会把前面的 `onebot.host` 抹掉；
 * 但写 `connectors: [onebot]` 会整份替换连接器列表。
 *
 * 不修改入参：合并结果是新对象，方便单测与排障。
 */
export type deepMergeConfig = <T extends object>(base: T, patch: T) => T;
/**
 * 从根文件文本出发，递归展开 include 并合并成一份配置。
 *
 * 根文件必须已经存在且可读（缺失策略由 config-file.ts 处理，因为默认路径
 * 与 QQ_CONFIG_FILE 显式路径的语义不同）。返回的 `files` 按实际加载顺序排列，
 * 根文件在最后，便于启动日志展示"到底读了哪几份配置"。
 */
export type loadConfigGraph = <T extends object>(rootPath: string, rootText: string, parseFile: ConfigFileParser<T>) => {
    config: T;
    files: string[];
};
