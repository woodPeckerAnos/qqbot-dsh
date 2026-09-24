/**
 * 配置校验单测。
 *
 * 配置错误是最"安静"的故障模式（进程在跑、日志正常、就是不干活），
 * 所以每一项硬约束都要有测试守着。
 */

import { describe, expect, it } from 'vitest';

import { ConfigError, describeConfig, loadConfig } from '../src/config.js';
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

  it('谷时段闸默认关闭、默认窗口 00:30-08:30（Asia/Shanghai）', () => {
    const config = loadConfig(baseEnv);
    expect(config.offpeak).toEqual({
      enabled: false,
      start: '00:30',
      end: '08:30',
      timeZone: 'Asia/Shanghai',
      modelPattern: 'deepseek',
      weekendsAllDay: true,
      holidays: [],
    });
  });

  it('谷时段窗口格式非法时起不起不来（配置错误要在启动期爆出来）', () => {
    expect(() => loadConfig({ ...baseEnv, QQ_OFFPEAK_START: '八点半' })).toThrow(/HH:MM/);
    expect(() => loadConfig({ ...baseEnv, QQ_OFFPEAK_END: '24:00' })).toThrow(/超出范围/);
    // 空窗口（起止相同）没有语义，直接拒绝
    expect(() =>
      loadConfig({ ...baseEnv, QQ_OFFPEAK_START: '08:30', QQ_OFFPEAK_END: '08:30' }),
    ).toThrow(/空窗口/);
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
