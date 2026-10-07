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
  fileTransport?: string;
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

/** 话题判定（LLM 判断新消息与既有话题是否相关，见 pipeline/topic-judge.ts）。 */
export interface TopicFileConfig {
  enabled?: boolean;
  apiBase?: string;
  model?: string;
  timeoutMs?: number;
  contextTurns?: number;
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

/**
 * 主动发言的配置面（`proactive:` 段）。
 *
 * `interests` 是**场景 5 兴趣池**：整份内容会进 prompt，因此文件本身另存
 * （`proactive.interestsFile`），不塞进本配置文件——它有自己的 schema 与校验
 * （见 `pipeline/proactive/interests/pool.ts`）。
 */
export interface ProactiveFileConfig {
  enabled?: boolean;
  /** 灰度观察：判定照跑、不真发言（默认 true） */
  dryRun?: boolean;
  interestsEnabled?: boolean;
  interestsFile?: string;
  /** bot 在本群的别名（场景 4 指代检测用），如 ["小助手", "助手酱"] */
  botAliases?: string[];
  /** 话题滚动周期：每多少条旁听消息收敛一次（场景 2/5 的入口） */
  topicRollMessages?: number;
  /** 话题滚动周期：多少毫秒无仲裁则收敛一次 */
  topicRollMs?: number;
  /** 问题挂起多久后探针（场景 3 的答案窗口） */
  questionProbeMs?: number;
  /** 旁听缓冲上限（条）与最长保留时长（毫秒） */
  bufferMaxMessages?: number;
  bufferMaxAgeMs?: number;
}

/** 富媒体输入配额（与平台无关，官方/OneBot 共用）。 */
export interface AttachmentsFileConfig {
  enabled?: boolean;
  maxImages?: number;
  maxImageBytes?: number;
  downloadTimeoutMs?: number;
  forward?: AttachmentsForwardFileConfig;
  files?: AttachmentsFilesFileConfig;
}

/** 转发消息块配额（`attachments.forward`）。 */
export interface AttachmentsForwardFileConfig {
  enabled?: boolean;
  maxNodes?: number;
  maxNodeChars?: number;
  maxChars?: number;
  maxDepth?: number;
  timeoutMs?: number;
}

/** 文件下载与解析配额（`attachments.files`）。 */
export interface AttachmentsFilesFileConfig {
  enabled?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  maxExtractChars?: number;
  maxPdfPages?: number;
  extractTimeoutMs?: number;
  saveToInbox?: boolean;
  inboxDir?: string;
  retentionDays?: number;
  maxInboxMB?: number;
  extractExtensions?: string[];
}

/** 富媒体出站（agent 产物回发，与平台无关）。 */
export interface MediaFileConfig {
  enabled?: boolean;
  maxFileMB?: number;
  maxAttachmentsPerMsg?: number;
  imageExtensions?: string[];
  outboxDir?: string;
}

/** 配置文件里允许出现的全部内容（每项都可选）。 */
export interface FileConfig {
  connectors?: string[];
  qqOfficial?: QqOfficialFileConfig;
  onebot?: OnebotFileConfig;
  dsh?: DshFileConfig;
  pool?: PoolFileConfig;
  topic?: TopicFileConfig;
  paths?: PathsFileConfig;
  offpeak?: OffpeakFileConfig;
  attachments?: AttachmentsFileConfig;
  media?: MediaFileConfig;
  health?: HealthFileConfig;
  proactive?: ProactiveFileConfig;
  logLevel?: string;
}

/**
 * 刻意**不**放进配置文件的键，以及原因。
 *
 * `admins` 是本文件里唯一会带个人标识的配置（真实 QQ 号 / openid）。它放在
 * `.env` 的 `BOT_ADMINS`，这样即使仓库哪天转公开也不会泄露。写在这里直接报错，
 * 而不是靠注释提醒——注释挡不住手快。
 */
const REJECTED_KEYS: Record<string, string[]> = {
  admins: [
    '管理员白名单含真实 QQ 号 / openid，属于个人标识，所以放在 .env 里而不是配置文件',
    '改成在 .env 里写：BOT_ADMINS=qq-official:ABCDEF123456,onebot:123456',
    '环境变量优先级更高，效果完全一样；发现自己身份键：给机器人发 /offpeak whoami',
  ],
};

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
  fileTransport: 'string',
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
const TOPIC_SPEC: SectionSpec = {
  enabled: 'bool',
  apiBase: 'string',
  model: 'string',
  timeoutMs: 'int',
  contextTurns: 'int',
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
const PROACTIVE_SPEC: SectionSpec = {
  enabled: 'bool',
  dryRun: 'bool',
  interestsEnabled: 'bool',
  interestsFile: 'string',
  botAliases: 'stringList',
  topicRollMessages: 'int',
  topicRollMs: 'int',
  questionProbeMs: 'int',
  bufferMaxMessages: 'int',
  bufferMaxAgeMs: 'int',
};
const ATTACHMENTS_SPEC: SectionSpec = {
  enabled: 'bool',
  maxImages: 'int',
  maxImageBytes: 'int',
  downloadTimeoutMs: 'int',
};
/**
 * 转发消息块（`attachments.forward`）。与 `attachments` 顶层标量分开：
 * 键名以 `forward.` / `files.` 开头，启动期校验与报错信息才能指到具体子项。
 */
const ATTACHMENTS_FORWARD_SPEC: SectionSpec = {
  enabled: 'bool',
  maxNodes: 'int',
  maxNodeChars: 'int',
  maxChars: 'int',
  maxDepth: 'int',
  timeoutMs: 'int',
};
/** 文件解析（`attachments.files`）。 */
const ATTACHMENTS_FILES_SPEC: SectionSpec = {
  enabled: 'bool',
  maxFiles: 'int',
  maxFileBytes: 'int',
  maxExtractChars: 'int',
  maxPdfPages: 'int',
  extractTimeoutMs: 'int',
  saveToInbox: 'bool',
  inboxDir: 'string',
  retentionDays: 'int',
  maxInboxMB: 'int',
  extractExtensions: 'stringList',
};
const MEDIA_SPEC: SectionSpec = {
  enabled: 'bool',
  maxFileMB: 'int',
  maxAttachmentsPerMsg: 'int',
  imageExtensions: 'stringList',
  outboxDir: 'string',
};

const TOP_SCALARS: SectionSpec = {
  connectors: 'stringList',
  logLevel: 'string',
};

/** 顶层 section：YAML 里的键名 → FileConfig 里的字段名。 */
const TOP_SECTIONS: Array<{ yamlKey: string; field: keyof FileConfig; spec: SectionSpec }> = [
  { yamlKey: 'qq-official', field: 'qqOfficial', spec: QQ_OFFICIAL_SPEC },
  { yamlKey: 'onebot', field: 'onebot', spec: ONEBOT_SPEC },
  { yamlKey: 'dsh', field: 'dsh', spec: DSH_SPEC },
  { yamlKey: 'pool', field: 'pool', spec: POOL_SPEC },
  { yamlKey: 'topic', field: 'topic', spec: TOPIC_SPEC },
  { yamlKey: 'paths', field: 'paths', spec: PATHS_SPEC },
  { yamlKey: 'offpeak', field: 'offpeak', spec: OFFPEAK_SPEC },
  { yamlKey: 'attachments', field: 'attachments', spec: ATTACHMENTS_SPEC },
  { yamlKey: 'media', field: 'media', spec: MEDIA_SPEC },
  { yamlKey: 'health', field: 'health', spec: HEALTH_SPEC },
  { yamlKey: 'proactive', field: 'proactive', spec: PROACTIVE_SPEC },
];

/**
 * 顶层 section 的嵌套子节：`yamlKey` → 子节名 → 该子节的 spec。
 *
 * 用表而不是把条件写进循环：以后再加一层嵌套只改这里一行，循环体永远只做
 * "读一个 section"这一件事。新增子节时**必须**同时注册，否则该键会被当成
 * 未知项在启动期直接报错（这是刻意的：静默忽略会变成"改了没生效"的玄学问题）。
 */
const NESTED_SECTIONS: Record<string, Record<string, SectionSpec>> = {
  'qq-official': { c2c: QQ_OFFICIAL_C2C_SPEC },
  attachments: { forward: ATTACHMENTS_FORWARD_SPEC, files: ATTACHMENTS_FILES_SPEC },
};

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
    const rejected = REJECTED_KEYS[key];
    if (rejected !== undefined) {
      throw new ConfigError(`${source}: 配置项 "${key}" 不能写在配置文件里`, rejected);
    }
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
    const nested = NESTED_SECTIONS[yamlKey] ?? {};
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
        '最常见原因：bind mount 的宿主文件不存在时，Docker 会自动建一个同名目录',
        'qqbot.yml 是随仓库提供的文件，正常不会缺；先在宿主机删掉那个同名目录，再执行：',
        '  git checkout -- qqbot.yml',
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
    if (code === 'EACCES' || code === 'EPERM') {
      // 容器以非 root（uid 10001）运行，bind mount 进来的宿主文件必须对其他用户可读。
      // git 只记录可执行位、不保证 644，所以这条会随宿主 umask 出现。
      throw new ConfigError(`没有权限读取配置文件：${path}`, [
        '容器以非 root 用户（uid 10001）运行，挂进来的文件必须对其他用户可读',
        `在宿主机执行：chmod 644 ${path}`,
      ]);
    }
    throw new ConfigError(
      `读取配置文件失败：${path}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }

  return { path, config: parseConfigFileText(raw, path) };
}
