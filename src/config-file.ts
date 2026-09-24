/**
 * 配置文件层（`qqbot.yml`）。
 *
 * 为什么要拆出这一层：`.env` 里塞了 39 个变量，里面**真正敏感的只有 4 个**
 * （QQ_APP_ID / QQ_APP_SECRET / DEEPSEEK_API_KEY / ONEBOT_ACCESS_TOKEN），
 * 其余 35 个是行为参数。混在一起的结果是"重要信息被稀释"——翻半天才找到要改的那行。
 *
 * 职责划分（本模块只管前半段）：
 *   1. 找到文件（QQ_CONFIG_FILE，默认 ./qqbot.yml）并读出 YAML；
 *   2. 校验形状与类型，拒绝拼错的键名，产出**带类型的 FileConfig**；
 *   3. 语义校验（取值范围、窗口重叠…）留给 config.ts，因为它要在合并 env 之后再判。
 *
 * 优先级：env > 本文件 > 代码内置默认。之所以让 env 仍然优先，
 * 一是既有部署零破坏（.env 里写着的值照旧生效），二是临时覆盖不用改文件。
 *
 * 本模块**不做**任何 env 合并，也不读 process.env 之外的全局状态，
 * 所以 `parseConfigFileText` 是纯函数，可以直接单测。
 */

import { readFileSync, statSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import { ConfigError } from './config-error.js';

/** 未设置 QQ_CONFIG_FILE 时默认读的文件（相对进程 CWD）。 */
export const DEFAULT_CONFIG_FILE = 'qqbot.yml';

export interface QqOfficialFileConfig {
  apiBase?: string;
  intents?: number;
  msgType?: number;
  maxChars?: number;
  maxRepliesPerMsg?: number;
  progressMax?: number;
  progressAfterMs?: number;
  progressIntervalMs?: number;
  turnTimeoutMs?: number;
  c2c?: { enabled?: boolean; maxRepliesPerMsg?: number; progressMax?: number };
}

export interface OnebotFileConfig {
  host?: string;
  port?: number;
  c2cEnabled?: boolean;
  autoAcceptFriend?: boolean;
  autoAcceptGroupInvite?: boolean;
  maxChars?: number;
  maxRepliesPerMsg?: number;
  progressMax?: number;
  progressAfterMs?: number;
  progressIntervalMs?: number;
  turnTimeoutMs?: number;
}

export interface DshFileConfig {
  provider?: string;
  model?: string;
  profilePatch?: string;
  bin?: string;
  startTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export interface PoolFileConfig {
  maxConcurrentTurns?: number;
  maxRuntimes?: number;
  runtimeIdleMs?: number;
  replayTurns?: number;
}

export interface PathsFileConfig {
  dshHome?: string;
  workspacesRoot?: string;
  stateDir?: string;
}

export interface OffpeakFileConfig {
  enabled?: boolean;
  /** 谷时段窗口：写成逗号分隔的字符串，或 YAML 数组（两种都会归一成一个 spec 串） */
  windows?: string;
  timeZone?: string;
  modelPattern?: string;
  weekendsAllDay?: boolean;
  holidays?: string[];
}

export interface HealthFileConfig {
  port?: number;
}

/** 配置文件里允许出现的全部内容（每项都可选）。 */
export interface FileConfig {
  connectors?: string[];
  qqOfficial?: QqOfficialFileConfig;
  onebot?: OnebotFileConfig;
  dsh?: DshFileConfig;
  pool?: PoolFileConfig;
  paths?: PathsFileConfig;
  admins?: string[];
  offpeak?: OffpeakFileConfig;
  health?: HealthFileConfig;
  logLevel?: string;
}

// ---------------------------------------------------------------------------
// 形状校验
// ---------------------------------------------------------------------------

/** 标量字段种类。`windowSpec` 额外接受字符串数组。 */
type Kind = 'string' | 'int' | 'bool' | 'stringList' | 'windowSpec';
type SectionSpec = Record<string, Kind>;

const QQ_OFFICIAL_SPEC: SectionSpec = {
  apiBase: 'string',
  intents: 'int',
  msgType: 'int',
  maxChars: 'int',
  maxRepliesPerMsg: 'int',
  progressMax: 'int',
  progressAfterMs: 'int',
  progressIntervalMs: 'int',
  turnTimeoutMs: 'int',
};
const QQ_OFFICIAL_C2C_SPEC: SectionSpec = {
  enabled: 'bool',
  maxRepliesPerMsg: 'int',
  progressMax: 'int',
};
const ONEBOT_SPEC: SectionSpec = {
  host: 'string',
  port: 'int',
  c2cEnabled: 'bool',
  autoAcceptFriend: 'bool',
  autoAcceptGroupInvite: 'bool',
  maxChars: 'int',
  maxRepliesPerMsg: 'int',
  progressMax: 'int',
  progressAfterMs: 'int',
  progressIntervalMs: 'int',
  turnTimeoutMs: 'int',
};
const DSH_SPEC: SectionSpec = {
  provider: 'string',
  model: 'string',
  profilePatch: 'string',
  bin: 'string',
  startTimeoutMs: 'int',
  shutdownTimeoutMs: 'int',
};
const POOL_SPEC: SectionSpec = {
  maxConcurrentTurns: 'int',
  maxRuntimes: 'int',
  runtimeIdleMs: 'int',
  replayTurns: 'int',
};
const PATHS_SPEC: SectionSpec = {
  dshHome: 'string',
  workspacesRoot: 'string',
  stateDir: 'string',
};
const OFFPEAK_SPEC: SectionSpec = {
  enabled: 'bool',
  windows: 'windowSpec',
  timeZone: 'string',
  modelPattern: 'string',
  weekendsAllDay: 'bool',
  holidays: 'stringList',
};
const HEALTH_SPEC: SectionSpec = { port: 'int' };

const TOP_SCALARS: SectionSpec = {
  connectors: 'stringList',
  admins: 'stringList',
  logLevel: 'string',
};

/** 顶层 section：YAML 里的键名 → FileConfig 里的字段名。 */
const TOP_SECTIONS: Array<{ yamlKey: string; field: keyof FileConfig; spec: SectionSpec }> = [
  { yamlKey: 'qq-official', field: 'qqOfficial', spec: QQ_OFFICIAL_SPEC },
  { yamlKey: 'onebot', field: 'onebot', spec: ONEBOT_SPEC },
  { yamlKey: 'dsh', field: 'dsh', spec: DSH_SPEC },
  { yamlKey: 'pool', field: 'pool', spec: POOL_SPEC },
  { yamlKey: 'paths', field: 'paths', spec: PATHS_SPEC },
  { yamlKey: 'offpeak', field: 'offpeak', spec: OFFPEAK_SPEC },
  { yamlKey: 'health', field: 'health', spec: HEALTH_SPEC },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验并转换一个标量。`undefined` 表示"没写这一项"。 */
function coerceScalar(value: unknown, path: string, kind: Kind): unknown {
  if (value === undefined || value === null) return undefined;
  switch (kind) {
    case 'string':
      if (typeof value !== 'string') {
        throw new ConfigError(`${path} 必须是字符串，收到 ${describeValue(value)}`);
      }
      return value;
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new ConfigError(
          `${path} 必须是整数，收到 ${describeValue(value)}`,
          ['YAML 里直接写数字，不要加引号：port: 6700（而不是 port: "6700"）'],
        );
      }
      return value;
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new ConfigError(`${path} 必须是 true / false，收到 ${describeValue(value)}`);
      }
      return value;
    case 'stringList': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new ConfigError(
          `${path} 必须是字符串数组，收到 ${describeValue(value)}`,
          ['写法：\n  admins:\n    - qq-official:ABCDEF\n    - onebot:123456'],
        );
      }
      return value as string[];
    }
    case 'windowSpec': {
      // 既接受 "00:00-09:00,12:00-14:00" 也接受 YAML 数组，统一归一成逗号分隔串
      if (typeof value === 'string') return value;
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        return (value as string[]).join(',');
      }
      throw new ConfigError(
        `${path} 必须是窗口串或字符串数组，收到 ${describeValue(value)}`,
        [
          '两种写法都可以：',
          '  windows: 00:00-09:00,12:00-14:00,18:00-24:00',
          '  windows: ["00:00-09:00", "12:00-14:00", "18:00-24:00"]',
        ],
      );
    }
  }
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `数组 [${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  if (isPlainObject(value)) return `映射 {${Object.keys(value).join(', ')}}`;
  return JSON.stringify(value);
}

/**
 * 读一个 section：先拒绝未知键（拼错的键名如果静默忽略，会变成"改了没生效"的
 * 玄学问题），再逐项校验类型。空 section 返回空对象。
 */
function readSection(
  raw: unknown,
  path: string,
  scalarSpec: SectionSpec,
  nestedSpecs: Record<string, SectionSpec> = {},
): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} 必须是一个映射（key: value），收到 ${describeValue(raw)}`);
  }
  const allowed = [...Object.keys(scalarSpec), ...Object.keys(nestedSpecs)];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${path}.${key} 不是可识别的配置项`, [
        `可用项：${allowed.join('、')}`,
      ]);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(scalarSpec)) {
    const value = coerceScalar(raw[key], `${path}.${key}`, kind);
    if (value !== undefined) out[key] = value;
  }
  for (const [key, spec] of Object.entries(nestedSpecs)) {
    const nested = readSection(raw[key], `${path}.${key}`, spec);
    if (Object.keys(nested).length > 0) out[key] = nested;
  }
  return out;
}

/**
 * 解析 YAML 文本为 FileConfig（纯函数，便于单测）。
 * @param source 出错信息里显示的文件名
 */
export function parseConfigFileText(text: string, source = DEFAULT_CONFIG_FILE): FileConfig {
  let root: unknown;
  try {
    root = parseYaml(text);
  } catch (error) {
    throw new ConfigError(
      `${source} 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`,
      ['缩进必须用空格（不能用 Tab）；注意冒号后面要有空格：port: 6700'],
    );
  }
  if (root === null || root === undefined) return {}; // 空文件 = 全部走默认
  if (!isPlainObject(root)) {
    throw new ConfigError(`${source} 顶层必须是映射（key: value），收到 ${describeValue(root)}`);
  }

  const allowedTop = [...Object.keys(TOP_SCALARS), ...TOP_SECTIONS.map((s) => s.yamlKey)];
  for (const key of Object.keys(root)) {
    if (!allowedTop.includes(key)) {
      throw new ConfigError(`${source}: 未知配置项 "${key}"`, [
        `可用项：${allowedTop.join('、')}`,
      ]);
    }
  }

  const out: FileConfig = {};
  const mutable = out as Record<string, unknown>;
  for (const [key, kind] of Object.entries(TOP_SCALARS)) {
    const value = coerceScalar(root[key], `${source}: ${key}`, kind);
    if (value !== undefined) mutable[key] = value;
  }
  for (const { yamlKey, field, spec } of TOP_SECTIONS) {
    const nested: Record<string, SectionSpec> =
      yamlKey === 'qq-official' ? { c2c: QQ_OFFICIAL_C2C_SPEC } : {};
    const section = readSection(root[yamlKey], `${source}: ${yamlKey}`, spec, nested);
    if (Object.keys(section).length > 0) mutable[field] = section;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 文件读取
// ---------------------------------------------------------------------------

/** 解析配置文件的路径。`explicit` 表示是用户显式设的（决定文件缺失时是否报错）。 */
export function resolveConfigFilePath(env: Record<string, string | undefined>): {
  path: string;
  explicit: boolean;
} {
  const raw = env['QQ_CONFIG_FILE'];
  if (raw !== undefined && raw.trim() !== '') return { path: raw.trim(), explicit: true };
  return { path: DEFAULT_CONFIG_FILE, explicit: false };
}

/** `loadConfigFile` 的结果：实际用到的文件路径 + 解析出来的配置。 */
export interface LoadedConfigFile {
  /** 真正读到的文件路径；没使用配置文件时为 undefined */
  path?: string;
  config: FileConfig;
}

/**
 * 读取并解析配置文件。
 *
 * 缺文件的策略：
 *   - QQ_CONFIG_FILE 显式设了 → 文件必须存在，缺失直接报错（免得静默跑在默认值上）；
 *   - 没设（用的是默认路径）→ 文件不存在视为"没有配置文件"，返回空配置。
 *
 * 另外防一个 Docker 特有的坑：bind mount 的宿主文件不存在时，Docker 会**自动建一个
 * 同名目录**，于是容器里那个路径是个目录。这种情况给出可操作的提示，而不是含糊的
 * EISDIR。
 */
export function loadConfigFile(
  env: Record<string, string | undefined> = process.env,
): LoadedConfigFile {
  const { path, explicit } = resolveConfigFilePath(env);

  let raw: string;
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      throw new ConfigError(`${path} 是一个目录，不是文件`, [
        '最常见原因：docker-compose 里 bind mount 的宿主文件不存在，Docker 自动建了同名目录',
        '先在宿主机删掉那个同名目录（它是 Docker 建的，不是你的文件），再执行：',
        '  cp qqbot.example.yml qqbot.yml && chmod 644 qqbot.yml',
      ]);
    }
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      if (!explicit) return { config: {} };
      throw new ConfigError(`配置文件不存在：${path}`, [
        'QQ_CONFIG_FILE 指向的文件必须存在；不想用配置文件就别设这个变量',
      ]);
    }
    throw new ConfigError(
      `读取配置文件失败：${path}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }

  return { path, config: parseConfigFileText(raw, path) };
}
