/**
 * 配置校验单测。
 *
 * 配置错误是最"安静"的故障模式（进程在跑、日志正常、就是不干活），
 * 所以每一项硬约束都要有测试守着。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ConfigError, describeConfig, loadConfig } from '../src/config.js';
import { parseConfigFileText } from '../src/config-file.js';
import { DEFAULT_INTENTS, Intent, describeIntents } from '../src/adapters/qq-official/types.js';

const baseEnv = {
  QQ_APP_ID: 'app-1',
  QQ_APP_SECRET: 'secret-1',
  DEEPSEEK_API_KEY: 'sk-test',
};

describe('loadConfig', () => {
  it('最小必填项即可加载，并给出一致的默认值', () => {
    const config = loadConfig(baseEnv);
    expect(config.qq.appId).toBe('app-1');
    expect(config.qq.apiBase).toBe('https://api.bot.qq.com');
    expect(config.qq.intents).toBe(DEFAULT_INTENTS);
    expect(config.qq.msgType).toBe(0);
    expect(config.dsh.provider).toBe('deepseek-official');
    expect(config.dsh.model).toBe('deepseek-flash');
    expect(config.pool.replayTurns).toBe(12);
    // 富媒体默认开：DS 模型支持多模态，默认就该用上
    expect(config.attachments).toEqual({
      enabled: true,
      maxImages: 4,
      maxImageBytes: 8 * 1024 * 1024,
      downloadTimeoutMs: 15_000,
      forward: {
        enabled: true,
        maxNodes: 20,
        maxNodeChars: 500,
        maxChars: 4_000,
        maxDepth: 2,
        timeoutMs: 10_000,
      },
      files: {
        enabled: true,
        maxFiles: 2,
        maxFileBytes: 16 * 1024 * 1024,
        maxExtractChars: 20_000,
        maxPdfPages: 30,
        extractTimeoutMs: 10_000,
        saveToInbox: true,
        inboxDir: 'inbox',
        retentionDays: 7,
        maxInboxBytes: 200 * 1024 * 1024,
        extractExtensions: ['pdf', 'txt', 'md', 'csv', 'json', 'yaml', 'yml', 'log', 'xml', 'html'],
      },
    });
  });

  it('转发块与文件的配额可被 env 与配置文件覆盖', () => {
    const fromEnv = loadConfig({
      ...baseEnv,
      BOT_ATTACHMENT_FORWARD_ENABLED: 'false',
      BOT_ATTACHMENT_FORWARD_MAX_NODES: '5',
      BOT_ATTACHMENT_FORWARD_MAX_DEPTH: '0',
      BOT_ATTACHMENT_FILE_MAX_FILES: '0',
      BOT_ATTACHMENT_FILE_SAVE: 'false',
      BOT_ATTACHMENT_INBOX_DIR: 'uploads',
      BOT_ATTACHMENT_INBOX_MAX_MB: '10',
      BOT_ATTACHMENT_FILE_EXTENSIONS: 'pdf,docx',
    });
    expect(fromEnv.attachments.forward).toMatchObject({
      enabled: false,
      maxNodes: 5,
      maxDepth: 0,
    });
    expect(fromEnv.attachments.files).toMatchObject({
      maxFiles: 0,
      saveToInbox: false,
      inboxDir: 'uploads',
      maxInboxBytes: 10 * 1024 * 1024,
      extractExtensions: ['pdf', 'docx'],
    });

    const fromFile = loadConfig(baseEnv, {
      attachments: {
        forward: { maxChars: 1_000 },
        files: { maxPdfPages: 5, extractExtensions: ['PDF', '.TXT'] },
      },
    });
    expect(fromFile.attachments.forward.maxChars).toBe(1_000);
    // 扩展名归一化：大写去掉、前导点去掉
    expect(fromFile.attachments.files.extractExtensions).toEqual(['pdf', 'txt']);
    expect(fromFile.attachments.files.maxPdfPages).toBe(5);

    expect(() => loadConfig({ ...baseEnv, BOT_ATTACHMENT_FORWARD_MAX_NODES: '0' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...baseEnv, BOT_ATTACHMENT_FILE_MAX_CHARS: '10' })).toThrow(
      ConfigError,
    );
  });

  it('会拼进工作区路径的目录名：空串 / 分隔符 / 点目录一律启动期拒绝', () => {
    // 空串是 YAML 里最常见的"改配置忘了填"：'' 不是 nullish，会一路穿过
    // `?? fallback`，而 path.join(ws, '') 恰好等于工作区根——落盘落在工作区根、
    // 清理把 AGENTS.md 与 agent 产物当垃圾删。outboxDir 同理（且会把文件发回用户）。
    // 配置文件里的空串是真正的洞：'' 不是 nullish，会穿过 `?? fallback`
    expect(() =>
      loadConfig(baseEnv, { attachments: { files: { inboxDir: '' } } }),
    ).toThrow(ConfigError);
    expect(() => loadConfig(baseEnv, { media: { outboxDir: '' } })).toThrow(ConfigError);
    // env 里的纯空白视同"没设"（envRaw 会 trim），回落到默认值——这是既有语义
    expect(loadConfig({ ...baseEnv, BOT_ATTACHMENT_INBOX_DIR: '   ' }).attachments.files.inboxDir).toBe(
      'inbox',
    );
    expect(loadConfig({ ...baseEnv, BOT_MEDIA_OUTBOX_DIR: '   ' }).media.outboxDir).toBe('outbox');
    expect(() => loadConfig({ ...baseEnv, BOT_MEDIA_OUTBOX_DIR: 'a/b' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, BOT_MEDIA_OUTBOX_DIR: '.' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, BOT_MEDIA_OUTBOX_DIR: '..' })).toThrow(ConfigError);
  });

  it('inboxDir 必须是纯目录名，且不能与 media.outboxDir 同名', () => {
    // 同名的后果：用户发来的文件被 egress 立刻回发给自己
    expect(() =>
      loadConfig({ ...baseEnv, BOT_ATTACHMENT_INBOX_DIR: 'outbox' }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, BOT_ATTACHMENT_INBOX_DIR: 'a/b' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, BOT_ATTACHMENT_INBOX_DIR: '..' })).toThrow(ConfigError);
    // 改名后同名冲突随之消失
    expect(
      loadConfig({ ...baseEnv, BOT_ATTACHMENT_INBOX_DIR: 'outbox', BOT_MEDIA_OUTBOX_DIR: 'deliverables' })
        .attachments.files.inboxDir,
    ).toBe('outbox');
  });

  it('富媒体参数可被 env 与配置文件覆盖，越界值在启动期被拒', () => {
    const config = loadConfig({ ...baseEnv, BOT_ATTACHMENT_ENABLED: 'false' });
    expect(config.attachments.enabled).toBe(false);
    expect(config.attachments.maxImages).toBe(4);

    const fromFile = loadConfig(baseEnv, {
      attachments: { maxImages: 2, maxImageBytes: 1024 * 1024, downloadTimeoutMs: 3_000 },
    });
    expect(fromFile.attachments).toMatchObject({
      maxImages: 2,
      maxImageBytes: 1024 * 1024,
      downloadTimeoutMs: 3_000,
    });

    expect(() => loadConfig({ ...baseEnv, BOT_ATTACHMENT_MAX_IMAGES: '99' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, BOT_ATTACHMENT_MAX_BYTES: '10' })).toThrow(ConfigError);
  });

  it('缺少必填项时报错并给出修复提示', () => {
    expect(() => loadConfig({ QQ_APP_ID: 'a' })).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (error) {
      expect((error as ConfigError).hints.join(' ')).toMatch(/\.env\.example/);
      expect((error as ConfigError).message).toMatch(/QQ_APP_ID/);
    }
  });

  it('intents 缺少 GROUP_AND_C2C_EVENT 时快速失败（否则收不到任何群消息）', () => {
    expect(() => loadConfig({ ...baseEnv, QQ_INTENTS: String(Intent.GUILDS) })).toThrow(
      /GROUP_AND_C2C_EVENT/,
    );
    // 带上 1<<25 就没问题
    expect(() =>
      loadConfig({ ...baseEnv, QQ_INTENTS: String(Intent.GROUP_AND_C2C_EVENT) }),
    ).not.toThrow();
  });

  it('进度配额必须小于总配额，否则最终答案发不出去', () => {
    expect(() =>
      loadConfig({ ...baseEnv, QQ_MAX_REPLIES_PER_MSG: '3', QQ_PROGRESS_MAX: '3' }),
    ).toThrow(/必须小于/);
  });

  it('单聊有独立默认配额，且遵守官方上限 4 与"进度 < 总额"不变量', () => {
    expect(loadConfig(baseEnv).qq.c2c).toEqual({
      enabled: true,
      maxRepliesPerMsg: 4,
      progressMax: 2,
    });
    expect(() =>
      loadConfig({ ...baseEnv, QQ_C2C_MAX_REPLIES_PER_MSG: '2', QQ_C2C_PROGRESS_MAX: '2' }),
    ).toThrow(/QQ_C2C_PROGRESS_MAX/);
    // 单聊每条消息官方最多回 4 次，配 5 必须被拒绝（群聊才是 5）
    expect(() => loadConfig({ ...baseEnv, QQ_C2C_MAX_REPLIES_PER_MSG: '5' })).toThrow(/必须在/);
  });

  it('QQ_C2C_ENABLED 接受 true/false 与 1/0，其余报错', () => {
    expect(loadConfig({ ...baseEnv, QQ_C2C_ENABLED: 'false' }).qq.c2c.enabled).toBe(false);
    expect(loadConfig({ ...baseEnv, QQ_C2C_ENABLED: '0' }).qq.c2c.enabled).toBe(false);
    expect(loadConfig({ ...baseEnv, QQ_C2C_ENABLED: 'true' }).qq.c2c.enabled).toBe(true);
    expect(() => loadConfig({ ...baseEnv, QQ_C2C_ENABLED: 'maybe' })).toThrow(/true\/false/);
  });

  it('单轮超时必须小于群被动回复窗口 300000ms', () => {
    expect(() => loadConfig({ ...baseEnv, QQ_TURN_TIMEOUT_MS: '300000' })).toThrow(/300000/);
    expect(() => loadConfig({ ...baseEnv, QQ_TURN_TIMEOUT_MS: '240000' })).not.toThrow();
  });

  it('进度触发时刻必须早于单轮超时', () => {
    expect(() =>
      loadConfig({ ...baseEnv, QQ_TURN_TIMEOUT_MS: '60000', QQ_PROGRESS_AFTER_MS: '90000' }),
    ).toThrow(/QQ_PROGRESS_AFTER_MS/);
  });

  it('只接受受支持的 msg_type（群聊不支持 6 打字状态）', () => {
    expect(loadConfig({ ...baseEnv, QQ_MSG_TYPE: '2' }).qq.msgType).toBe(2);
    expect(() => loadConfig({ ...baseEnv, QQ_MSG_TYPE: '6' })).toThrow(/只支持 0.*2/);
  });

  it('整数字段拒绝非法值', () => {
    expect(() => loadConfig({ ...baseEnv, QQ_MAX_CHARS: 'abc' })).toThrow(/必须是整数/);
    expect(() => loadConfig({ ...baseEnv, QQ_MAX_RUNTIMES: '0' })).toThrow(/必须在/);
  });

  it('日志级别只接受枚举值', () => {
    expect(loadConfig({ ...baseEnv, QQ_LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    expect(() => loadConfig({ ...baseEnv, QQ_LOG_LEVEL: 'verbose' })).toThrow(/只能是/);
  });

  it('空字符串按未设置处理', () => {
    const config = loadConfig({ ...baseEnv, QQ_API_BASE: '   ', DSH_MODEL: '' });
    expect(config.qq.apiBase).toBe('https://api.bot.qq.com');
    expect(config.dsh.model).toBe('deepseek-flash');
  });

  it('谷时段闸默认关闭、默认三个窗口（北京 00:00-09:00、12:00-14:00、18:00-24:00）', () => {
    const config = loadConfig(baseEnv);
    expect(config.offpeak).toEqual({
      enabled: false,
      windows: [
        { startMin: 0, endMin: 9 * 60 },
        { startMin: 12 * 60, endMin: 14 * 60 },
        { startMin: 18 * 60, endMin: 24 * 60 },
      ],
      timeZone: 'Asia/Shanghai',
      modelPattern: 'deepseek',
      weekendsAllDay: true,
      holidays: [],
    });
  });

  it('QQ_OFFPEAK_WINDOWS 支持多窗口，非法配置在启动期爆出来', () => {
    expect(
      loadConfig({ ...baseEnv, QQ_OFFPEAK_WINDOWS: '08:00-12:00,22:00-24:00' }).offpeak.windows,
    ).toEqual([
      { startMin: 8 * 60, endMin: 12 * 60 },
      { startMin: 22 * 60, endMin: 24 * 60 },
    ]);
    // 中文逗号分隔也认
    expect(
      loadConfig({ ...baseEnv, QQ_OFFPEAK_WINDOWS: '00:00-09:00，12:00-14:00' }).offpeak.windows,
    ).toHaveLength(2);

    expect(() => loadConfig({ ...baseEnv, QQ_OFFPEAK_WINDOWS: '八点半-九点' })).toThrow(/HH:MM/);
    expect(() => loadConfig({ ...baseEnv, QQ_OFFPEAK_WINDOWS: '00:00-25:00' })).toThrow(/超出范围/);
    // 空窗口（起止相同）没有语义，直接拒绝
    expect(() => loadConfig({ ...baseEnv, QQ_OFFPEAK_WINDOWS: '08:30-08:30' })).toThrow(/空窗口/);
    // 重叠窗口拒绝
    expect(() =>
      loadConfig({ ...baseEnv, QQ_OFFPEAK_WINDOWS: '00:00-09:00,08:00-12:00' }),
    ).toThrow(/重叠/);
    // 全空拒绝
    expect(() => loadConfig({ ...baseEnv, QQ_OFFPEAK_WINDOWS: ' , ' })).toThrow(/不能为空/);
  });

  it('旧的 QQ_OFFPEAK_START / QQ_OFFPEAK_END 仍可用（当单窗口处理），新变量优先', () => {
    expect(
      loadConfig({ ...baseEnv, QQ_OFFPEAK_START: '00:30', QQ_OFFPEAK_END: '08:30' }).offpeak.windows,
    ).toEqual([{ startMin: 30, endMin: 8 * 60 + 30 }]);
    // 只设其中一个时，另一个用旧默认值
    expect(loadConfig({ ...baseEnv, QQ_OFFPEAK_START: '01:00' }).offpeak.windows).toEqual([
      { startMin: 60, endMin: 8 * 60 + 30 },
    ]);
    // 新变量存在时忽略旧变量
    expect(
      loadConfig({
        ...baseEnv,
        QQ_OFFPEAK_WINDOWS: '00:00-09:00',
        QQ_OFFPEAK_START: '00:30',
        QQ_OFFPEAK_END: '08:30',
      }).offpeak.windows,
    ).toEqual([{ startMin: 0, endMin: 9 * 60 }]);
  });

  it('QQ_OFFPEAK_TZ 必须是有效 IANA 时区', () => {
    expect(() => loadConfig({ ...baseEnv, QQ_OFFPEAK_TZ: 'Mars/Olympus_Mons' })).toThrow(
      /不是有效时区/,
    );
    expect(loadConfig({ ...baseEnv, QQ_OFFPEAK_TZ: 'UTC' }).offpeak.timeZone).toBe('UTC');
  });

  it('QQ_OFFPEAK_HOLIDAYS 校验日期合法性（跨年数据由此追加）', () => {
    expect(
      loadConfig({ ...baseEnv, QQ_OFFPEAK_HOLIDAYS: '2027-01-01, 2027-01-02' }).offpeak.holidays,
    ).toEqual(['2027-01-01', '2027-01-02']);
    expect(() => loadConfig({ ...baseEnv, QQ_OFFPEAK_HOLIDAYS: '2027-02-30' })).toThrow(
      /无效日期/,
    );
    expect(() => loadConfig({ ...baseEnv, QQ_OFFPEAK_HOLIDAYS: '元旦' })).toThrow(/无效日期/);
  });

  it('QQ_OFFPEAK_WEEKENDS 默认 true，可显式关闭', () => {
    expect(loadConfig(baseEnv).offpeak.weekendsAllDay).toBe(true);
    expect(loadConfig({ ...baseEnv, QQ_OFFPEAK_WEEKENDS: 'false' }).offpeak.weekendsAllDay).toBe(
      false,
    );
  });

  it('管理员白名单：QQ_ADMIN_OPENIDS 裸 openid 自动补官方平台前缀，默认无管理员（fail-closed）', () => {
    expect(loadConfig(baseEnv).admins).toEqual([]);
    expect(loadConfig({ ...baseEnv, QQ_ADMIN_OPENIDS: ' alice , bob ,, ' }).admins).toEqual([
      'qq-official:alice',
      'qq-official:bob',
    ]);
    expect(
      loadConfig({ ...baseEnv, BOT_ADMINS: 'onebot:123456, qq-official:alice' }).admins,
    ).toEqual(['onebot:123456', 'qq-official:alice']);
  });

  it('BOT_CONNECTORS 默认只启用官方，可并存 OneBot；OneBot 启用时必须有 token', () => {
    expect(loadConfig(baseEnv).connectors).toEqual(['qq-official']);
    // 启用 onebot 后官方必填项可以留空
    const onebotOnly = loadConfig({
      DEEPSEEK_API_KEY: 'sk-test',
      BOT_CONNECTORS: 'onebot',
      ONEBOT_ACCESS_TOKEN: 'tok',
    });
    expect(onebotOnly.connectors).toEqual(['onebot']);
    expect(onebotOnly.qq.appId).toBe('');
    // 并存
    expect(
      loadConfig({ ...baseEnv, BOT_CONNECTORS: 'qq-official,onebot', ONEBOT_ACCESS_TOKEN: 'tok' })
        .connectors,
    ).toEqual(['qq-official', 'onebot']);
    // 缺 token 快速失败
    expect(() => loadConfig({ ...baseEnv, BOT_CONNECTORS: 'onebot' })).toThrow(/ONEBOT_ACCESS_TOKEN/);
    // 未知平台快速失败
    expect(() => loadConfig({ ...baseEnv, BOT_CONNECTORS: 'mirai' })).toThrow(/未知平台/);
  });
});

describe('describeConfig', () => {
  it('摘要里不含任何密钥', () => {
    const summary = JSON.stringify(describeConfig(loadConfig(baseEnv)));
    expect(summary).not.toContain('secret-1');
    expect(summary).not.toContain('sk-test');
    expect(summary).toContain('deepseek-flash');
    expect(summary).toContain('"c2c"');
    // 谷时段窗口要能在启动日志里看到（多窗口拼成可读串）
    expect(summary).toContain('00:00–09:00、12:00–14:00、18:00–24:00');
  });
});

describe('describeIntents', () => {
  it('还原 intent 名称，便于排障', () => {
    const names = describeIntents(DEFAULT_INTENTS);
    expect(names).toContain('GROUP_AND_C2C_EVENT');
    expect(names).toContain('GROUP_MEMBER_EVENT');
  });

  it('空掩码返回空数组', () => {
    expect(describeIntents(0)).toEqual([]);
  });
});

describe('loadConfig 的分层合并（env > qqbot.yml > 内置默认）', () => {
  const secrets = { DEEPSEEK_API_KEY: 'sk-test' };

  it('行为参数可以全部来自配置文件，密钥只认 env', () => {
    const file = parseConfigFileText(`
connectors: [onebot]
onebot:
  host: 127.0.0.1
  port: 7777
  turnTimeoutMs: 300000
  autoAcceptGroupInvite: true
pool:
  maxRuntimes: 3
offpeak:
  enabled: true
  windows: ["23:00-07:00"]
  holidays: ["2027-01-01"]
logLevel: warn
`);
    const config = loadConfig({ ...secrets, ONEBOT_ACCESS_TOKEN: 'tok' }, file);
    expect(config.connectors).toEqual(['onebot']);
    expect(config.onebot.host).toBe('127.0.0.1');
    expect(config.onebot.port).toBe(7777);
    expect(config.onebot.turnTimeoutMs).toBe(300_000);
    expect(config.onebot.autoAcceptGroupInvite).toBe(true);
    expect(config.pool.maxRuntimes).toBe(3);
    expect(config.offpeak.enabled).toBe(true);
    expect(config.offpeak.windows).toEqual([{ startMin: 23 * 60, endMin: 7 * 60 }]);
    expect(config.offpeak.holidays).toEqual(['2027-01-01']);
    expect(config.logLevel).toBe('warn');
  });

  it('env 优先于配置文件（临时覆盖不用改文件）', () => {
    const file = parseConfigFileText(`
connectors: [onebot]
onebot:
  port: 7777
dsh:
  model: from-file
offpeak:
  enabled: true
`);
    const config = loadConfig(
      {
        ...secrets,
        ONEBOT_ACCESS_TOKEN: 'tok',
        ONEBOT_WS_PORT: '8888',
        DSH_MODEL: 'from-env',
        BOT_ADMINS: 'onebot:111',
        QQ_OFFPEAK_ENABLED: 'false',
      },
      file,
    );
    expect(config.onebot.port).toBe(8888);
    expect(config.dsh.model).toBe('from-env');
    expect(config.admins).toEqual(['onebot:111']);
    expect(config.offpeak.enabled).toBe(false);
  });

  it('admins 只来自 env，配置文件里的会被拒绝', () => {
    // 不读文件：这些是真实 QQ 号/openid，不进随仓库提交的配置文件
    expect(() => parseConfigFileText('admins: [onebot:999]\n')).toThrow(/不能写在配置文件里/);
    // 只认 env，且旧变量 QQ_ADMIN_OPENIDS 仍兼容
    const allSecrets = { QQ_APP_ID: 'a', QQ_APP_SECRET: 's', DEEPSEEK_API_KEY: 'k' };
    expect(loadConfig({ ...allSecrets, BOT_ADMINS: 'qq-official:a,onebot:1' }).admins).toEqual([
      'qq-official:a',
      'onebot:1',
    ]);
    expect(loadConfig({ ...allSecrets, QQ_ADMIN_OPENIDS: 'abc,onebot:1' }).admins).toEqual([
      'qq-official:abc',
      'onebot:1',
    ]);
    // 都没设 → 空（fail-closed）
    expect(loadConfig(allSecrets).admins).toEqual([]);
  });

  it('配置文件里的取值越界时，报错信息带上 YAML 路径', () => {
    const file = parseConfigFileText('onebot:\n  port: 99999\n');
    try {
      loadConfig({ ...secrets, ONEBOT_ACCESS_TOKEN: 'tok', BOT_CONNECTORS: 'onebot' }, file);
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('onebot.port');
      expect((error as ConfigError).message).toContain('65535');
    }
  });

  it('密钥不能来自配置文件：只给文件、不给 env 密钥时按缺失报错', () => {
    const file = parseConfigFileText('connectors: [qq-official]\n');
    expect(() => loadConfig({}, file)).toThrow(/QQ_APP_ID/);
    expect(() => loadConfig({ QQ_APP_ID: 'a' }, file)).toThrow(/QQ_APP_SECRET/);
    expect(() => loadConfig({ QQ_APP_ID: 'a', QQ_APP_SECRET: 's' }, file)).toThrow(
      /DEEPSEEK_API_KEY/,
    );
    // onebot 的 access token 同理
    const onebotFile = parseConfigFileText('connectors: [onebot]\n');
    expect(() => loadConfig(secrets, onebotFile)).toThrow(/ONEBOT_ACCESS_TOKEN/);
  });

  it('仓库里的 qqbot.yml 能完整加载（默认配置的守门测试）', () => {
    // 四个密钥都给上，这样无论默认配置启用哪些接入都能通过加载；
    // 只断言"对任何合法取值都成立"的结构性事实——qqbot.yml 是给人改的，
    // 断言具体取值会让用户改完配置后测试反而失败。
    const text = readFileSync(new URL('../qqbot.yml', import.meta.url), 'utf8');
    const file = parseConfigFileText(text, 'qqbot.yml');
    const config = loadConfig(
      {
        QQ_APP_ID: 'app-1',
        QQ_APP_SECRET: 'secret-1',
        DEEPSEEK_API_KEY: 'sk-test',
        ONEBOT_ACCESS_TOKEN: 'token-1',
      },
      file,
    );
    expect(config.connectors.length).toBeGreaterThan(0);
    // 范围校验保证恒成立：turnTimeout 上限 295000
    expect(config.qq.turnTimeoutMs).toBeLessThan(300_000);
    // 空窗口列表会在启动期被拒，所以这里恒非空
    expect(config.offpeak.windows.length).toBeGreaterThan(0);
    expect(config.health.port).toBeGreaterThanOrEqual(0);
  });
});
