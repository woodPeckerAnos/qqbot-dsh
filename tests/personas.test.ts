/**
 * 预设风格前台（/persona）单测：预设读取、AGENTS.md 标记区块合并、选择持久化。
 *
 * 全离线：预设目录与工作区都在临时目录里。
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNullLogger } from '../src/logger.js';
import { PersonaStore, PRESET_NAME_RE } from '../src/store/personas.js';
import { ensureStoreDirs, resolveStorePaths, workspacePathFor } from '../src/store/paths.js';

let root: string;
let presetDir: string;
let store: PersonaStore;
const KEY = 'group:ABC123';

function agentsFile(): string {
  return join(workspacePathFor(paths, KEY), 'AGENTS.md');
}

let paths: ReturnType<typeof resolveStorePaths>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qqbot-persona-'));
  paths = resolveStorePaths({
    workspacesRoot: join(root, 'workspaces'),
    stateDir: join(root, 'bot'),
  });
  ensureStoreDirs(paths);
  presetDir = join(root, 'personas');
  mkdirSync(presetDir, { recursive: true });
  writeFileSync(join(presetDir, 'concise.md'), '你在本对话里启用「极简」风格：能一句话说完的绝不用两句。\n');
  writeFileSync(join(presetDir, 'teacher.md'), '你在本对话里启用「讲解员」风格。\n');
  store = new PersonaStore({
    dir: presetDir,
    persistPath: join(paths.stateDir, 'personas.json'),
    paths,
    logger: createNullLogger(),
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('预设清单', () => {
  it('列出目录里的 .md 预设（排序、去掉扩展名）', () => {
    expect(store.listPresets()).toEqual(['concise', 'teacher']);
  });

  it('目录不存在 = 没有可用预设（不抛错）', () => {
    const missing = new PersonaStore({
      dir: join(root, 'nope'),
      persistPath: join(root, 'x.json'),
      paths,
      logger: createNullLogger(),
    });
    expect(missing.listPresets()).toEqual([]);
  });

  it('名字不合规的预设文件不出现在清单里', () => {
    writeFileSync(join(presetDir, 'Bad Name.md'), 'x');
    writeFileSync(join(presetDir, '..evil.md'), 'x');
    expect(store.listPresets()).toEqual(['concise', 'teacher']);
  });
});

describe('切换人设（AGENTS.md 标记区块）', () => {
  it('工作区没有 AGENTS.md 时创建并写入区块', () => {
    const result = store.apply(KEY, 'concise');
    expect(result).toEqual({ ok: true, name: 'concise' });
    const text = readFileSync(agentsFile(), 'utf8');
    expect(text).toContain('<!-- qqbot-persona:begin name="concise" -->');
    expect(text).toContain('极简');
    expect(text).toContain('<!-- qqbot-persona:end -->');
  });

  it('保留管理员在区块外的手写内容', () => {
    mkdirSync(workspacePathFor(paths, KEY), { recursive: true });
    writeFileSync(agentsFile(), '# 本群规矩\n\n- 不许聊政治\n');
    store.apply(KEY, 'concise');
    const text = readFileSync(agentsFile(), 'utf8');
    expect(text).toContain('不许聊政治');
    expect(text).toContain('极简');
    // 手写内容在前、区块在后
    expect(text.indexOf('不许聊政治')).toBeLessThan(text.indexOf('qqbot-persona:begin'));
  });

  it('再次切换只替换区块、不重复追加', () => {
    store.apply(KEY, 'concise');
    store.apply(KEY, 'teacher');
    const text = readFileSync(agentsFile(), 'utf8');
    expect(text).not.toContain('极简');
    expect(text).toContain('讲解员');
    expect(text.match(/qqbot-persona:begin/g)).toHaveLength(1);
    expect(text).toContain('name="teacher"');
  });

  it('clear 移除区块、保留其余内容', () => {
    mkdirSync(workspacePathFor(paths, KEY), { recursive: true });
    writeFileSync(agentsFile(), '# 手写规矩\n');
    store.apply(KEY, 'concise');
    const { hadSelection } = store.clear(KEY);
    expect(hadSelection).toBe(true);
    const text = readFileSync(agentsFile(), 'utf8');
    expect(text).not.toContain('qqbot-persona');
    expect(text).toContain('手写规矩');
  });

  it('未知预设 / 非法名字被拒绝，且不产生任何文件', () => {
    expect(store.apply(KEY, 'nope')).toMatchObject({ ok: false, reason: 'unknown-preset' });
    expect(store.apply(KEY, '../etc/passwd')).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect(existsSync(agentsFile())).toBe(false);
  });

  it('空预设被拒绝', () => {
    writeFileSync(join(presetDir, 'empty.md'), '   \n');
    expect(store.apply(KEY, 'empty')).toMatchObject({ ok: false, reason: 'empty-preset' });
  });
});

describe('选择持久化与启动回放', () => {
  it('重启（新实例）后选择仍在，且 restoreAll 幂等重写区块', () => {
    store.apply(KEY, 'concise');
    const reopened = new PersonaStore({
      dir: presetDir,
      persistPath: join(paths.stateDir, 'personas.json'),
      paths,
      logger: createNullLogger(),
    });
    expect(reopened.current(KEY)).toBe('concise');

    // 模拟"工作区被手工清掉但选择还在"
    rmSync(agentsFile());
    reopened.restoreAll();
    const text = readFileSync(agentsFile(), 'utf8');
    expect(text).toContain('name="concise"');
  });

  it('预设文件已消失的会话：回放时丢弃选择而不是报错', () => {
    store.apply(KEY, 'concise');
    rmSync(join(presetDir, 'concise.md'));
    const reopened = new PersonaStore({
      dir: presetDir,
      persistPath: join(paths.stateDir, 'personas.json'),
      paths,
      logger: createNullLogger(),
    });
    reopened.restoreAll();
    expect(reopened.current(KEY)).toBeUndefined();
  });
});

describe('预设名约束', () => {
  it('正则：小写字母/数字/中划线，32 字符内', () => {
    expect(PRESET_NAME_RE.test('concise')).toBe(true);
    expect(PRESET_NAME_RE.test('a-b-1')).toBe(true);
    expect(PRESET_NAME_RE.test('-bad')).toBe(false);
    expect(PRESET_NAME_RE.test('Bad')).toBe(false);
    expect(PRESET_NAME_RE.test('../x')).toBe(false);
    expect(PRESET_NAME_RE.test('a'.repeat(33))).toBe(false);
  });
});
