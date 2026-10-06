/**
 * 兴趣池单测（离线：临时目录 + 内存 YAML，不触网）。
 *
 * 锁四件事：
 *   1. 文件缺失 = 空池（合法状态）；显式指定却缺失 = 启动报错；
 *   2. 格式错误的报错**必须具体**（指出哪一条、为什么），因为这是维护者唯一
 *      能看到的反馈渠道；
 *   3. 匹配是字符串包含、大小写不敏感、按文件顺序、不重复；
 *   4. 池的边界（上限、关键词太短、id 重复）都在启动期拦掉。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError } from '../src/config-error.js';
import {
  EMPTY_INTEREST_POOL,
  InterestPool,
  MAX_INTEREST_ENTRIES,
  loadInterestPool,
  parseInterestPool,
} from '../src/pipeline/proactive/interests/pool.js';

const GOOD = `
interests:
  - id: plotting
    topic: 数据可视化
    keywords: [画图, 折线图, matplotlib]
    why: 我能直接给图
    note: 只给结论
  - id: code-debug
    topic: 代码报错
    keywords: [报错, traceback]
`;

describe('兴趣池：解析与校验', () => {
  it('验收1：合法文件解析出条目，顺序与字段完整', () => {
    const pool = parseInterestPool(GOOD, 'test.yml');
    expect(pool.size).toBe(2);
    expect(pool.list()[0]).toEqual({
      id: 'plotting',
      topic: '数据可视化',
      keywords: ['画图', '折线图', 'matplotlib'],
      why: '我能直接给图',
      note: '只给结论',
    });
    expect(pool.list()[1]?.why).toBeUndefined();
  });

  it('验收2：没有 interests 键 / 空列表 = 空池（不报错）', () => {
    expect(parseInterestPool('', 'test.yml').size).toBe(0);
    expect(parseInterestPool('interests: []', 'test.yml').size).toBe(0);
    expect(parseInterestPool('other: 1', 'test.yml').size).toBe(0);
  });

  it('验收3：缺必填字段 / 关键词为空 → 报错并指出是哪一条', () => {
    expect(() => parseInterestPool('interests:\n  - topic: x\n    keywords: [ab]', 'i.yml'))
      .toThrowError(/缺少必填字段 id（第 1 条）/);
    expect(() => parseInterestPool('interests:\n  - id: a\n    topic: x', 'i.yml'))
      .toThrowError(/缺少 keywords/);
    expect(() => parseInterestPool('interests:\n  - id: a\n    topic: x\n    keywords: []', 'i.yml'))
      .toThrowError(/缺少 keywords/);
  });

  it('验收4：id 重复 / 关键词太短 / 超上限 → 启动期拦掉（fail-closed）', () => {
    expect(() =>
      parseInterestPool('interests:\n  - {id: a, topic: x, keywords: [ab]}\n  - {id: a, topic: y, keywords: [cd]}', 'i.yml'),
    ).toThrowError(/id 重复：a/);
    expect(() =>
      parseInterestPool('interests:\n  - {id: a, topic: x, keywords: [图]}', 'i.yml'),
    ).toThrowError(/太短/);

    const many = ['interests:'];
    for (let index = 0; index <= MAX_INTEREST_ENTRIES; index += 1) {
      many.push(`  - {id: i${index}, topic: t${index}, keywords: [kw${index}]}`);
    }
    expect(() => parseInterestPool(many.join('\n'), 'i.yml')).toThrowError(/超过上限/);
  });

  it('验收5：非法 YAML 与非法形状都报 ConfigError（带可操作提示）', () => {
    expect(() => parseInterestPool('interests: [a: b: c', 'i.yml')).toThrowError(ConfigError);
    expect(() => parseInterestPool('interests: not-a-list', 'i.yml')).toThrowError(/必须是数组/);
  });
});

describe('兴趣池：匹配', () => {
  const pool = parseInterestPool(GOOD, 'test.yml');

  it('验收6：字符串包含匹配、大小写不敏感、按文件顺序', () => {
    expect(pool.matchIds('这个折线图怎么画都看不出趋势')).toEqual(['plotting']);
    expect(pool.matchIds('MatPlotLib 报错了')).toEqual(['plotting', 'code-debug']);
    expect(pool.matchIds('无关的一句话')).toEqual([]);
  });

  it('验收7：命中信息带关键词（trace 要能回答"为什么这次命中"）', () => {
    expect(pool.match('又是 traceback')).toEqual([
      { id: 'code-debug', topic: '代码报错', matchedKeyword: 'traceback' },
    ]);
  });

  it('验收8：空文本 / 空池 / 停用 → 恒为空（场景 5 不触发）', () => {
    expect(pool.matchIds('   ')).toEqual([]);
    expect(EMPTY_INTEREST_POOL.matchIds('折线图')).toEqual([]);
    const disabled = new InterestPool(pool.list(), false);
    expect(disabled.matchIds('折线图')).toEqual([]);
  });
});

describe('兴趣池：文件读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'interests-'));

  it('验收9：默认路径缺失 → 空池；显式指定却缺失 → 报错并告诉你怎么去掉这个配置', () => {
    const missing = join(dir, 'nope.yml');
    expect(loadInterestPool({ path: missing }).size).toBe(0);
    expect(() => loadInterestPool({ path: missing, explicit: true })).toThrowError(
      /兴趣池文件不存在/,
    );
  });

  it('验收10：真实文件读取 + enabled 透传', () => {
    const path = join(dir, 'interests.yml');
    writeFileSync(path, GOOD, 'utf8');
    expect(loadInterestPool({ path }).size).toBe(2);
    expect(loadInterestPool({ path, enabled: false }).matchIds('折线图')).toEqual([]);
  });

  it('验收11：路径是目录时给出 Docker bind mount 的可操作提示', () => {
    expect(() => loadInterestPool({ path: dir, explicit: true })).toThrowError(/是一个目录/);
  });
});
