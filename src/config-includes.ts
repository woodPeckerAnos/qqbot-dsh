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

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';

import { ConfigError } from './config-error.js';

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

/** include 嵌套深度上限。正常配置只有入口 + 一层模块，16 层足够覆盖扩展场景。 */
const MAX_INCLUDE_DEPTH = 16;

const INCLUDE_KEYS = ['path', 'optional', 'enabled'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `数组 [${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  if (isPlainObject(value)) return `映射 {${Object.keys(value).join(', ')}}`;
  return JSON.stringify(value);
}

function readIncludeBool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${path} 必须是 true / false，收到 ${describeValue(value)}`);
  }
  return value;
}

/**
 * 校验并归一化 `include` 段。
 *
 * 两种写法都接受：
 *   - `config/connectors.yml`
 *   - `{ path: config/local/models.yml, optional: true, enabled: true }`
 */
export function parseIncludeDirectives(raw: unknown, source: string): IncludeDirective[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError(`${source}: include 必须是数组，收到 ${describeValue(raw)}`, [
      '写法：',
      '  include:',
      '    - config/connectors.yml',
      '    - path: config/local/models.yml',
      '      optional: true',
    ]);
  }

  const out: IncludeDirective[] = [];
  raw.forEach((item, index) => {
    const at = `${source}: include[${index}]`;
    if (typeof item === 'string') {
      const path = item.trim();
      if (path === '') {
        throw new ConfigError(`${at} 的模块路径不能为空`, ['写相对路径，例如 config/connectors.yml']);
      }
      out.push({ path, optional: false, enabled: true });
      return;
    }
    if (!isPlainObject(item)) {
      throw new ConfigError(`${at} 必须是字符串或映射 { path, optional, enabled }`, [
        `收到 ${describeValue(item)}`,
        '示例：- path: config/local/models.yml',
      ]);
    }
    for (const key of Object.keys(item)) {
      if (!INCLUDE_KEYS.includes(key as (typeof INCLUDE_KEYS)[number])) {
        throw new ConfigError(`${at}.${key} 不是可识别的 include 项`, [
          `可用项：${INCLUDE_KEYS.join('、')}`,
          '只写 `- config/xxx.yml` 时不需要任何对象字段',
        ]);
      }
    }
    const pathRaw = item['path'];
    if (typeof pathRaw !== 'string' || pathRaw.trim() === '') {
      throw new ConfigError(`${at}.path 必须是非空字符串`, [
        '示例：- path: config/local/models.yml',
      ]);
    }
    out.push({
      path: pathRaw.trim(),
      optional: readIncludeBool(item['optional'], `${at}.optional`, false),
      enabled: readIncludeBool(item['enabled'], `${at}.enabled`, true),
    });
  });
  return out;
}

/** 把 include 里的路径解析成实际文件路径（相对路径以包含它的文件为基准）。 */
export function resolveIncludePath(specPath: string, fromFile: string): string {
  return isAbsolute(specPath) ? specPath : resolvePath(dirname(fromFile), specPath);
}

/**
 * 深合并两份配置。
 *
 * 规则与 tsconfig 的直觉一致：映射逐层合并，数组和标量由后者整体替换。
 * 例如后加载的模块只写 `onebot.port` 时，不会把前面的 `onebot.host` 抹掉；
 * 但写 `connectors: [onebot]` 会整份替换连接器列表。
 *
 * 不修改入参：合并结果是新对象，方便单测与排障。
 */
export function deepMergeConfig<T extends object>(base: T, patch: T): T {
  return mergeValue(base, patch) as T;
}

function mergeValue(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in out ? mergeValue(out[key], value) : value;
  }
  return out;
}

function identityOf(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolvePath(filePath);
  }
}

/**
 * 读取一个模块文件。
 *
 * `optional` 只对"文件不存在"生效：文件存在但 YAML 坏、是目录、不可读时
 * 仍然报错。把"配置写错"静默跳过的代价是改了没生效，比报错难查得多。
 */
function readModuleText(
  target: string,
  parent: string,
  index: number,
  optional: boolean,
): string | undefined {
  let stat;
  try {
    stat = statSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && optional) return undefined;
    if (code === 'ENOENT') {
      throw new ConfigError(`配置模块不存在：${target}`, [
        `由 ${parent}: include[${index}] 引用`,
        '不需要这个模块就把该 include 行整行注释掉',
        '允许文件缺失（本机可选配置）就写成：- path: <路径>，再加一行 optional: true',
        '如果是升级后缺少 config/ 目录：在仓库根目录执行 git checkout -- config',
        '如果刚升级到模块化配置：先 docker compose up -d 让 ./config 挂载生效（restart 不会加新挂载）',
      ]);
    }
    throw new ConfigError(
      `读取配置模块失败：${target}（${error instanceof Error ? error.message : String(error)}）`,
      [`由 ${parent}: include[${index}] 引用`],
    );
  }

  if (stat.isDirectory()) {
    throw new ConfigError(`配置模块是一个目录，不是文件：${target}`, [
      `由 ${parent}: include[${index}] 引用`,
      '最常见原因：bind mount 的宿主文件不存在时 Docker 会自动建同名目录',
      '在宿主机执行：git checkout -- config（或删掉那个同名目录）',
    ]);
  }

  try {
    return readFileSync(target, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ConfigError(`没有权限读取配置模块：${target}`, [
        '容器以非 root 用户（uid 10001）运行，挂进来的文件必须对其他用户可读',
        `在宿主机执行：chmod 644 ${target}`,
        `由 ${parent}: include[${index}] 引用`,
      ]);
    }
    throw new ConfigError(
      `读取配置模块失败：${target}（${error instanceof Error ? error.message : String(error)}）`,
      [`由 ${parent}: include[${index}] 引用`],
    );
  }
}

function loadOne<T extends object>(
  filePath: string,
  text: string,
  ancestors: string[],
  parseFile: ConfigFileParser<T>,
  files: string[],
): T {
  const identity = identityOf(filePath);
  if (ancestors.includes(identity)) {
    const chain = [...ancestors, identity].join(' → ');
    throw new ConfigError(`配置模块循环引用：${chain}`, [
      '检查这些文件的 include，确认没有把上级文件又包含回来',
      `当前文件：${filePath}`,
    ]);
  }
  if (ancestors.length >= MAX_INCLUDE_DEPTH) {
    throw new ConfigError(`配置模块嵌套超过 ${MAX_INCLUDE_DEPTH} 层：${filePath}`, [
      '正常配置只需要入口 + 一层模块；请检查 include 是否绕成了环或过度分层',
    ]);
  }

  const chain = [...ancestors, identity];
  const document = parseFile(text, filePath);
  let merged = {} as T;
  const seen = new Set<string>();

  for (let index = 0; index < document.includes.length; index += 1) {
    const directive = document.includes[index];
    if (directive === undefined) continue;
    if (!directive.enabled) continue;

    const target = resolveIncludePath(directive.path, filePath);
    const normalized = resolvePath(target);
    if (seen.has(normalized)) {
      throw new ConfigError(`${filePath}: include[${index}] 重复引用了 ${target}`, [
        '同一个文件在一份 include 清单里只写一次',
      ]);
    }
    seen.add(normalized);

    const moduleText = readModuleText(target, filePath, index, directive.optional);
    if (moduleText === undefined) continue;

    const child = loadOne(target, moduleText, chain, parseFile, files);
    merged = deepMergeConfig(merged, child);
  }

  // 入口/父文件自己的配置最后合并：它覆盖所有被 include 的模块。
  merged = deepMergeConfig(merged, document.config);
  files.push(filePath);
  return merged;
}

/**
 * 从根文件文本出发，递归展开 include 并合并成一份配置。
 *
 * 根文件必须已经存在且可读（缺失策略由 config-file.ts 处理，因为默认路径
 * 与 QQ_CONFIG_FILE 显式路径的语义不同）。返回的 `files` 按实际加载顺序排列，
 * 根文件在最后，便于启动日志展示"到底读了哪几份配置"。
 */
export function loadConfigGraph<T extends object>(
  rootPath: string,
  rootText: string,
  parseFile: ConfigFileParser<T>,
): { config: T; files: string[] } {
  const files: string[] = [];
  const config = loadOne(rootPath, rootText, [], parseFile, files);
  return { config, files };
}
