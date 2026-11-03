import { DEFAULT_CONFIG_FILE } from '@qqbot/contracts';
import type { FileConfig, LoadedConfigFile } from '@qqbot/contracts';
/**
 * 配置文件层（`qqbot.yml` 入口 + `config/*.yml` 模块）。
 *
 * 为什么要拆出这一层：`.env` 里塞了 39 个变量，里面**真正敏感的只有 4 个**
 * （QQ_APP_ID / QQ_APP_SECRET / DEEPSEEK_API_KEY / ONEBOT_ACCESS_TOKEN），
 * 其余 35 个是行为参数。混在一起的结果是"重要信息被稀释"——翻半天才找到要改的那行。
 *
 * 配置本身又进一步拆成模块（tsconfig 式 include）：
 *   - `qqbot.yml` 是入口，只声明 include 清单与模块控制；
 *   - `config/*.yml` 各管一块，详细注释跟着模块走；
 *   - `config/local/*.yml` 放本机配置（模型路由等），不进 git。
 *
 * 职责划分：
 *   1. 找到入口文件（QQ_CONFIG_FILE，默认 ./qqbot.yml）并读出 YAML；
 *   2. 展开 include（config-includes.ts），每个文件先独立校验再深合并；
 *   3. 校验形状与类型，拒绝拼错的键名，产出**带类型的 FileConfig**；
 *   4. 语义校验（取值范围、窗口重叠…）留给 config.ts，因为它要在合并 env 之后再判。
 *
 * 优先级：env > 配置文件合并结果 > 代码内置默认。模块之间按 include 顺序，
 * 后加载覆盖先加载；入口文件自己的配置最后合并。之所以让 env 仍然优先，
 * 一是既有部署零破坏（.env 里写着的值照旧生效），二是临时覆盖不用改文件。
 *
 * 本模块**不做**任何 env 合并，也不读 process.env 之外的全局状态：
 * `parseConfigFileText` / `parseConfigDocument` 仍是纯函数，可以直接单测；
 * 只有 `loadConfigFile` 会碰文件系统。
 */
import { readFileSync, statSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import { ConfigError } from '@qqbot/contracts';
import { loadConfigGraph, parseIncludeDirectives } from './config-includes.js';
import type { ParsedConfigDocument } from '@qqbot/contracts';
import { parseModelApiSection } from './dsh/model-config.js';

/** 未设置 QQ_CONFIG_FILE 时默认读的文件（相对进程 CWD）。 */
export { DEFAULT_CONFIG_FILE } from '@qqbot/contracts';

export type { QqOfficialFileConfig } from '@qqbot/contracts';

export type { OnebotFileConfig } from '@qqbot/contracts';

export type { DshFileConfig } from '@qqbot/contracts';

export type { TasksFileConfig } from '@qqbot/contracts';

export type { PoolFileConfig } from '@qqbot/contracts';

/** 话题判定（LLM 判断新消息与既有话题是否相关，见 pipeline/topic-judge.ts）。 */
export type { TopicFileConfig } from '@qqbot/contracts';

export type { PathsFileConfig } from '@qqbot/contracts';

export type { OffpeakFileConfig } from '@qqbot/contracts';

export type { HealthFileConfig } from '@qqbot/contracts';

/** 预设风格前台（`personas:` 段）：/persona 命令可切换的每会话人设。 */
export type { PersonasFileConfig } from '@qqbot/contracts';

/** 长任务提示注入（`hints.longTask`，见 pipeline/hints.ts）。 */
export type { LongTaskHintFileConfig } from '@qqbot/contracts';

export type { HintsFileConfig } from '@qqbot/contracts';

/**
 * 主动发言的配置面（`proactive:` 段）。
 *
 * `interests` 是**场景 5 兴趣池**：整份内容会进 prompt，因此文件本身另存
 * （`proactive.interestsFile`），不塞进本配置文件——它有自己的 schema 与校验
 * （见 `pipeline/proactive/interests/pool.ts`）。
 */
export type { ProactiveFileConfig } from '@qqbot/contracts';

/** 观察窗口（旁听滚窗）的配置面（`observation:` 段）。 */
export type { ObservationFileConfig } from '@qqbot/contracts';

/** 富媒体输入配额（与平台无关，官方/OneBot 共用）。 */
export type { AttachmentsFileConfig } from '@qqbot/contracts';

/** 转发消息块配额（`attachments.forward`）。 */
export type { AttachmentsForwardFileConfig } from '@qqbot/contracts';

/** 文件下载与解析配额（`attachments.files`）。 */
export type { AttachmentsFilesFileConfig } from '@qqbot/contracts';

/** 富媒体出站（agent 产物回发，与平台无关）。 */
export type { MediaFileConfig } from '@qqbot/contracts';

/** 配置文件里允许出现的全部内容（每项都可选）。 */
export type { LoggingFileConfig } from '@qqbot/contracts';
export type { FileConfig } from '@qqbot/contracts';

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
const TASKS_SPEC: SectionSpec = {
  fastTimeoutMs: 'int',
  slowTimeoutMs: 'int',
  fastProvider: 'string',
  fastModel: 'string',
  slowProvider: 'string',
  slowModel: 'string',
  fastRuntimes: 'int',
  slowRuntimes: 'int',
  maxPerSession: 'int',
  maxGlobal: 'int',
  retentionMs: 'int',
  reminderMs: 'int',
};
const POOL_SPEC: SectionSpec = {
  maxConcurrentTurns: 'int',
  maxRuntimes: 'int',
  runtimeIdleMs: 'int',
  replayTurns: 'int',
};
const TOPIC_SPEC: SectionSpec = {
  enabled: 'bool',
  provider: 'string',
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
const PERSONAS_SPEC: SectionSpec = { dir: 'string' };
const LONG_TASK_HINT_SPEC: SectionSpec = {
  enabled: 'bool',
  patterns: 'stringList',
  text: 'string',
};
const HINTS_SPEC: SectionSpec = {};
const PROACTIVE_SPEC: SectionSpec = {
  enabled: 'bool',
  dryRun: 'bool',
  interestsEnabled: 'bool',
  interestsFile: 'string',
  botAliases: 'stringList',
  topicRollMessages: 'int',
  topicRollMs: 'int',
  questionProbeMs: 'int',
  maxWaitPerItem: 'int',
  waitYieldMs: 'int',
  sessionBudget: 'int',
  sessionIdleMs: 'int',
  sessionMinGapMs: 'int',
  judgeTimeoutMs: 'int',
  speakTimeoutMs: 'int',
  bufferMaxMessages: 'int',
  bufferMaxAgeMs: 'int',
};
/** 观察窗口（`observation:` 段；与主动发言的开关无关，见 config.ts 的说明）。 */
const OBSERVATION_SPEC: SectionSpec = {
  maxMessages: 'int',
  maxAgeMs: 'int',
  injectWindowMs: 'int',
  injectImages: 'int',
  injectFiles: 'int',
};
const ATTACHMENTS_SPEC: SectionSpec = {
  enabled: 'bool',
  maxImages: 'int',
  maxImageBytes: 'int',
  maxImageTiles: 'int',
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

const LOGGING_SPEC: SectionSpec = {
  maxRecordBytes: 'int',
  maxQueuedBytes: 'int',
  agentDetailLimit: 'int',
  dedupeWindowMs: 'int',
  diagnosticTraceIds: 'stringList',
  diagnosticSessionKeys: 'stringList',
  diagnosticTtlMs: 'int',
  flushTimeoutMs: 'int',
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
  { yamlKey: 'tasks', field: 'tasks', spec: TASKS_SPEC },
  { yamlKey: 'topic', field: 'topic', spec: TOPIC_SPEC },
  { yamlKey: 'paths', field: 'paths', spec: PATHS_SPEC },
  { yamlKey: 'offpeak', field: 'offpeak', spec: OFFPEAK_SPEC },
  { yamlKey: 'attachments', field: 'attachments', spec: ATTACHMENTS_SPEC },
  { yamlKey: 'media', field: 'media', spec: MEDIA_SPEC },
  { yamlKey: 'logging', field: 'logging', spec: LOGGING_SPEC },
  { yamlKey: 'health', field: 'health', spec: HEALTH_SPEC },
  { yamlKey: 'proactive', field: 'proactive', spec: PROACTIVE_SPEC },
  { yamlKey: 'observation', field: 'observation', spec: OBSERVATION_SPEC },
  { yamlKey: 'personas', field: 'personas', spec: PERSONAS_SPEC },
  { yamlKey: 'hints', field: 'hints', spec: HINTS_SPEC },
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
  hints: { longTask: LONG_TASK_HINT_SPEC },
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
        throw new ConfigError(`${path} 必须是整数，收到 ${describeValue(value)}`, [
          'YAML 里直接写数字，不要加引号：port: 6700（而不是 port: "6700"）',
        ]);
      }
      return value;
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new ConfigError(`${path} 必须是 true / false，收到 ${describeValue(value)}`);
      }
      return value;
    case 'stringList': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new ConfigError(`${path} 必须是字符串数组，收到 ${describeValue(value)}`, [
          '写法：\n  admins:\n    - qq-official:ABCDEF\n    - onebot:123456',
        ]);
      }
      return value as string[];
    }
    case 'windowSpec': {
      // 既接受 "00:00-09:00,12:00-14:00" 也接受 YAML 数组，统一归一成逗号分隔串
      if (typeof value === 'string') return value;
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        return value.join(',');
      }
      throw new ConfigError(`${path} 必须是窗口串或字符串数组，收到 ${describeValue(value)}`, [
        '两种写法都可以：',
        '  windows: 00:00-09:00,12:00-14:00,18:00-24:00',
        '  windows: ["00:00-09:00", "12:00-14:00", "18:00-24:00"]',
      ]);
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
  nestedSpecs: Record<string, SectionSpec> = {}
): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} 必须是一个映射（key: value），收到 ${describeValue(raw)}`);
  }
  const allowed = [...Object.keys(scalarSpec), ...Object.keys(nestedSpecs)];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${path}.${key} 不是可识别的配置项`, [`可用项：${allowed.join('、')}`]);
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

/** 解析 YAML 文本，要求顶层是映射；空文件视为空映射。 */
function parseYamlMapping(text: string, source: string): Record<string, unknown> {
  let root: unknown;
  try {
    root = parseYaml(text);
  } catch (error) {
    throw new ConfigError(
      `${source} 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`,
      ['缩进必须用空格（不能用 Tab）；注意冒号后面要有空格：port: 6700']
    );
  }
  if (root === null || root === undefined) return {}; // 空文件 = 全部走默认
  if (!isPlainObject(root)) {
    throw new ConfigError(`${source} 顶层必须是映射（key: value），收到 ${describeValue(root)}`);
  }
  return root;
}

/**
 * 校验一个已经去掉 `include` 的配置映射。
 *
 * 拆成独立函数是为了让 include 加载层能"每个文件先独立校验、再合并"——
 * 这样报错能指到具体模块文件，而不是合并后的大对象。
 */
function parseConfigObject(raw: Record<string, unknown>, source: string): FileConfig {
  const allowedTop = [...Object.keys(TOP_SCALARS), ...TOP_SECTIONS.map((s) => s.yamlKey), 'models'];
  for (const key of Object.keys(raw)) {
    const rejected = REJECTED_KEYS[key];
    if (rejected !== undefined) {
      throw new ConfigError(`${source}: 配置项 "${key}" 不能写在配置文件里`, rejected);
    }
    if (!allowedTop.includes(key)) {
      throw new ConfigError(`${source}: 未知配置项 "${key}"`, [`可用项：${allowedTop.join('、')}`]);
    }
  }

  const out: FileConfig = {};
  const mutable = out as Record<string, unknown>;
  for (const [key, kind] of Object.entries(TOP_SCALARS)) {
    const value = coerceScalar(raw[key], `${source}: ${key}`, kind);
    if (value !== undefined) mutable[key] = value;
  }
  for (const { yamlKey, field, spec } of TOP_SECTIONS) {
    const nested = NESTED_SECTIONS[yamlKey] ?? {};
    const section = readSection(raw[yamlKey], `${source}: ${yamlKey}`, spec, nested);
    if (Object.keys(section).length > 0) mutable[field] = section;
  }
  // models: 段是结构化嵌套配置（提供商路由字典），由专门的解析器处理
  if (raw['models'] !== undefined && raw['models'] !== null) {
    out.models = parseModelApiSection(raw['models'], `${source}: models`);
  }
  return out;
}

/**
 * 解析一份配置文件：取出 `include` 清单，并校验本文件自己的配置。
 *
 * 这是给 `loadConfigGraph` 用的回调：图遍历负责读其他文件、循环检测与合并，
 * 这里只关心"这一份文件写了什么"。
 */
export function parseConfigDocument(
  text: string,
  source = DEFAULT_CONFIG_FILE
): ParsedConfigDocument<FileConfig> {
  const root = parseYamlMapping(text, source);
  const includes = parseIncludeDirectives(root['include'], source);
  const body: Record<string, unknown> = { ...root };
  delete body['include'];
  return { config: parseConfigObject(body, source), includes };
}

/**
 * 解析单份 YAML 文本为 FileConfig（纯函数，便于单测）。
 *
 * 不含 include 展开：需要模块能力时用 `loadConfigFile`（正常启动路径）。
 * 这里遇到 include 会明确报错，避免调用方以为模块被加载了、实际却被静默忽略。
 *
 * @param source 出错信息里显示的文件名
 */
export function parseConfigFileText(text: string, source = DEFAULT_CONFIG_FILE): FileConfig {
  const { config, includes } = parseConfigDocument(text, source);
  if (includes.length > 0) {
    throw new ConfigError(`${source}: 含 include 的入口文件必须用 loadConfigFile 解析`, [
      'include 会读取并合并其他文件，parseConfigFileText 只负责单份文档',
      '正常启动路径（main.ts）已经使用 loadConfigFile，无需手工调用',
    ]);
  }
  return config;
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
export type { LoadedConfigFile } from '@qqbot/contracts';

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
  env: Record<string, string | undefined> = process.env
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
      `读取配置文件失败：${path}（${error instanceof Error ? error.message : String(error)}）`
    );
  }

  // 入口文件可以 include 模块：每个文件先单独校验，再按声明顺序深合并。
  // 入口自己的配置最后合并（覆盖模块），与 tsconfig 的 extends 直觉一致。
  const graph = loadConfigGraph(path, raw, parseConfigDocument);
  return { path, config: graph.config, files: graph.files };
}
