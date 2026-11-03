import type { LogCategory } from './events.js';
export interface LogTransport {
    /** line 包含换行；false 表示等待 drain，done 表示这条写入已完成。 */
    write(line: string, done: (error?: Error | null) => void): boolean;
    on?(event: 'drain' | 'error', listener: (error?: Error) => void): unknown;
}
export interface LogBuffer {
    queuedBytes: number;
    sinkFailures: number;
    emitted: number;
    enqueue(line: string, diagnostic: boolean, category: LogCategory, limit: number): void;
    trim(limit: number): void;
}
export type createLogBufferFactory = (sink: LogTransport, dropped: (category: LogCategory) => void) => LogBuffer;
export type stderrTransport = () => LogTransport;
