/** Deep snapshots isolate references as well as removing write capabilities. */
export type ReadonlyBytes = Omit<Readonly<Uint8Array>, 'set' | 'fill' | 'copyWithin' | 'reverse' | 'sort' | 'slice' | 'subarray'> & {
    slice(start?: number, end?: number): ReadonlyBytes;
    subarray(start?: number, end?: number): ReadonlyBytes;
};
export type ReadonlyDataView = Omit<Readonly<DataView>, `set${string}`>;
export type ReadonlyArrayBuffer = Omit<Readonly<ArrayBuffer>, 'resize' | 'transfer' | 'transferToFixedLength'>;
export type ReadonlyDate = Omit<Readonly<Date>, `set${string}`>;
export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends Date ? ReadonlyDate : T extends DataView ? ReadonlyDataView : T extends ArrayBuffer ? ReadonlyArrayBuffer : T extends Uint8Array ? ReadonlyBytes : T extends Map<infer K, infer V> ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>> : T extends Set<infer V> ? ReadonlySet<DeepReadonly<V>> : T extends readonly (infer V)[] ? readonly DeepReadonly<V>[] : T extends object ? {
    readonly [K in keyof T]: DeepReadonly<T[K]>;
} : T;
export declare function readonlySnapshot<T>(value: T): DeepReadonly<T>;
/** Canonical constant values are deeply immutable; type compatibility stays additive. */
export declare function immutableConstant<T>(value: T): T;
