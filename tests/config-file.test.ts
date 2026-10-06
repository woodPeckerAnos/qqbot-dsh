/**
 * 配置文件层单测（YAML 解析 + 形状校验 + 读取策略，全离线）。
 *
 * 这一层的价值在于"配置写错了要在启动期炸"：键名拼错、类型写错、YAML 缩进错，
 * 都必须给出能直接照做的报错，而不是静默用默认值跑起来。
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError } from '../src/config-error.js';
import {
  DEFAULT_CONFIG_FILE,
  loadConfigFile,
  parseConfigFileText,
  resolveConfigFilePath,
} from '../src/config-file.js';

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'qqbot-cfg-'));
  return dir;
}

describe('parseConfigFileText', () => {
  it('解析完整配置并映射到 FileConfig 字段', () => {
    const config = parseConfigFileText(
      `
connectors: [qq-official, onebot]
logLevel: debug
qq-official:
  intents: 50331648
  msgType: 0
  c2c:
    enabled: false
    progressMax: 1
onebot:
  host: 0.0.0.0
  port: 6700
  autoAcceptGroupInvite: true
dsh:
  provider: deepseek-official
  model: deepseek-flash
pool:
  maxRuntimes: 8
paths:
  stateDir: /data/bot
offpeak:
  enabled: true
  windows: 00:00-09:00,12:00-14:00
  holidays: ["2027-01-01"]
health:
  port: 8080
`,
      'test.yml',
    );
    expect(config.connectors).toEqual(['qq-official', 'onebot']);
    expect(config.logLevel).toBe('debug');
    expect(config.qqOfficial).toMatchObject({ intents: 50331648, msgType: 0 });
    expect(config.qqOfficial?.c2c).toEqual({ enabled: false, progressMax: 1 });
    expect(config.onebot).toMatchObject({ host: '0.0.0.0', port: 6700, autoAcceptGroupInvite: true });
    expect(config.dsh).toMatchObject({ provider: 'deepseek-official' });
    expect(config.pool).toEqual({ maxRuntimes: 8 });
    expect(config.paths).toEqual({ stateDir: '/data/bot' });
    expect(config.offpeak).toMatchObject({ enabled: true, windows: '00:00-09:00,12:00-14:00' });
    expect(config.health).toEqual({ port: 8080 });
  });

  it('窗口支持字符串与数组两种写法，都归一成 spec 串', () => {
    const asString = parseConfigFileText('offpeak:\n  windows: 00:00-09:00,12:00-14:00\n');
    expect(asString.offpeak?.windows).toBe('00:00-09:00,12:00-14:00');

    const asArray = parseConfigFileText(
      'offpeak:\n  windows:\n    - 00:00-09:00\n    - "12:00-14:00"\n    - 18:00-24:00\n',
    );
    expect(asArray.offpeak?.windows).toBe('00:00-09:00,12:00-14:00,18:00-24:00');
  });

  it('空文件与只有注释的文件视为"没有配置"', () => {
    expect(parseConfigFileText('')).toEqual({});
    expect(parseConfigFileText('# 只有注释\n')).toEqual({});
    expect(parseConfigFileText('\n\n')).toEqual({});
  });

  it('顶层不是映射时报错', () => {
    expect(() => parseConfigFileText('- a\n- b\n')).toThrow(/顶层必须是映射/);
    expect(() => parseConfigFileText('就一行文本')).toThrow(/顶层必须是映射/);
  });

  it('YAML 语法错时报错并提示缩进/冒号', () => {
    // Tab 缩进是 YAML 的经典错误
    expect(() => parseConfigFileText('onebot:\n\tport: 6700\n')).toThrow(/不是合法 YAML/);
    try {
      parseConfigFileText('onebot:\n\tport: 6700\n');
    } catch (error) {
      expect((error as ConfigError).hints.join(' ')).toMatch(/缩进必须用空格/);
    }
  });

  it('键名拼错时拒绝并列出可用项（否则会静默用默认值）', () => {
    // 顶层
    try {
      parseConfigFileText('oneboot:\n  port: 6700\n');
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('oneboot');
      expect((error as ConfigError).hints.join(' ')).toContain('onebot');
    }
    // 嵌套
    expect(() => parseConfigFileText('onebot:\n  portt: 6700\n')).toThrow(/不是可识别的配置项/);
    expect(() => parseConfigFileText('offpeak:\n  window: x\n')).toThrow(/不是可识别的配置项/);
  });

  it('类型写错时给出该类型的正确写法提示', () => {
    // 整数写成了字符串
    try {
      parseConfigFileText('onebot:\n  port: "6700"\n');
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as ConfigError).message).toMatch(/必须是整数/);
      expect((error as ConfigError).hints.join(' ')).toMatch(/不要加引号/);
    }
    expect(() => parseConfigFileText('onebot:\n  c2cEnabled: yes\n')).toThrow(/必须是 true \/ false/);
    expect(() => parseConfigFileText('connectors: qq-official\n')).toThrow(/必须是字符串数组/);
    expect(() => parseConfigFileText('offpeak:\n  windows: 123\n')).toThrow(/窗口串或字符串数组/);
  });

  it('admins 不接受写在配置文件里（含真实 QQ 号，应放 .env 的 BOT_ADMINS）', () => {
    for (const text of ['admins: []\n', 'admins:\n  - onebot:123456\n']) {
      try {
        parseConfigFileText(text, 'qqbot.yml');
        throw new Error('应当抛错');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).toMatch(/不能写在配置文件里/);
        const hints = (error as ConfigError).hints.join(' ');
        expect(hints).toContain('BOT_ADMINS');
        expect(hints).toContain('.env');
      }
    }
  });

  it('section 不是映射时报错', () => {
    expect(() => parseConfigFileText('onebot: 6700\n')).toThrow(/必须是一个映射/);
  });
});

describe('resolveConfigFilePath', () => {
  it('默认路径与显式路径', () => {
    expect(resolveConfigFilePath({})).toEqual({ path: DEFAULT_CONFIG_FILE, explicit: false });
    expect(resolveConfigFilePath({ QQ_CONFIG_FILE: ' /etc/qqbot.yml ' })).toEqual({
      path: '/etc/qqbot.yml',
      explicit: true,
    });
    // 空串视为没设
    expect(resolveConfigFilePath({ QQ_CONFIG_FILE: '  ' }).explicit).toBe(false);
  });
});

describe('loadConfigFile', () => {
  it('默认路径下文件不存在 → 视为没有配置文件，不报错', () => {
    // 默认路径是相对 CWD 的，所以切到一个空目录里测
    const cwd = process.cwd();
    const empty = tempDir();
    try {
      process.chdir(empty);
      expect(loadConfigFile({})).toEqual({ config: {} });
    } finally {
      process.chdir(cwd);
    }
  });

  it('显式指定的文件不存在 → 报错（免得静默跑在默认值上）', () => {
    const missing = join(tempDir(), 'nope.yml');
    expect(() => loadConfigFile({ QQ_CONFIG_FILE: missing })).toThrow(/配置文件不存在/);
  });

  it('读得到文件时返回路径与解析结果', () => {
    const target = join(tempDir(), 'qqbot.yml');
    writeFileSync(target, 'logLevel: warn\n', 'utf8');
    const loaded = loadConfigFile({ QQ_CONFIG_FILE: target });
    expect(loaded.path).toBe(target);
    expect(loaded.config.logLevel).toBe('warn');
  });

  it('路径是目录时给出 Docker bind mount 的可操作提示', () => {
    const asDir = tempDir();
    try {
      loadConfigFile({ QQ_CONFIG_FILE: asDir });
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toMatch(/是一个目录/);
      const hints = (error as ConfigError).hints.join(' ');
      expect(hints).toMatch(/Docker/);
      expect(hints).toMatch(/git checkout -- qqbot\.yml/);
    }
  });

  it('文件不可读时提示 chmod（容器以非 root 运行，宿主文件必须可被其他用户读）', () => {
    // root 无视权限位，若以 root 跑测试就跳过（Docker CI 里可能是 root）
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const target = join(tempDir(), 'qqbot.yml');
    writeFileSync(target, 'logLevel: warn\n', { encoding: 'utf8', mode: 0o000 });
    try {
      loadConfigFile({ QQ_CONFIG_FILE: target });
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toMatch(/没有权限读取配置文件/);
      expect((error as ConfigError).hints.join(' ')).toMatch(/chmod 644/);
    } finally {
      chmodSync(target, 0o644); // 让 afterEach 的 rmSync 删得掉
    }
  });

  it('仓库里的 qqbot.yml 能通过形状校验（默认配置与 schema 不许漂移）', () => {
    // qqbot.yml 是随仓库提供的默认配置，也是用户会按机器改的文件，
    // 所以这里只校验"形状合法"（键名、类型），不校验具体取值——
    // 否则用户把 connectors 改成 onebot 之后，测试反而会失败。
    const text = readFileSync(new URL('../qqbot.yml', import.meta.url), 'utf8');
    expect(() => parseConfigFileText(text, 'qqbot.yml')).not.toThrow();
  });
});

describe('嵌套子节的未知键', () => {
  it('attachments 下未注册的子节在解析期直接报错', () => {
    // NESTED_SECTIONS 的重构把"子节必须注册"变成了表驱动——这条守住它：
    // 少注册一个子节，该键会被当成未知项，而不是静默忽略（"改了没生效"最难查）。
    expect(() => parseConfigFileText('attachments:\n  forward2:\n    maxNodes: 3\n')).toThrow(
      ConfigError,
    );
    expect(() => parseConfigFileText('attachments:\n  files:\n    noSuchKey: 1\n')).toThrow(
      ConfigError,
    );
    // 已注册的子节正常通过
    const file = parseConfigFileText('attachments:\n  forward:\n    maxNodes: 3\n');
    expect(file.attachments?.forward?.maxNodes).toBe(3);
  });
});
