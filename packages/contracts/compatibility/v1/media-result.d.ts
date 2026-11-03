import type { MediaBytes, MediaFetchOptions, RemoteMedia } from './core/connector.js';
import type { ContractFailure } from './errors.js';
import type { Logger } from './logger.js';
import type { TaskClock } from './task/clock.js';
export declare const MEDIA_FAILURE_CODES: {
    readonly 'invalid-options': "INVALID_INPUT";
    readonly 'missing-source': "NOT_FOUND";
    readonly 'unsupported-source': "INVALID_INPUT";
    readonly 'upstream-http': "UPSTREAM_FAILED";
    readonly 'upstream-failed': "UPSTREAM_FAILED";
    readonly timeout: "TIMEOUT";
    readonly 'missing-result': "UPSTREAM_FAILED";
    readonly 'invalid-result': "UPSTREAM_FAILED";
    readonly 'byte-limit': "INVALID_INPUT";
};
export type MediaFailureReason = keyof typeof MEDIA_FAILURE_CODES;
export type MediaFetchSource = 'network' | 'legacy' | 'typed';
/** Stable error details distinguish a failed read from absence or an unsupported source. */
export interface MediaFetchFailure extends ContractFailure {
    readonly reason: MediaFailureReason;
    readonly source: MediaFetchSource;
    readonly httpStatus?: number;
    readonly maxBytes?: number;
    readonly actualBytes?: number;
}
/** Structurally compatible with Result<MediaBytes>; downloaded bytes belong to the caller. */
export type MediaFetchResult = {
    readonly ok: true;
    readonly value: MediaBytes;
} | {
    readonly ok: false;
    readonly error: MediaFetchFailure;
};
export type LegacyMediaFetcher = (media: RemoteMedia, options: MediaFetchOptions) => Promise<MediaBytes | undefined>;
export type MediaResultFetcher = (media: RemoteMedia, options: MediaFetchOptions, signal: AbortSignal) => Promise<MediaFetchResult>;
export interface MediaFetchDependencies {
    /** Explicit typed source wins over the compatibility source. */
    fetchResult?: MediaResultFetcher;
    fetchMedia?: LegacyMediaFetcher;
    /** HTTP GET capability; protocol allowlist and byte/timeout limits remain in the module. */
    fetchImpl?: typeof fetch;
    logger?: Logger;
    clock?: TaskClock;
}
/** One attempt, bounded bytes and time; no implicit retry. Late results are ignored. */
export type fetchMediaResult = (media: RemoteMedia, options: MediaFetchOptions, dependencies?: MediaFetchDependencies) => Promise<MediaFetchResult>;
