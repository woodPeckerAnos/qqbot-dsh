import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 通用版本化 JSON 存储，只负责读写值，不自行判定执行或投递的恢复状态。
 * 同步写临时文件再原子 rename，调用方在落盘成功后才能发布状态或发起发送。
 * 未传路径时作为内存验收接缝；格式错误向上抛出，避免静默丢失持久记录。
 */
export class TaskStore<T> {
  constructor(private readonly file?: string) {}
  load(): T[] {
    if (!this.file || !existsSync(this.file)) return [];
    const data = JSON.parse(readFileSync(this.file, 'utf8')) as { version: number; records: T[] };
    if (data.version !== 1 || !Array.isArray(data.records))
      throw new Error(`无法读取持久化记录：${this.file}`);
    return data.records;
  }
  save(records: readonly T[]): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, records }) + '\n');
    renameSync(temp, this.file);
  }
}

/** Composition issues a writer for one persistent state namespace. */
export function createStateWriter<
  T,
  D extends import('@qqbot/contracts').StateDomain = import('@qqbot/contracts').StateDomain,
>(domain: D, file?: string): import('@qqbot/contracts').StateWriter<T> & { readonly domain: D } {
  const store = new TaskStore<T>(file);
  return Object.freeze({
    domain,
    load: () => store.load(),
    save: (records: readonly T[]) => {
      store.save(records);
    },
  });
}
