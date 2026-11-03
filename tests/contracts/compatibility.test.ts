import { describe, expect, it } from 'vitest';
import { checkCompatibility } from '../../scripts/check-contract-compatibility.mjs';

function compare(baseline: string, candidate: string) {
  return checkCompatibility({
    baseline: { 'index.d.ts': baseline },
    candidate: { 'index.d.ts': candidate },
  });
}

describe('消费者兼容基线反向检查', () => {
  it('相同声明、可选字段和新增入口保持兼容', () => {
    const baseline =
      'export interface Input { readonly id: string; count?: number }\nexport declare function create(input: Input): { id: string };';
    expect(compare(baseline, baseline)).toEqual([]);
    expect(compare(baseline, `${baseline}\nexport declare function added(): void;`)).toEqual([]);
    expect(
      compare(baseline, baseline.replace('count?: number', 'count?: number; label?: string'))
    ).toEqual([]);
  });

  it.each([
    ['removed export', 'export interface Input { id: string }', 'export {};'],
    [
      'required field removed',
      'export interface Input { id: string; name: string }',
      'export interface Input { id: string }',
    ],
    [
      'required field added',
      'export interface Input { id: string }',
      'export interface Input { id: string; name: string }',
    ],
    [
      'optional made required',
      'export interface Input { id?: string }',
      'export interface Input { id: string }',
    ],
    [
      'field type changed',
      'export interface Input { id: string }',
      'export interface Input { id: number }',
    ],
    [
      'readonly removed',
      'export interface Input { readonly id: string }',
      'export interface Input { id: string }',
    ],
    [
      'generic readonly removed',
      'export interface Box<T> { readonly value: T }',
      'export interface Box<T> { value: T }',
    ],
    [
      'enum value changed',
      'export enum Status { Done = 1, Failed = 2 }',
      'export enum Status { Done = 3, Failed = 2 }',
    ],
    [
      'enum member removed',
      'export type Status = "done" | "failed"',
      'export type Status = "done"',
    ],
    [
      'factory narrowed',
      'export declare function create(input: { id: string | number }): void;',
      'export declare function create(input: { id: string }): void;',
    ],
    [
      'method narrowed',
      'export interface Client { send(id: string | number): void }',
      'export interface Client { send(id: string): void }',
    ],
    [
      'earlier overload narrowed',
      'export interface Client { send(id: number): void; send(id: string): void }',
      'export interface Client { send(id: 1): void; send(id: string): void }',
    ],
  ])('拒绝 %s', (_name, baseline, candidate) => {
    expect(compare(baseline, candidate).length).toBeGreaterThan(0);
  });

  it('工厂扩大已接受输入保持兼容，返回类型改变被拒绝', () => {
    expect(
      compare(
        'export type createFactory = (id: string) => { id: string };',
        'export type createFactory = (id: string | number) => { id: string };'
      )
    ).toEqual([]);
    expect(
      compare(
        'export declare function create(id: string): { id: string };',
        'export declare function create(id: string): { id: number };'
      ).length
    ).toBeGreaterThan(0);
  });

  it('泛型结构、约束和默认值由编译器验证', () => {
    const generic = 'export interface Box<T> { value: T; read(): T }';
    expect(compare(generic, generic)).toEqual([]);
    expect(
      compare(
        'export interface Box<T> { readonly value: T }',
        'export interface Box<T> { readonly value: T; extra?: string }'
      )
    ).toEqual([]);
    expect(compare(generic, generic.replace('read(): T', 'read(): number')).length).toBeGreaterThan(
      0
    );
    expect(
      compare(
        'export interface Box<T> { value: T }',
        'export interface Box<T extends string> { value: T }'
      ).length
    ).toBeGreaterThan(0);
    expect(
      compare(
        'export interface Box<T = string> { value: T }',
        'export interface Box<T = number> { value: T }'
      ).length
    ).toBeGreaterThan(0);
  });

  it('解析再导出和相对声明依赖，不依赖接口文本格式', () => {
    const baseline = {
      'index.d.ts': 'export { Client } from "./client.js";',
      'client.d.ts': 'export interface Client { id: string }',
    };
    const candidate = {
      'index.d.ts': 'export { Client } from "./client.js";',
      'client.d.ts': 'export interface Client {\n/** comment */ id: string; label?: string;\n}',
    };
    expect(checkCompatibility({ baseline, candidate })).toEqual([]);
    expect(
      checkCompatibility({ baseline, candidate: { 'index.d.ts': 'export {};' } }).length
    ).toBeGreaterThan(0);
  });
});
