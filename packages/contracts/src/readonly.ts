/** Deep snapshots isolate references as well as removing write capabilities. */
export type ReadonlyBytes = Omit<
  Readonly<Uint8Array>,
  'set' | 'fill' | 'copyWithin' | 'reverse' | 'sort' | 'slice' | 'subarray'
> & {
  slice(start?: number, end?: number): ReadonlyBytes;
  subarray(start?: number, end?: number): ReadonlyBytes;
};
export type ReadonlyDataView = Omit<Readonly<DataView>, `set${string}`>;
export type ReadonlyArrayBuffer = Omit<
  Readonly<ArrayBuffer>,
  'resize' | 'transfer' | 'transferToFixedLength'
>;
export type ReadonlyDate = Omit<Readonly<Date>, `set${string}`>;
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends Date
    ? ReadonlyDate
    : T extends DataView
      ? ReadonlyDataView
      : T extends ArrayBuffer
        ? ReadonlyArrayBuffer
        : T extends Uint8Array
          ? ReadonlyBytes
          : T extends Map<infer K, infer V>
            ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
            : T extends Set<infer V>
              ? ReadonlySet<DeepReadonly<V>>
              : T extends readonly (infer V)[]
                ? readonly DeepReadonly<V>[]
                : T extends object
                  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
                  : T;

const denied = (): never => {
  throw new TypeError('Snapshot is read-only');
};
const immutableProxies = new WeakSet<object>();
const mutations = new Set([
  'set',
  'add',
  'delete',
  'clear',
  'fill',
  'copyWithin',
  'reverse',
  'sort',
]);

function readonlyCollection(target: Map<unknown, unknown> | Set<unknown>): object {
  const proxy = new Proxy(target, {
    set: denied,
    defineProperty: denied,
    deleteProperty: denied,
    setPrototypeOf: denied,
    get(collection, key) {
      if (typeof key === 'string' && mutations.has(key)) return denied;
      if (key === 'constructor') return Reflect.get(collection, key, collection) as unknown;
      if (key === 'valueOf') return () => proxy;
      if (key === 'forEach')
        return (fn: (value: unknown, key: unknown, owner: object) => void, thisArg?: unknown) => {
          collection.forEach((value, entryKey) => {
            Reflect.apply(fn, thisArg, [value, entryKey, proxy]);
          });
        };
      const member: unknown = Reflect.get(collection, key, collection);
      return typeof member === 'function'
        ? (...args: unknown[]) => Reflect.apply(member, collection, args) as unknown
        : member;
    },
  });
  immutableProxies.add(proxy);
  return proxy;
}

function byteMember(bytes: Uint8Array, key: PropertyKey, proxy: object): unknown {
  if (typeof key === 'string' && mutations.has(key)) return denied;
  if (key === 'buffer') return bytes.buffer.slice(0);
  if (key === 'valueOf') return () => proxy;
  if (key === 'subarray' || key === 'slice')
    return (start?: number, end?: number) => readonlyBytes(bytes.slice(start, end));
  const member: unknown = Reflect.get(bytes, key, bytes);
  if (typeof member !== 'function') return member;
  // Methods execute against a copy: callback arguments cannot expose the owned bytes.
  return (...args: unknown[]) => Reflect.apply(member, bytes.slice(), args) as unknown;
}

function readonlyBytes(bytes: Uint8Array): object {
  const proxy = new Proxy(bytes, {
    set: denied,
    defineProperty: denied,
    deleteProperty: denied,
    setPrototypeOf: denied,
    get: (target, key) => byteMember(target, key, proxy),
  });
  immutableProxies.add(proxy);
  return proxy;
}

function snapshotObject(value: object, seen: WeakMap<object, unknown>): unknown {
  if (immutableProxies.has(value)) return value;
  if (seen.has(value)) return seen.get(value);
  const special = snapshotSpecial(value);
  if (special !== undefined) {
    seen.set(value, special);
    return special;
  }
  if (value instanceof Map || value instanceof Set) return snapshotCollection(value, seen);
  return snapshotRecord(value, seen);
}

function readonlyDate(value: Date): object {
  const target = new Date(value.getTime());
  const proxy = new Proxy(target, {
    set: denied,
    defineProperty: denied,
    deleteProperty: denied,
    setPrototypeOf: denied,
    get(date, key) {
      if (typeof key === 'string' && key.startsWith('set')) return denied;
      const member: unknown = Reflect.get(date, key, date);
      return typeof member === 'function'
        ? (...args: unknown[]) => Reflect.apply(member, new Date(date.getTime()), args) as unknown
        : member;
    },
  });
  immutableProxies.add(proxy);
  return proxy;
}

function snapshotCollection(
  value: Map<unknown, unknown> | Set<unknown>,
  seen: WeakMap<object, unknown>
): object {
  const result = value instanceof Map ? new Map<unknown, unknown>() : new Set<unknown>();
  const proxy = readonlyCollection(result);
  seen.set(value, proxy);
  if (value instanceof Map && result instanceof Map) {
    value.forEach((item, key) => {
      result.set(snapshotValue(key, seen), snapshotValue(item, seen));
    });
  } else if (value instanceof Set && result instanceof Set) {
    value.forEach((item) => {
      result.add(snapshotValue(item, seen));
    });
  }
  return proxy;
}

function snapshotRecord(value: object, seen: WeakMap<object, unknown>): object {
  const result = (Array.isArray(value) ? new Array<unknown>(value.length) : {}) as Record<
    PropertyKey,
    unknown
  >;
  seen.set(value, result);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length' && Array.isArray(value)) continue;
    Object.defineProperty(result, key, {
      value: snapshotValue(Reflect.get(value, key), seen),
      enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable ?? true,
    });
  }
  immutableProxies.add(result);
  return Object.freeze(result);
}

function snapshotValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  return value !== null && typeof value === 'object' ? snapshotObject(value, seen) : value;
}

export function readonlySnapshot<T>(value: T): DeepReadonly<T> {
  return snapshotValue(value, new WeakMap()) as DeepReadonly<T>;
}

function readonlyBuffer(value: ArrayBuffer): object {
  const target = value.slice(0);
  const proxy = new Proxy(target, {
    set: denied,
    defineProperty: denied,
    deleteProperty: denied,
    setPrototypeOf: denied,
    get(buffer, key) {
      if (['resize', 'transfer', 'transferToFixedLength'].includes(String(key))) return denied;
      if (key === 'valueOf') return () => proxy;
      const member: unknown = Reflect.get(buffer, key, buffer);
      return typeof member === 'function'
        ? (...args: unknown[]) => Reflect.apply(member, buffer.slice(0), args) as unknown
        : member;
    },
  });
  immutableProxies.add(proxy);
  return proxy;
}

function readonlyView(value: DataView): object {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  const target = new DataView(bytes.buffer);
  const proxy = new Proxy(target, {
    set: denied,
    defineProperty: denied,
    deleteProperty: denied,
    setPrototypeOf: denied,
    get(view, key) {
      if (typeof key === 'string' && key.startsWith('set')) return denied;
      if (key === 'buffer') return bytes.buffer.slice(0);
      if (key === 'valueOf') return () => proxy;
      const member: unknown = Reflect.get(view, key, view);
      return typeof member === 'function'
        ? (...args: unknown[]) =>
            Reflect.apply(member, new DataView(bytes.buffer.slice(0)), args) as unknown
        : member;
    },
  });
  immutableProxies.add(proxy);
  return proxy;
}

/** Canonical constant values are deeply immutable; type compatibility stays additive. */
export function immutableConstant<T>(value: T): T {
  return snapshotValue(value, new WeakMap()) as T;
}

function snapshotSpecial(value: object): object | undefined {
  if (value instanceof Uint8Array) return readonlyBytes(new Uint8Array(value));
  if (value instanceof ArrayBuffer) return readonlyBuffer(value);
  if (value instanceof DataView) return readonlyView(value);
  if (value instanceof Date) return readonlyDate(value);
  return undefined;
}
