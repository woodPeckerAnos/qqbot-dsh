/**
 * 配置模块（include）单测。
 *
 * 这一层的价值是"拆分之后仍然管得住"：合并顺序、深合并/数组替换、可选文件、
 * 循环引用、模块内报错定位，全都必须在启动期有确定答案。全部用临时目录 +
 * 真实文件，不依赖仓库里的 config/（CI 与开发者本机的 local 文件可能不同）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError } from '../src/config-error.js';
import { loadConfigFile, parseConfigFileText } from '../src/config-file.js';

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'qqbot-include-'));
  return dir;
}

/** 在临时目录里写一个文件（自动建父目录），返回绝对路径。 */
function writeFile(relative: string, text: string): string {
  if (dir === undefined) throw new Error('先调用 tempDir()');
  const target = join(dir, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf8');
  return target;
}

function load(relative = 'qqbot.yml') {
  if (dir === undefined) throw new Error('先调用 tempDir()');
  return loadConfigFile({ QQ_CONFIG_FILE: join(dir, relative) });
}

describe('include 加载与合并', () => {
  it('按声明顺序合并：后者覆盖前者，入口自己的配置最后覆盖', () => {
    tempDir();
    writeFile(
      'qqbot.yml',
      `
include:
  - config/a.yml
  - config/b.yml
onebot:
  port: 9999
logLevel: warn
`,
    );
    writeFile(
      'config/a.yml',
      `
connectors: [qq-official]
onebot:
  host: 0.0.0.0
  port: 1111
pool:
  maxRuntimes: 2
  replayTurns: 3
offpeak:
  windows: ["00:00-09:00"]
`,
    );
    writeFile(
      'config/b.yml',
      `
connectors: [onebot]
onebot:
  port: 2222
pool:
  maxRuntimes: 8
offpeak:
  windows: ["12:00-14:00"]
`,
    );

    const loaded = load();
    // 数组整体替换，不做拼接
    expect(loaded.config.connectors).toEqual(['onebot']);
    // 映射深合并：b 只写 port，a 的 host 保留；入口再把 port 覆盖掉
    expect(loaded.config.onebot).toMatchObject({ host: '0.0.0.0', port: 9999 });
    expect(loaded.config.pool).toEqual({ maxRuntimes: 8, replayTurns: 3 });
    // windows 数组被归一成 spec 串后再整体替换
    expect(loaded.config.offpeak?.windows).toBe('12:00-14:00');
    expect(loaded.config.logLevel).toBe('warn');
    // files 按加载顺序排列，入口在最后
    expect(loaded.files).toEqual([
      join(dir!, 'config/a.yml'),
      join(dir!, 'config/b.yml'),
      join(dir!, 'qqbot.yml'),
    ]);
  });

  it('嵌套 include 的相对路径相对于"包含它的文件"解析', () => {
    tempDir();
    writeFile('qqbot.yml', 'include:\n  - config/sub/a.yml\n');
    writeFile(
      'config/sub/a.yml',
      `
include:
  - ../b.yml
onebot:
  port: 1234
`,
    );
    writeFile('config/b.yml', 'onebot:\n  host: 0.0.0.0\n  port: 5678\n');

    const loaded = load();
    expect(loaded.config.onebot).toMatchObject({ host: '0.0.0.0', port: 1234 });
  });

  it('optional 缺失时跳过；enabled: false 时不读取也不要求文件存在', () => {
    tempDir();
    writeFile(
      'qqbot.yml',
      `
include:
  - path: config/local/models.yml
    optional: true
  - path: config/skipped.yml
    enabled: false
logLevel: info
`,
    );

    const loaded = load();
    expect(loaded.config.logLevel).toBe('info');
    expect(loaded.files).toEqual([join(dir!, 'qqbot.yml')]);
  });

  it('enabled: false 时不读取文件内容（即使内容非法）', () => {
    tempDir();
    writeFile(
      'qqbot.yml',
      'include:\n  - path: config/skipped.yml\n    enabled: false\n',
    );
    writeFile('config/skipped.yml', 'onebot:\n  portt: 6700\n');

    expect(load().config).toEqual({});
  });

  it('非 optional 缺失时报错，并指出入口与 include 序号', () => {
    tempDir();
    writeFile('qqbot.yml', 'include:\n  - config/nope.yml\n');
    try {
      load();
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toMatch(/配置模块不存在/);
      expect((error as ConfigError).message).toContain('nope.yml');
      expect((error as ConfigError).hints.join(' ')).toContain('include[0]');
      expect((error as ConfigError).hints.join(' ')).toContain('optional: true');
    }
  });

  it('optional 文件存在但内容错时仍然报错（不静默跳过）', () => {
    tempDir();
    writeFile(
      'qqbot.yml',
      'include:\n  - path: config/local/bad.yml\n    optional: true\n',
    );
    writeFile('config/local/bad.yml', 'onebot:\n  port: "6700"\n');
    expect(() => load()).toThrow(/必须是整数/);
  });

  it('模块路径是目录时报错（optional 也不跳过）', () => {
    tempDir();
    writeFile(
      'qqbot.yml',
      'include:\n  - path: config/dir.yml\n    optional: true\n',
    );
    mkdirSync(join(dir!, 'config/dir.yml'), { recursive: true });
    try {
      load();
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toMatch(/是一个目录/);
      expect((error as ConfigError).hints.join(' ')).toContain('git checkout -- config');
    }
  });

  it('同一清单里重复 include 同一个文件时报错', () => {
    tempDir();
    writeFile('qqbot.yml', 'include:\n  - config/a.yml\n  - config/a.yml\n');
    writeFile('config/a.yml', 'logLevel: warn\n');
    expect(() => load()).toThrow(/重复引用/);
  });

  it('循环引用报错并列出链路', () => {
    tempDir();
    writeFile('qqbot.yml', 'include:\n  - config/a.yml\n');
    writeFile('config/a.yml', 'include:\n  - b.yml\n');
    writeFile('config/b.yml', 'include:\n  - a.yml\n');
    try {
      load();
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toMatch(/循环引用/);
      expect((error as ConfigError).message).toContain('a.yml');
      expect((error as ConfigError).message).toContain('b.yml');
    }
  });
});

describe('include 的形状校验', () => {
  it('include 必须是数组', () => {
    expect(() => parseConfigFileText('include: config/a.yml\n')).toThrow(/include 必须是数组/);
  });

  it('对象写法只接受 path / optional / enabled', () => {
    expect(() => parseConfigFileText('include:\n  - p: config/a.yml\n')).toThrow(
      /不是可识别的 include 项/,
    );
    expect(() => parseConfigFileText('include:\n  - path: ""\n')).toThrow(/path 必须是非空字符串/);
    expect(() => parseConfigFileText('include:\n  - path: a.yml\n    optional: yes\n')).toThrow(
      /必须是 true \/ false/,
    );
  });

  it('单文件解析器遇到 include 时明确指向 loadConfigFile', () => {
    expect(() => parseConfigFileText('include:\n  - config/a.yml\n', 'qqbot.yml')).toThrow(
      /loadConfigFile/,
    );
  });
});

describe('向后兼容与错误定位', () => {
  it('没有 include 的旧式单文件配置仍然可以加载', () => {
    tempDir();
    writeFile(
      'legacy.yml',
      `
connectors: [onebot]
onebot:
  host: 0.0.0.0
  port: 6700
logLevel: debug
`,
    );
    const loaded = load('legacy.yml');
    expect(loaded.config.connectors).toEqual(['onebot']);
    expect(loaded.config.onebot).toMatchObject({ host: '0.0.0.0', port: 6700 });
    expect(loaded.config.logLevel).toBe('debug');
    expect(loaded.files).toEqual([join(dir!, 'legacy.yml')]);
  });

  it('模块里的未知键/类型错误，报错信息指向模块文件', () => {
    tempDir();
    writeFile('qqbot.yml', 'include:\n  - config/bad.yml\n');
    writeFile('config/bad.yml', 'onebot:\n  portt: 6700\n');
    try {
      load();
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('config/bad.yml');
      expect((error as ConfigError).message).toContain('portt');
    }
  });
});
