/**
 * 配置校验单测。
 *
 * 配置错误是最"安静"的故障模式（进程在跑、日志正常、就是不干活），
 * 所以每一项硬约束都要有测试守着。
 */

import { describe, expect, it } from 'vitest';

import { ConfigError, describeConfig, loadConfig } from '../src/config.js';
import { DEFAULT_INTENTS, Intent, describeIntents } from '../src/qq/types.js';

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
});

describe('describeConfig', () => {
  it('摘要里不含任何密钥', () => {
    const summary = JSON.stringify(describeConfig(loadConfig(baseEnv)));
    expect(summary).not.toContain('secret-1');
    expect(summary).not.toContain('sk-test');
    expect(summary).toContain('deepseek-flash');
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
