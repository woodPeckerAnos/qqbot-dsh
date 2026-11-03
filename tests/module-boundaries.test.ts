import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { CompilerOptions } from 'typescript';
import { checkBoundaries } from '../scripts/check-boundaries.mjs';

interface ModuleFixture {
  id: string;
  entry: string;
  files: string[];
  dependencies: string[];
  capabilities: string[];
}
interface FixtureOptions {
  dependencies?: Record<string, string[]>;
  capabilities?: Record<string, string[]>;
  stateWrites?: {
    type: string;
    domain: string;
    methods: string[];
    owners: string[];
  }[];
  stateProvisioners?: string[];
  compositionRoots?: string[];
  compilerOptions?: CompilerOptions;
  amendModules?: (modules: ModuleFixture[]) => void;
}

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

function checkFixture(files: Record<string, string>, options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-boundary-'));
  roots.push(root);
  const sources = {
    'package.json': '{"type":"module"}',
    'src/a/index.ts': 'export const a = 1;',
    'src/b/index.ts': 'export const b = 1;',
    'src/b/internal.ts': 'export const privateValue = 2;',
    ...files,
  };
  for (const [file, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text.replaceAll('__FIXTURE_ROOT__', root));
  }
  const modules: ModuleFixture[] = ['a', 'b'].map((id) => ({
    id,
    entry: `src/${id}/index.ts`,
    files: Object.keys(sources).filter((file) => file.startsWith(`src/${id}/`)),
    dependencies: options.dependencies?.[id] ?? (id === 'a' ? ['b'] : []),
    capabilities: options.capabilities?.[id] ?? [],
  }));
  options.amendModules?.(modules);
  return checkBoundaries({
    root,
    modules,
    stateWrites: options.stateWrites,
    stateProvisioners: options.stateProvisioners,
    compositionRoots: options.compositionRoots,
    compilerOptions: { baseUrl: root, ...options.compilerOptions },
  }) as { code: string; file: string; line: number; message: string }[];
}

function codes(files: Record<string, string>, options: FixtureOptions = {}) {
  return checkFixture(files, options).map((diagnostic) => diagnostic.code);
}

describe('模块机器边界（独立合成仓库，无存量抑制）', () => {
  it.each([
    "import { privateValue } from '../b/internal.js'; void privateValue;",
    "export { privateValue } from '../b/internal.js';",
    "export * from '../b/internal.js';",
    "const value = require('../b/internal.js'); void value;",
    "const value = import('../b/internal.js'); void value;",
    "import value = require('../b/internal.js'); void value;",
    "export type Internal = typeof import('../b/internal.js');",
  ])('拒绝所有导入形态的跨模块深层引用：%s', (source) => {
    expect(codes({ 'src/a/client.ts': source })).toContain('DEEP_IMPORT');
  });

  it('根据模块解析拒绝绝对路径和别名指向的内部实现', () => {
    const diagnostics = checkFixture({
      'src/a/client.ts': "import { privateValue } from '../b/../b/internal.js'; void privateValue;",
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'DEEP_IMPORT', file: 'src/a/client.ts', line: 1 }),
    ]);
    expect(
      codes({
        'src/a/client.ts':
          "import { privateValue } from '__FIXTURE_ROOT__/src/b/internal.js'; void privateValue;",
      })
    ).toContain('DEEP_IMPORT');
    expect(
      codes(
        {
          'src/a/client.ts':
            "import { privateValue } from '@internal/b/internal.js'; void privateValue;",
        },
        { compilerOptions: { paths: { '@internal/*': ['src/*'] } } }
      )
    ).toContain('DEEP_IMPORT');
  });

  it.each(['import(target);', 'require(target);', 'import(`../b/${name}.js`);'])(
    '拒绝不可静态解析的动态目标：%s',
    (source) => {
      expect(codes({ 'src/a/client.ts': source })).toContain('DYNAMIC_TARGET_UNKNOWN');
    }
  );

  it('同模块协作与显式公共入口符合边界', () => {
    expect(
      codes({
        'src/a/client.ts': "import { b } from '../b/index.js'; void b;",
        'src/b/helper.ts': "import { privateValue } from './internal.js'; void privateValue;",
      })
    ).toEqual([]);
  });

  it('拒绝未声明依赖，即使目标是公共入口', () => {
    expect(
      codes(
        { 'src/a/client.ts': "import { b } from '../b/index.js'; void b;" },
        { dependencies: { a: [] } }
      )
    ).toContain('UNDECLARED_DEPENDENCY');
  });

  it('拒绝模块运行时依赖环，type-only 边不形成运行时环', () => {
    const options = { dependencies: { a: ['b'], b: ['a'] } };
    expect(
      codes(
        {
          'src/a/client.ts': "import { b } from '../b/index.js'; void b;",
          'src/b/client.ts': "import { a } from '../a/index.js'; void a;",
        },
        options
      )
    ).toContain('RUNTIME_DEPENDENCY_CYCLE');
    expect(
      codes(
        {
          'src/a/index.ts': "export type { A } from '../../packages/contracts/src/value.js';",
          'src/b/index.ts': "export type { B } from '../../packages/contracts/src/value.js';",
          'packages/contracts/src/value.ts':
            'export interface A { a: number } export interface B { b: number }',
          'src/a/client.ts': "import type { B } from '../b/index.js'; export type Value = B;",
          'src/b/client.ts': "import { type A } from '../a/index.js'; export type Value = A;",
        },
        options
      )
    ).toEqual([]);
  });

  it.each([
    "export { Internal } from './internal.js';",
    "import { Internal } from './internal.js'; export function create() { return new Internal(); }",
    "import { Internal } from './internal.js'; export function create(): { nested: Internal } { return { nested: new Internal() }; }",
    "import { Internal } from './internal.js'; export type Public = Internal;",
    "import { Internal } from './internal.js'; export interface Public { nested: Internal; }",
    "import { Internal } from './internal.js'; export const create = (): Internal => new Internal();",
  ])('拒绝公共入口泄漏具体实现及嵌套实现类型：%s', (entry) => {
    expect(
      codes({
        'src/b/index.ts': entry,
        'src/b/internal.ts': 'export class Internal { value = 1; }',
      })
    ).toContain('IMPLEMENTATION_EXPORT');
  });

  it('显式契约工厂隔离具体实现类', () => {
    expect(
      codes({
        'src/b/index.ts':
          "import { Internal } from './internal.js'; import type { Value } from '../../packages/contracts/src/value.js'; export const create: () => Value = () => new Internal();",
        'src/b/internal.ts': 'export class Internal { value = 1; }',
        'packages/contracts/src/value.ts': 'export interface Value { readonly value: number; }',
      })
    ).toEqual([]);
  });

  it.each([
    'export interface Local { value: number; }',
    'export type Local = string;',
    'interface Local { value: number; } export const value: readonly Local[] = [];',
    'interface Local { value: number; } export function compute(input: Local): Local { return input; }',
    'interface Local { value: number; } export function compute(): { nested: Local } { return { nested: { value: 1 } }; }',
  ])('公共签名中的命名类型必须源自独立契约：%s', (entry) => {
    expect(codes({ 'src/a/index.ts': entry })).toContain('CONTRACT_TYPE_SOURCE');
  });

  it('公共函数以契约签名绑定实现；内部局部类型与匿名结构可以保留', () => {
    expect(
      codes({
        'packages/contracts/src/value.ts':
          'export interface Value { readonly value: number; } export declare function compute(input: Value): Value;',
        'src/a/local.ts':
          'interface Local { value: number; } export function compute(input: Local): Local { return input; }',
        'src/a/index.ts':
          "import { compute as implementation } from './local.js'; export const compute: typeof import('../../packages/contracts/src/value.js').compute = implementation;",
      })
    ).toEqual([]);
    expect(
      codes({
        'src/a/index.ts':
          'export function compute(value: number): { result: number } { return { result: value }; }',
      })
    ).toEqual([]);
  });

  it('契约包禁止引用生产实现和实现类', () => {
    expect(
      codes({
        'packages/contracts/src/value.ts':
          "import type { privateValue } from '../../../src/b/internal.js'; export class Copy {}",
      })
    ).toEqual(
      expect.arrayContaining([
        'CONTRACT_IMPLEMENTATION_DEPENDENCY',
        'CONTRACT_IMPLEMENTATION_CLASS',
      ])
    );
  });

  it('独立稳定错误属于契约，契约运行时不加载文件或网络能力', () => {
    expect(
      codes({
        'packages/contracts/src/error.ts':
          'export class StableError extends Error { constructor(readonly code: string) { super(code); } }',
      })
    ).toEqual([]);
    expect(
      codes({
        'packages/contracts/src/value.ts':
          "import { readFile } from 'node:fs/promises'; void readFile;",
      })
    ).toContain('CONTRACT_RUNTIME_DEPENDENCY');
    expect(
      codes({
        'packages/contracts/src/value.ts':
          "import type { readFile } from 'node:fs/promises'; export type ReadFile = typeof readFile;",
      })
    ).toEqual([]);
  });

  it('覆盖全部生产文件并拒绝双归属及未知依赖', () => {
    expect(codes({ 'src/unowned.ts': 'export const unowned = 1;' })).toContain(
      'UNCOVERED_PRODUCTION_FILE'
    );
    expect(
      codes({}, { amendModules: (modules) => modules[0]!.files.push('src/b/internal.ts') })
    ).toContain('DUPLICATE_FILE_OWNER');
    expect(codes({}, { dependencies: { a: ['missing'] } })).toContain('UNKNOWN_DEPENDENCY');
  });

  it('指定生产装配入口只访问公共能力；业务模块不能消费装配根', () => {
    const options = { compositionRoots: ['src/main.ts'] };
    expect(
      codes(
        {
          'src/main.ts':
            "import { a } from './a/index.js'; import { b } from './b/index.js'; void [a, b];",
        },
        options
      )
    ).toEqual([]);
    expect(
      codes(
        { 'src/main.ts': "import { privateValue } from './b/internal.js'; void privateValue;" },
        options
      )
    ).toContain('DEEP_IMPORT');
    expect(
      codes(
        {
          'src/main.ts': 'export const value = 1;',
          'src/a/client.ts': "import { value } from '../main.js'; void value;",
        },
        options
      )
    ).toContain('COMPOSITION_IMPORT_DENIED');
  });

  it.each([
    "import { readFile } from 'node:fs/promises'; void readFile;",
    "const child = require('node:child_process'); void child;",
    "import('node:http');",
    "import sharp from 'sharp'; void sharp;",
    "fetch('https://example.invalid');",
    "const request = fetch; request('https://example.invalid');",
    "globalThis.fetch('https://example.invalid');",
    "new WebSocket('wss://example.invalid');",
    "const request = true ? fetch : fetch; request('https://example.invalid');",
  ])('拒绝未分配的外部能力：%s', (source) => {
    expect(codes({ 'src/a/client.ts': source })).toContain('CAPABILITY_DENIED');
  });

  it('类型引用不授予运行能力，本地同名函数不误判为全局能力', () => {
    expect(
      codes({
        'src/a/client.ts':
          "import type { ChildProcess } from 'node:child_process'; function fetch(_url: string) { return 1; } function require(_name: string) { return 1; } fetch('x'); require('x'); export type Child = ChildProcess;",
      })
    ).toEqual([]);
    expect(
      codes(
        {
          'src/a/client.ts':
            "import { readFile } from 'node:fs/promises'; void readFile; fetch('x');",
        },
        { capabilities: { a: ['node:fs/promises', 'fetch'] } }
      )
    ).toEqual([]);
  });

  it('不以声明能力掩盖缺失模块，也不允许通过编译产物读取实现', () => {
    expect(
      codes(
        { 'src/a/client.ts': "require('missing-package');" },
        { capabilities: { a: ['missing-package'] } }
      )
    ).toContain('UNRESOLVED_EXTERNAL_IMPORT');
    expect(
      codes({
        'src/a/client.ts': "require('../../dist/b/internal.js');",
        'dist/b/internal.js': 'export const privateValue = 1;',
      })
    ).toContain('UNRESOLVED_PROJECT_IMPORT');
  });

  const stateContract =
    "export interface StateWriter<T> { load(): T[]; save(records: readonly T[]): void; } export interface TaskSnapshot { id: string; } export interface TaskStateWriter extends StateWriter<TaskSnapshot> { readonly domain?: 'tasks'; }";
  const writerRules = [
    { type: 'TaskStateWriter', domain: 'tasks', methods: ['save'], owners: ['src/a/owner.ts'] },
  ];

  it.each([
    'writer.save([]);',
    "writer['save']([]);",
    'const alias = writer; alias.save([]);',
    'const write = writer.save; write([]);',
    'const { save: write } = writer; write([]);',
    'const write = writer.save.bind(writer); write([]);',
    'const { save } = writer; const write = save.bind(writer); write([]);',
  ])('按契约类型来源拒绝越权写入（包括别名）：%s', (invocation) => {
    expect(
      codes(
        {
          'src/a/client.ts':
            "import type { TaskStateWriter } from '../../packages/contracts/src/state.js'; declare const writer: TaskStateWriter; " +
            invocation,
          'packages/contracts/src/state.ts': stateContract,
        },
        { stateWrites: writerRules }
      )
    ).toContain('STATE_WRITE_DENIED');
  });

  it('只允许所有者写入；同名本地接口不拥有跨模块状态写入能力', () => {
    expect(
      codes(
        {
          'src/a/owner.ts':
            "import type { TaskStateWriter } from '../../packages/contracts/src/state.js'; declare const writer: TaskStateWriter; writer.save([]);",
          'packages/contracts/src/state.ts': stateContract,
        },
        { stateWrites: writerRules }
      )
    ).toEqual([]);
    expect(
      codes(
        {
          'src/a/client.ts':
            'interface TaskStateWriter { save(values: number[]): void; } declare const local: TaskStateWriter; local.save([]);',
        },
        { stateWrites: writerRules }
      )
    ).toEqual([]);
  });

  it('通用写入能力按数据域核验，未知域拒绝写入', () => {
    const source =
      "import type { StateWriter, TaskSnapshot } from '../../packages/contracts/src/state.js'; declare const writer: StateWriter<TaskSnapshot>; writer.save([]);";
    expect(
      codes(
        { 'src/a/client.ts': source, 'packages/contracts/src/state.ts': stateContract },
        { stateWrites: writerRules }
      )
    ).toContain('STATE_WRITE_DENIED');
    expect(
      codes(
        { 'src/a/owner.ts': source, 'packages/contracts/src/state.ts': stateContract },
        { stateWrites: writerRules }
      )
    ).toEqual([]);
    expect(
      codes(
        {
          'src/a/owner.ts': source.replace('StateWriter<TaskSnapshot>', 'StateWriter<string>'),
          'packages/contracts/src/state.ts': stateContract,
        },
        { stateWrites: writerRules }
      )
    ).toContain('STATE_WRITE_DENIED');
  });

  it('状态写入能力只允许指定装配器发放，别名不能绕过', () => {
    const sources = {
      'src/a/client.ts':
        "import { createStateWriter as allocate } from '../../packages/contracts/src/state.js'; const make = allocate; make('tasks');",
      'packages/contracts/src/state.ts':
        'export declare function createStateWriter(domain: string): unknown;',
    };
    expect(codes(sources, { stateProvisioners: [] })).toContain('STATE_PROVISION_DENIED');
    expect(codes(sources, { stateProvisioners: ['src/a/client.ts'] })).toEqual([]);
    expect(
      codes(
        {
          ...sources,
          'src/a/client.ts':
            "import { createStateWriter } from '../../packages/contracts/src/state.js'; const allocate = createStateWriter.bind(null); allocate('tasks');",
        },
        { stateProvisioners: [] }
      )
    ).toContain('STATE_PROVISION_DENIED');
    expect(
      codes(
        {
          ...sources,
          'src/a/client.ts':
            "import type { createStateWriter } from '../../packages/contracts/src/state.js'; export type Factory = typeof createStateWriter;",
        },
        { stateProvisioners: [] }
      )
    ).toEqual([]);
  });
});
