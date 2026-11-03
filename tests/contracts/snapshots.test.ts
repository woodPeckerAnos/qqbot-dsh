import { describe, expect, it } from 'vitest';
import { readonlySnapshot } from '@qqbot/contracts';

describe('深只读快照的值与引用边界', () => {
  it('数组、对象及 symbol 属性隔离输入，嵌套写入与结构修改被拒绝', () => {
    const symbol = Symbol('metadata');
    const input = { rows: [{ value: 1 }], nested: { value: 2 }, [symbol]: { value: 3 } };
    const snapshot = readonlySnapshot(input);
    input.rows[0]!.value = 9;
    input.nested.value = 9;
    input[symbol].value = 9;
    expect(snapshot.rows[0]!.value).toBe(1);
    expect(snapshot.nested.value).toBe(2);
    expect(snapshot[symbol].value).toBe(3);
    expect(() => Object.assign(snapshot.rows[0]!, { value: 8 })).toThrow(TypeError);
    expect(() => (snapshot.rows as unknown as { value: number }[]).push({ value: 4 })).toThrow(
      TypeError
    );
    expect(() => Object.defineProperty(snapshot, 'extra', { value: 4 })).toThrow(TypeError);
    expect(Reflect.deleteProperty(snapshot.nested, 'value')).toBe(false);
    expect(snapshot.nested.value).toBe(2);
    expect(() => Object.setPrototypeOf(snapshot, {})).toThrow(TypeError);
  });

  it('稀疏数组保留原长度与空槽', () => {
    const input = new Array<number>(5);
    input[1] = 7;
    const snapshot = readonlySnapshot(input);
    expect(snapshot.length).toBe(5);
    expect(0 in snapshot).toBe(false);
    expect(1 in snapshot).toBe(true);
    expect(4 in snapshot).toBe(false);
    expect(snapshot[1]).toBe(7);
  });

  it('Map 的键和值深只读，原生 mutator 和回调不能获取内部目标', () => {
    const key = { id: 1 };
    const value = { text: 'original' };
    const input = new Map([[key, value]]);
    const snapshot = readonlySnapshot(input);
    key.id = 2;
    value.text = 'changed';
    input.set({ id: 3 }, { text: 'added' });
    expect(snapshot.size).toBe(1);
    const [copyKey, copyValue] = [...snapshot.entries()][0]!;
    expect(copyKey.id).toBe(1);
    expect(copyValue.text).toBe('original');
    expect(snapshot.get(copyKey)).toBe(copyValue);
    expect(() => Object.assign(copyKey, { id: 8 })).toThrow(TypeError);
    expect(() => Object.assign(copyValue, { text: 'overwrite' })).toThrow(TypeError);
    const mutable = snapshot as unknown as Map<object, object>;
    expect(() => mutable.set({}, {})).toThrow(TypeError);
    expect(() => mutable.delete(copyKey)).toThrow(TypeError);
    expect(() => {
      mutable.clear();
    }).toThrow(TypeError);
    expect(() => Map.prototype.set.call(snapshot, {}, {})).toThrow(TypeError);
    snapshot.forEach((_item, _key, owner) => {
      expect(owner).toBe(snapshot);
      expect(() => {
        (owner as unknown as Map<object, object>).clear();
      }).toThrow(TypeError);
    });
    expect(snapshot.valueOf()).toBe(snapshot);
  });

  it('Set 的对象值与 forEach 所属集合受保护，保留 thisArg 语义', () => {
    const original = { value: 1 };
    const snapshot = readonlySnapshot(new Set([original]));
    original.value = 9;
    const copied = [...snapshot][0]!;
    expect(copied.value).toBe(1);
    expect(() => Object.assign(copied, { value: 9 })).toThrow(TypeError);
    const mutable = snapshot as unknown as Set<object>;
    for (const mutation of [
      () => mutable.add({}),
      () => mutable.delete(copied),
      () => {
        mutable.clear();
      },
    ])
      expect(mutation).toThrow(TypeError);
    expect(() => Set.prototype.add.call(snapshot, {})).toThrow(TypeError);
    const receiver = { marker: true };
    snapshot.forEach(function (this: unknown, value, key, owner) {
      expect(this).toBe(receiver);
      expect(value).toBe(key);
      expect(owner).toBe(snapshot);
    }, receiver);
  });

  it.each([
    ['Uint8Array', () => new Uint8Array([1, 2, 3])],
    ['Buffer', () => Buffer.from([1, 2, 3])],
  ] as const)('%s 的输入字节、索引、mutator、回调及底层 buffer 均隔离', (_name, create) => {
    const original = create();
    const snapshot = readonlySnapshot(original);
    original.fill(9);
    expect([...snapshot]).toEqual([1, 2, 3]);
    const mutable = snapshot as unknown as Uint8Array;
    expect(() => {
      mutable[0] = 8;
    }).toThrow(TypeError);
    for (const mutation of [
      () => mutable.fill(8),
      () => {
        mutable.set([8]);
      },
      () => mutable.reverse(),
      () => mutable.sort(),
      () => mutable.copyWithin(1, 0),
    ])
      expect(mutation).toThrow(TypeError);
    expect(() => Uint8Array.prototype.fill.call(snapshot, 8)).toThrow(TypeError);
    const buffer = snapshot.buffer;
    new Uint8Array(buffer)[0] = 8;
    snapshot.forEach((_value, _index, array) => {
      array[0] = 8;
    });
    snapshot.map((_value, _index, array) => {
      array[0] = 8;
      return 0;
    });
    expect([...snapshot]).toEqual([1, 2, 3]);
    expect(snapshot.valueOf()).toBe(snapshot);
  });

  it.each([
    ['Uint8Array', () => new Uint8Array([1, 2, 3, 4])],
    ['Buffer', () => Buffer.from([1, 2, 3, 4])],
  ] as const)('%s 的 slice/subarray 不泄漏父快照目标，派生快照仍只读', (_name, create) => {
    const snapshot = readonlySnapshot(create());
    for (const derived of [snapshot.slice(1, 3), snapshot.subarray(1, 3)]) {
      expect([...derived]).toEqual([2, 3]);
      expect(() => (derived as unknown as Uint8Array).fill(8)).toThrow(TypeError);
      new Uint8Array(derived.buffer).fill(8);
      expect([...derived]).toEqual([2, 3]);
      expect(readonlySnapshot(derived)).toBe(derived);
    }
    expect([...snapshot]).toEqual([1, 2, 3, 4]);
  });

  it('ArrayBuffer 的独立 slice 可读取，派生可写字节不能改变快照或输入', () => {
    const original = new ArrayBuffer(4);
    new Uint8Array(original).set([1, 2, 3, 4]);
    const snapshot = readonlySnapshot(original);
    new Uint8Array(original).fill(9);
    expect(snapshot.byteLength).toBe(4);
    expect([...new Uint8Array(snapshot.slice(0))]).toEqual([1, 2, 3, 4]);
    new Uint8Array(snapshot.slice(0)).fill(8);
    expect([...new Uint8Array(snapshot.slice(0))]).toEqual([1, 2, 3, 4]);
    const mutable = snapshot as unknown as {
      resize(length: number): void;
      transfer(): ArrayBuffer;
    };
    expect(() => {
      mutable.resize(0);
    }).toThrow(TypeError);
    expect(() => mutable.transfer()).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(snapshot, {})).toThrow(TypeError);
    expect(snapshot.valueOf()).toBe(snapshot);
    expect(readonlySnapshot(snapshot)).toBe(snapshot);
  });

  it('DataView 的读取保留所选字节，set* 与底层 buffer 都不能改写快照', () => {
    const original = new ArrayBuffer(6);
    new Uint8Array(original).set([0, 1, 2, 3, 4, 0]);
    const view = new DataView(original, 1, 4);
    const snapshot = readonlySnapshot(view);
    view.setUint8(0, 9);
    expect(snapshot.byteLength).toBe(4);
    expect(snapshot.getUint8(0)).toBe(1);
    expect(snapshot.getUint16(1)).toBe(0x0203);
    expect(() => {
      (snapshot as unknown as DataView).setUint8(0, 8);
    }).toThrow(TypeError);
    expect(() => {
      DataView.prototype.setUint8.call(snapshot, 0, 8);
    }).toThrow(TypeError);
    new Uint8Array(snapshot.buffer).fill(8);
    expect(snapshot.getUint8(0)).toBe(1);
    expect(snapshot.valueOf()).toBe(snapshot);
    expect(readonlySnapshot(snapshot)).toBe(snapshot);
  });

  it('Date 的时间与原型都不能改写，输入后续变更不影响来源时间', () => {
    const original = new Date('2026-11-03T00:00:00.000Z');
    const snapshot = readonlySnapshot(original);
    original.setTime(0);
    expect(snapshot.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(() => (snapshot as unknown as Date).setTime(1)).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(snapshot, { getTime: () => 7 })).toThrow(TypeError);
    expect(snapshot.getTime()).toBe(Date.parse('2026-11-03T00:00:00.000Z'));
  });

  it('循环对象、Map 和 Set 保留内部身份，已创建快照可以再次使用', () => {
    interface Graph {
      self?: Graph;
      map: Map<string, Graph>;
      set: Set<Graph>;
    }
    const graph: Graph = { map: new Map(), set: new Set() };
    graph.self = graph;
    graph.map.set('root', graph);
    graph.set.add(graph);
    const snapshot = readonlySnapshot(graph);
    expect(snapshot.self).toBe(snapshot);
    expect(snapshot.map.get('root')).toBe(snapshot);
    expect([...snapshot.set][0]).toBe(snapshot);
    const reused = readonlySnapshot(snapshot);
    expect(reused.self).toBe(reused);
    expect(reused.map.get('root')).toBe(reused);
    expect([...reused.set][0]).toBe(reused);
  });

  it('字节、ArrayBuffer、DataView 与 Date 的共享引用在 Map 键中保持一致', () => {
    const bytes = new Uint8Array([1, 2]);
    const buffer = new ArrayBuffer(2);
    const view = new DataView(buffer);
    const date = new Date(100);
    const snapshot = readonlySnapshot({
      bytes,
      buffer,
      view,
      date,
      map: new Map<object, string>([
        [bytes, 'bytes'],
        [buffer, 'buffer'],
        [view, 'view'],
        [date, 'date'],
      ]),
    });
    expect(snapshot.map.get(snapshot.bytes)).toBe('bytes');
    expect(snapshot.map.get(snapshot.buffer)).toBe('buffer');
    expect(snapshot.map.get(snapshot.view)).toBe('view');
    expect(snapshot.map.get(snapshot.date)).toBe('date');
  });

  it('特殊键作为原始数据保留，不改写快照原型', () => {
    const input = JSON.parse('{"__proto__":{"value":1},"constructor":{"value":2}}') as Record<
      string,
      { value: number }
    >;
    const snapshot = readonlySnapshot(input);
    expect(Object.hasOwn(snapshot, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(snapshot['__proto__']!.value).toBe(1);
    expect(snapshot['constructor']!.value).toBe(2);
    expect(() => Object.assign(snapshot['__proto__']!, { value: 9 })).toThrow(TypeError);
  });
});
