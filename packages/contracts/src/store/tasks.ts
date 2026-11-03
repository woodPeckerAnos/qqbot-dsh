export interface TaskStore<T> {
  load(): T[];
  save(records: readonly T[]): void;
}
export type createStateWriter = <
  T,
  D extends import('../errors.js').StateDomain = import('../errors.js').StateDomain,
>(
  domain: D,
  file?: string
) => import('../errors.js').StateWriter<T> & {
  readonly domain: D;
};
